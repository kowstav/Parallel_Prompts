// background/service-worker.js
// Parallel Prompts orchestrator. Manages jobs and workers, drives content scripts
// inside LLM tabs.
//
// Distribution modes:
//   - 'single'     : one tab, sequential rows
//   - 'parallel'   : N tabs of the same LLM, rows split between them
//   - 'per-row'    : the CSV's model column tells us which LLM per row.
//                    sub-mode unique-combo : one tab per unique (llm, model, thinking) combo
//                    sub-mode per-row-tab : one tab per CSV row (opens new chats between rows)
//
// Tabs can be:
//   - newly opened by us
//   - existing tabs the user picked from the "use open tabs" picker

importScripts("../lib/papaparse.min.js", "../shared/llms.js");

const STORAGE_KEY      = "pp.jobs.v2";
const CLOUD_CRED_KEY   = "pp.cloud.creds.v1";   // (#6) cloud provider creds
const SCHEDULE_KEY     = "pp.schedules.v1";     // (#8) scheduled job runs
const { LLMS } = self.PP_LLMS;

let jobs = {};
let workerLoops = {};

async function saveJobs() { await chrome.storage.local.set({ [STORAGE_KEY]: jobs }); }
async function loadJobs() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  if (data[STORAGE_KEY]) {
    jobs = data[STORAGE_KEY];
    for (const job of Object.values(jobs)) {
      if (job.status === "running") job.status = "paused";
      for (const w of Object.values(job.workers || {})) {
        if (w.status === "running") w.status = "paused";
      }
    }
  }
}
loadJobs();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function genId(p = "id") { return p + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8); }
function notifyAll() { chrome.runtime.sendMessage({ type: "JOBS_UPDATED", jobs }).catch(() => {}); }

async function tabExists(tabId) {
  try { await chrome.tabs.get(tabId); return true; } catch { return false; }
}

// ---------- (#3) Background-tab keepalive ports ----------
// Content scripts open a long-lived chrome.runtime.connect({ name: "PP_KEEPALIVE" })
// channel when they begin processing prompts. The SW pumps a tick down it every
// 250ms so the content script's event loop stays warm even when its tab is in
// the background. Without this, Chrome clamps setTimeout to ~1Hz after a few
// seconds and the polling loops in content.js slow to a crawl.
const __keepalivePorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "PP_KEEPALIVE") return;
  __keepalivePorts.add(port);
  port.onDisconnect.addListener(() => __keepalivePorts.delete(port));
});
// Ticker — we only fire it while at least one job is running (cheap otherwise).
setInterval(() => {
  if (!Object.values(jobs).some((j) => j.status === "running")) return;
  for (const p of __keepalivePorts) {
    try { p.postMessage({ t: Date.now() }); } catch {}
  }
}, 250);

// ---------- LLM URL building ----------
const NEW_CHAT_URLS = {
  chatgpt: () => "https://chatgpt.com/",
  claude: () => "https://claude.ai/new",
  gemini: ({ userNumber } = {}) =>
    userNumber !== undefined && userNumber !== null && userNumber !== ""
      ? `https://gemini.google.com/u/${userNumber}/app`
      : "https://gemini.google.com/app",
  aistudio: ({ userNumber, modelSlug } = {}) => {
    const u = (userNumber !== undefined && userNumber !== null && userNumber !== "") ? userNumber : 1;
    const base = `https://aistudio.google.com/u/${u}/prompts/new_chat`;
    return modelSlug ? `${base}?model=${encodeURIComponent(modelSlug)}` : base;
  },
  deepseek: () => "https://chat.deepseek.com/",
  qwen: () => "https://chat.qwen.ai/",
  perplexity: () => "https://www.perplexity.ai/",
  copilot: () => "https://copilot.microsoft.com/",
  grok: () => "https://grok.com/",
};

function resolveModelSlug(llm, modelIndex) {
  const cfg = LLMS[llm];
  if (!cfg || !modelIndex || modelIndex < 1) return null;
  const m = cfg.models?.[modelIndex];
  return m?.slug || null;
}

function buildLlmUrl(llm, opts = {}) {
  const fn = NEW_CHAT_URLS[llm];
  if (!fn) return null;
  const modelSlug = resolveModelSlug(llm, opts.modelIndex);
  return fn({ ...opts, modelSlug });
}

function detectLLMFromUrl(url) {
  if (!url) return null;
  if (url.includes("chatgpt.com") || url.includes("chat.openai.com")) return "chatgpt";
  if (url.includes("claude.ai")) return "claude";
  if (url.includes("aistudio.google.com")) return "aistudio";
  if (url.includes("gemini.google.com")) return "gemini";
  if (url.includes("chat.deepseek.com")) return "deepseek";
  if (url.includes("chat.qwen.ai") || url.includes("chat.qwenlm.ai")) return "qwen";
  if (url.includes("perplexity.ai")) return "perplexity";
  if (url.includes("copilot.microsoft.com")) return "copilot";
  if (url.includes("grok.com")) return "grok";
  return null;
}

// ---------- Content-script injection helpers ----------
async function ensureContentScriptInjected(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (resp?.ok) return true;
  } catch (e) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/content.js"],
    });
    await sleep(500);
    return true;
  } catch (e) {
    console.warn("Failed to inject content script into tab", tabId, e);
    return false;
  }
}

async function openTab(llm, opts = {}) {
  const url = buildLlmUrl(llm, opts);
  if (!url) throw new Error("Unknown LLM: " + llm);
  const tab = await chrome.tabs.create({ url, active: false });
  await waitForTabLoad(tab.id, 20000);
  await ensureContentScriptInjected(tab.id);
  return tab.id;
}

async function navigateTab(tabId, llm, opts = {}) {
  const url = buildLlmUrl(llm, opts);
  if (!url) throw new Error("Unknown LLM: " + llm);
  await chrome.tabs.update(tabId, { url });
  await waitForTabLoad(tabId, 20000);
  await ensureContentScriptInjected(tabId);
}

// (#2) Reload a worker tab in-place (same URL) and re-inject content script.
async function reloadWorkerTab(tabId) {
  await chrome.tabs.reload(tabId, { bypassCache: false });
  await waitForTabLoad(tabId, 20000);
  await ensureContentScriptInjected(tabId);
}

function waitForTabLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    const timer = setTimeout(finish, timeoutMs);
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") { clearTimeout(timer); finish(); }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (t) => {
      if (t && t.status === "complete") { clearTimeout(timer); finish(); }
    });
  });
}

// ---------- Job creation ----------
async function createJob(payload) {
  const id = genId("job");
  const {
    name, csv, skipped = [], distribution,
    parallelCount = 1,
    primaryLlm, primaryModelIndex, primaryThinking,
    geminiUserNumber, optionalPrompt = { mode: "none", text: "" },
    perRowNewChat = false,
    parallelNewChat = false,
    singleNewChat = false,
    existingTabIds = null,
    rowFromIndex = 0,
    rowToIndex = null,
    codeExec = null,
    schedule = null,        // (#8) optional scheduling spec
    settings = {},
  } = payload;

  const responseColumn = payload.responseColumn || "response";
  if (!csv.headers.includes(responseColumn)) csv.headers.push(responseColumn);

  if (codeExec?.executeCode) {
    const cols = ["codeColumn", "stdoutColumn", "stderrColumn", "execStatusColumn", "answerColumn"];
    for (const k of cols) {
      const col = codeExec[k];
      if (col && !csv.headers.includes(col)) csv.headers.push(col);
    }
  }

  const job = {
    id, name: name || "Untitled job",
    csv, skipped, responseColumn,
    distribution, parallelCount,
    primaryLlm, primaryModelIndex: primaryModelIndex || 0, primaryThinking: !!primaryThinking,
    geminiUserNumber, optionalPrompt,
    perRowNewChat, parallelNewChat, singleNewChat,
    existingTabIds,
    rowFromIndex, rowToIndex,
    codeExec: codeExec ? {
      executeCode: !!codeExec.executeCode,
      autoRepair: !!codeExec.autoRepair,
      maxRepairLoops: codeExec.maxRepairLoops ?? 5,
      codeTimeoutS: codeExec.codeTimeoutS ?? 30,
      packages: codeExec.packages || "",
      validator: codeExec.validator || { mode: "none" },
      codeColumn: codeExec.codeColumn || "",
      stdoutColumn: codeExec.stdoutColumn || "",
      stderrColumn: codeExec.stderrColumn || "",
      execStatusColumn: codeExec.execStatusColumn || "",
      // (#11) optional scaffold/template for the LLM's code response
      codeTemplate: codeExec.codeTemplate || "",
      // (#12) custom answer extractor — special tokens (<bbox>, <json>, <number>,
      //       <final>) or any regex; column it gets written to.
      answerExtractor: codeExec.answerExtractor || "",
      answerColumn: codeExec.answerColumn || "",
      runtime: codeExec.runtime || "pyodide",
    } : {
      // No full code-exec setup, but the user might still want answer extraction.
      // We carry just enough state so the per-row answer-extract block fires.
      executeCode: false,
      autoRepair: false,
      codeTemplate: "",
      answerExtractor: "",
      answerColumn: "",
    },
    settings: {
      delayBetweenPromptsMs: settings.delayBetweenPromptsMs ?? 3000,
      perResponseTimeoutMs: settings.perResponseTimeoutMs ?? 240000,
      retryOnError: settings.retryOnError ?? true,
      overwrite: settings.overwrite ?? false,
      onInterruptResume: settings.onInterruptResume ?? "resume",
      autoContinueClaude: settings.autoContinueClaude ?? true,
      maxContinues: settings.maxContinues ?? 5,
      // (#2) per-row retry budget. 0 = no retry, 3 = up to 3 reloads & retry.
      maxRowRetries: settings.maxRowRetries ?? 3,
    },
    schedule: schedule || null,   // {kind: 'immediate'|'at'|'reset', at: timestamp, tz: '...'}
    status: "idle", error: null,
    createdAt: Date.now(),
    workers: {}, rowState: {}, totalRows: csv.rows.length,
    runMode: "foreground",   // (#7) 'foreground' | 'background'
  };

  const skipSet = new Set(skipped);
  for (let i = 0; i < csv.rows.length; i++) {
    if (skipSet.has(i)) {
      job.rowState[i] = { status: "skipped" };
    } else if (i < rowFromIndex || (rowToIndex !== null && rowToIndex !== undefined && i > rowToIndex)) {
      job.rowState[i] = { status: "skipped" };
    } else if (csv.rows[i][responseColumn] && !job.settings.overwrite) {
      job.rowState[i] = { status: "done" };
    } else {
      job.rowState[i] = { status: "pending", attempts: 0, partialText: "", retries: 0 };
    }
  }

  jobs[id] = job;
  await saveJobs(); notifyAll();
  return job;
}

// ---------- Worker setup ----------
async function setupWorkers(jobId) {
  const job = jobs[jobId];
  if (!job) return;
  job.workers = {};

  if (job.distribution === "single") {
    const wid = genId("w");
    let tabId;
    if (job.existingTabIds?.primary) {
      tabId = job.existingTabIds.primary;
      await ensureContentScriptInjected(tabId);
    } else {
      tabId = await openTab(job.primaryLlm, { userNumber: job.geminiUserNumber, modelIndex: job.primaryModelIndex });
    }
    job.workers[wid] = mkWorker({
      id: wid, llm: job.primaryLlm, modelIndex: job.primaryModelIndex,
      thinking: job.primaryThinking, tabId, filter: null,
      newChatPerRow: job.singleNewChat,
    });
  }

  else if (job.distribution === "parallel") {
    const n = Math.max(1, Math.min(job.parallelCount, 12));
    for (let i = 0; i < n; i++) {
      const wid = genId("w");
      let tabId;
      const existingKey = `parallel_${i}`;
      if (job.existingTabIds?.[existingKey]) {
        tabId = job.existingTabIds[existingKey];
        await ensureContentScriptInjected(tabId);
      } else {
        tabId = await openTab(job.primaryLlm, { userNumber: job.geminiUserNumber, modelIndex: job.primaryModelIndex });
      }
      job.workers[wid] = mkWorker({
        id: wid, llm: job.primaryLlm, modelIndex: job.primaryModelIndex,
        thinking: job.primaryThinking, tabId, filter: null,
        newChatPerRow: job.parallelNewChat,
      });
    }
  }

  else if (job.distribution === "per-row") {
    const col = job.csv.modelColumn;
    if (!col) throw new Error("Per-row mode requires a model column");

    if (job.perRowNewChat) {
      const llms = new Set();
      for (let i = 0; i < job.csv.rows.length; i++) {
        if (job.rowState[i].status !== "pending") continue;
        const parsed = parseModelCell(String(job.csv.rows[i][col] || ""));
        if (parsed) llms.add(parsed.llm);
      }
      for (const llm of llms) {
        const wid = genId("w");
        const tabId = await openTab(llm, { userNumber: job.geminiUserNumber });
        job.workers[wid] = mkWorker({
          id: wid, llm, modelIndex: 0, thinking: false, tabId,
          filter: { llm },
          newChatPerRow: true,
        });
      }
    } else {
      const combos = new Map();
      for (let i = 0; i < job.csv.rows.length; i++) {
        if (job.rowState[i].status !== "pending") continue;
        const parsed = parseModelCell(String(job.csv.rows[i][col] || ""));
        if (!parsed) continue;
        const key = `${parsed.llm}|${parsed.modelIndex}|${parsed.thinking}`;
        if (!combos.has(key)) combos.set(key, parsed);
      }
      for (const { llm, modelIndex, thinking } of combos.values()) {
        const wid = genId("w");
        const tabId = await openTab(llm, { userNumber: job.geminiUserNumber, modelIndex });
        job.workers[wid] = mkWorker({
          id: wid, llm, modelIndex, thinking, tabId,
          filter: { llm, modelIndex, thinking },
          newChatPerRow: false,
        });
      }
    }

    if (Object.keys(job.workers).length === 0) {
      throw new Error("No valid LLM/model values found in the model column.");
    }
  }

  await saveJobs(); notifyAll();
}

function mkWorker({ id, llm, modelIndex, thinking, tabId, filter, newChatPerRow }) {
  return {
    id, llm, modelIndex: modelIndex || 0, thinking: !!thinking,
    tabId, status: "idle", currentRow: null, continueCount: 0,
    lastError: null, filter, newChatPerRow: !!newChatPerRow,
    firstMessageSent: false,
  };
}

function parseModelCell(s) {
  const cleaned = s.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();

  let llm = null;
  for (const key of Object.keys(LLMS)) {
    if (new RegExp(`(^|[^a-z])${key}([^a-z]|$)`, "i").test(lower)) { llm = key; break; }
  }
  if (!llm) return null;

  const idxMatch = cleaned.match(/\b([1-6])\b/);
  const modelIndex = idxMatch ? Number(idxMatch[1]) : 0;
  const thinking = /\b(think|thinking|reason|reasoning|deepthink|extended)\b/i.test(cleaned);

  return { llm, modelIndex, thinking };
}

// ---------- Lifecycle ----------
async function startJob(jobId) {
  const job = jobs[jobId];
  if (!job) return;

  // (#8) If the job has a future schedule, register it instead of starting now.
  if (job.schedule && job.schedule.kind && job.schedule.kind !== "immediate") {
    const at = await resolveScheduleAt(job);
    if (at && at > Date.now() + 1000) {
      job.status = "scheduled";
      job.scheduledFor = at;
      await saveJobs(); notifyAll();
      registerScheduleAlarm(jobId, at);
      return;
    }
  }

  if (Object.keys(job.workers).length === 0) {
    try { await setupWorkers(jobId); }
    catch (e) {
      job.status = "error"; job.error = e.message;
      await saveJobs(); notifyAll();
      return;
    }
  }
  for (const w of Object.values(job.workers)) {
    if (!(await tabExists(w.tabId))) {
      try { w.tabId = await openTab(w.llm, { userNumber: job.geminiUserNumber, modelIndex: w.modelIndex }); }
      catch (e) { w.status = "error"; w.lastError = "Could not reopen tab: " + e.message; }
    } else {
      await ensureContentScriptInjected(w.tabId);
    }
  }
  job.status = "running";
  job.error = null;
  await saveJobs(); notifyAll();
  for (const w of Object.values(job.workers)) {
    if (w.status !== "error") runWorkerLoop(jobId, w.id);
  }
}

async function pauseJob(jobId, reason = null) {
  const job = jobs[jobId];
  if (!job) return;
  job.status = "paused";
  if (reason) job.error = reason;
  for (const w of Object.values(job.workers)) {
    if (w.status === "running") w.status = "paused";
  }
  await saveJobs(); notifyAll();
}
async function deleteJob(jobId) { delete jobs[jobId]; await saveJobs(); notifyAll(); }

// ---------- Worker loop ----------
function runWorkerLoop(jobId, workerId) {
  const key = `${jobId}:${workerId}`;
  if (workerLoops[key]) return;
  workerLoops[key] = true;

  (async () => {
    try {
      const job = jobs[jobId];
      const w = job?.workers[workerId];
      if (!job || !w) return;
      w.status = "running";
      await saveJobs(); notifyAll();

      if (job.optionalPrompt?.mode === "first" && job.optionalPrompt.text && !w.firstMessageSent) {
        try {
          await dispatchPrompt(job, w, job.optionalPrompt.text, { isPriming: true });
          w.firstMessageSent = true;
          await saveJobs(); notifyAll();
          await sleep(job.settings.delayBetweenPromptsMs);
        } catch (e) {
          w.lastError = "Priming failed: " + e.message;
          await pauseJob(jobId, `[${w.llm}] priming failed: ${e.message}`);
          return;
        }
      }

      while (job.status === "running" && w.status === "running") {
        const rowIndex = pickNextRow(job, w);
        if (rowIndex === null) {
          w.status = "idle";
          await saveJobs(); notifyAll();
          break;
        }

        let activeModelIndex = w.modelIndex;
        let activeThinking = w.thinking;
        if (job.distribution === "per-row" && job.csv.modelColumn) {
          const parsed = parseModelCell(String(job.csv.rows[rowIndex][job.csv.modelColumn] || ""));
          if (parsed) {
            activeModelIndex = parsed.modelIndex;
            activeThinking = parsed.thinking;
          }
        }

        if (w.newChatPerRow) {
          try { await navigateTab(w.tabId, w.llm, { userNumber: job.geminiUserNumber, modelIndex: activeModelIndex }); }
          catch (e) {
            await handleWorkerFailure(job, w, rowIndex, new Error("New-chat navigation failed: " + e.message));
            if (job.status !== "running" || w.status !== "running") return;
            continue;
          }
        }

        job.rowState[rowIndex].status = "in_progress";
        job.rowState[rowIndex].assignedTo = workerId;
        job.rowState[rowIndex].llm = w.llm;
        job.rowState[rowIndex].modelIndex = activeModelIndex;
        job.rowState[rowIndex].thinking = activeThinking;
        job.rowState[rowIndex].attempts = (job.rowState[rowIndex].attempts || 0) + 1;
        w.currentRow = rowIndex;
        await saveJobs(); notifyAll();

        const prompt = buildPrompt(job, rowIndex);

        // (#1) dispatchPrompt awaits the content-script's full response before
        // returning, so the next loop iteration (next row) cannot start until
        // this one is complete. (#2) If we get an unhealthy result we retry up
        // to maxRowRetries times with a tab reload between attempts.
        let result = null;
        let retryError = null;
        const maxRetries = Math.max(0, job.settings.maxRowRetries || 0);
        for (let retry = 0; retry <= maxRetries; retry++) {
          try {
            result = await dispatchPrompt(job, w, prompt, { rowIndex, modelIndex: activeModelIndex, thinking: activeThinking });
            // Distinguish between recoverable (no response / dispatch error) and
            // non-recoverable (rate_limit, login, model_switch) — only retry the
            // recoverable kind. Empty text + ok kind also counts as recoverable.
            if (result.kind === "ok" && !(result.text && result.text.trim())) {
              retryError = new Error("Empty response from LLM");
              if (retry < maxRetries) {
                job.rowState[rowIndex].retries = (job.rowState[rowIndex].retries || 0) + 1;
                w.lastError = `Empty response — retrying (${retry + 1}/${maxRetries})`;
                await saveJobs(); notifyAll();
                try { await reloadWorkerTab(w.tabId); } catch {}
                await sleep(1500);
                continue;
              }
              // Out of retries — surface as error
              result = { kind: "error", message: "Empty response after " + (maxRetries + 1) + " attempts", text: "", partialText: "" };
              break;
            }
            retryError = null;
            break;
          } catch (e) {
            retryError = e;
            if (retry < maxRetries) {
              job.rowState[rowIndex].retries = (job.rowState[rowIndex].retries || 0) + 1;
              w.lastError = `Retry ${retry + 1}/${maxRetries}: ${e.message || e}`;
              await saveJobs(); notifyAll();
              try { await reloadWorkerTab(w.tabId); } catch {}
              await sleep(1500);
              continue;
            }
            break;
          }
        }
        if (retryError && !result) {
          await handleWorkerFailure(job, w, rowIndex, retryError);
          if (job.status !== "running" || w.status !== "running") return;
          continue;
        }

        try {
          if (result.kind === "rate_limit" || result.kind === "model_switch" || result.kind === "login") {
            job.rowState[rowIndex].partialText = result.partialText || "";
            job.rowState[rowIndex].status = "interrupted";
            if (result.partialText) {
              job.csv.rows[rowIndex][job.responseColumn] = `[INTERRUPTED] ${result.partialText}`;
            }
            w.lastError = result.message;
            // (#8) Capture the LLM's reset time and attach it to the job so the
            // scheduler can auto-resume.
            if (result.resetAt && (!job.schedule || job.schedule.kind === "reset" || job.schedule.kind === "immediate")) {
              job.schedule = { kind: "reset", at: result.resetAt, tz: "auto" };
              job.scheduledFor = result.resetAt;
              registerScheduleAlarm(jobId, result.resetAt);
            }
            await saveJobs(); notifyAll();
            await pauseJob(jobId, `[${w.llm}] ${result.message}`);
            return;
          }

          if (result.kind === "error") {
            await handleWorkerFailure(job, w, rowIndex, new Error(result.message));
            if (job.status !== "running" || w.status !== "running") return;
            continue;
          }

          job.csv.rows[rowIndex][job.responseColumn] = result.text || "";
          job.rowState[rowIndex].status = "done";
          job.rowState[rowIndex].partialText = "";

          // ---- (#12) Optional answer extraction (separate from code) ----
          if (job.codeExec?.answerExtractor && job.codeExec?.answerColumn) {
            const ans = extractAnswer(result.text || "", job.codeExec.answerExtractor);
            job.csv.rows[rowIndex][job.codeExec.answerColumn] = ans || "";
            job.rowState[rowIndex].answer = ans || "";
          }

          // ---- Agent loop: optionally execute extracted Python and repair on failure ----
          if (job.codeExec?.executeCode) {
            try {
              await runAgentLoopForRow(job, w, rowIndex, result.text || "");
              const st = job.rowState[rowIndex];
              if (job.codeExec.codeColumn) job.csv.rows[rowIndex][job.codeExec.codeColumn] = st.code || "";
              if (job.codeExec.stdoutColumn) job.csv.rows[rowIndex][job.codeExec.stdoutColumn] = st.execStdout || "";
              if (job.codeExec.stderrColumn) job.csv.rows[rowIndex][job.codeExec.stderrColumn] = st.execStderr || "";
              if (job.codeExec.execStatusColumn) job.csv.rows[rowIndex][job.codeExec.execStatusColumn] = st.execStatus || "";
            } catch (e) {
              console.error("[agent loop]", e);
              job.rowState[rowIndex].execStderr = (job.rowState[rowIndex].execStderr || "") + "\nAgent loop crashed: " + (e?.message || e);
              job.rowState[rowIndex].execStatus = "bridge_error";
            }
          }

          w.currentRow = null;
          await saveJobs(); notifyAll();
          await sleep(job.settings.delayBetweenPromptsMs);
        } catch (e) {
          await handleWorkerFailure(job, w, rowIndex, e);
          if (job.status !== "running" || w.status !== "running") return;
        }
      }

      maybeFinishJob(jobId);
    } finally {
      workerLoops[key] = false;
    }
  })();
}

async function handleWorkerFailure(job, w, rowIndex, e) {
  console.error("[worker fail]", e);
  w.lastError = e.message || String(e);
  if (rowIndex !== null && rowIndex !== undefined) {
    if (job.settings.retryOnError) {
      job.csv.rows[rowIndex][job.responseColumn] = `[ERROR] ${e.message || e}`;
      job.rowState[rowIndex].status = "failed";
      w.currentRow = null;
      await saveJobs(); notifyAll();
      await sleep(2000);
    } else {
      job.rowState[rowIndex].status = "failed";
      await pauseJob(job.id, `Worker ${w.llm}: ${e.message || e}`);
    }
  } else {
    await pauseJob(job.id, `Worker ${w.llm}: ${e.message || e}`);
  }
}

function pickNextRow(job, w) {
  const filter = w.filter;
  const col = job.csv.modelColumn;
  for (let i = 0; i < job.csv.rows.length; i++) {
    const st = job.rowState[i];
    if (!st) continue;
    if (st.status !== "pending" && st.status !== "interrupted") continue;
    if (st.status === "interrupted") {
      if (job.settings.onInterruptResume === "next") { st.status = "done"; continue; }
    }
    if (filter) {
      const parsed = parseModelCell(String(job.csv.rows[i][col] || ""));
      if (!parsed) continue;
      if (parsed.llm !== filter.llm) continue;
      if (filter.modelIndex !== undefined) {
        if (parsed.modelIndex !== filter.modelIndex) continue;
        if (parsed.thinking !== filter.thinking) continue;
      }
    }
    return i;
  }
  return null;
}

function buildPrompt(job, rowIndex) {
  const promptCol = job.csv.promptColumn || job.csv.headers[0];
  const raw = String(job.csv.rows[rowIndex][promptCol] || "").replace(/\r\n/g, "\n");
  const opt = job.optionalPrompt || {};
  const optText = (opt.text || "").replace(/\r\n/g, "\n");
  if (opt.mode === "prefix" && optText) return optText + "\n\n" + raw;
  if (opt.mode === "suffix" && optText) return raw + "\n\n" + optText;
  return raw;
}

function maybeFinishJob(jobId) {
  const job = jobs[jobId];
  if (!job) return;
  const stillPending = Object.values(job.rowState).some((s) =>
    s.status === "pending" || s.status === "in_progress" || s.status === "interrupted"
  );
  const anyBusy = Object.values(job.workers).some((w) => w.status === "running");
  if (!stillPending && !anyBusy && job.status === "running") {
    job.status = "done";
    saveJobs(); notifyAll();
  }
}

// ---------- Sending to a tab ----------
async function dispatchPrompt(job, w, prompt, ctx = {}) {
  const tabId = w.tabId;
  if (!(await tabExists(tabId))) throw new Error("Tab no longer exists");

  await ensureContentScriptInjected(tabId);

  const message = {
    type: "RUN_PROMPT",
    llm: w.llm,
    modelIndex: ctx.modelIndex !== undefined ? ctx.modelIndex : w.modelIndex,
    thinking: ctx.thinking !== undefined ? ctx.thinking : w.thinking,
    prompt,
    autoContinue: w.llm === "claude" ? job.settings.autoContinueClaude : false,
    maxContinues: job.settings.maxContinues,
    isPriming: !!ctx.isPriming,
  };

  const timeoutMs = job.settings.perResponseTimeoutMs + 30000;

  return await new Promise(async (resolve, reject) => {
    let timer = setTimeout(() => reject(new Error("Response timeout (" + Math.round(timeoutMs / 1000) + "s)")), timeoutMs);

    try {
      const resp = await chrome.tabs.sendMessage(tabId, message);
      clearTimeout(timer);
      if (!resp) {
        return reject(new Error("Content script returned no response — page may have been navigated/reloaded."));
      }
      resolve({
        kind: resp.kind || (resp.ok ? "ok" : "error"),
        text: resp.text || "",
        partialText: resp.partialText || "",
        message: resp.message || "",
        resetAt: resp.resetAt || null,
      });
    } catch (e) {
      clearTimeout(timer);
      reject(new Error("Could not reach content script: " + (e?.message || String(e))));
    }
  });
}

// ---------- Python execution proxy ----------

async function executePythonNative({ code, timeoutMs }) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative("io.parallelprompts.helper");
    } catch(e) {
      return resolve({ ok: false, error: "Native helper not installed or disabled." });
    }

    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        port.disconnect();
        resolve({ ok: false, error: `Native timeout ${Math.round(timeoutMs/1000)}s exceeded`, timedOut: true });
      }
    }, timeoutMs + 2000);

    port.onMessage.addListener((m) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      port.disconnect();
      resolve({
        ok: !!m.ok,
        stdout: m.stdout || "",
        stderr: m.stderr || "",
        error: m.error || null,
        files: m.files || [],          // (#5) files written by the script
        timedOut: !!(m.error && m.error.toLowerCase().includes("timeout"))
      });
    });

    port.onDisconnect.addListener(() => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ ok: false, error: chrome.runtime.lastError?.message || "Helper disconnected unexpectedly." });
    });

    port.postMessage({ type: "execute_python", code, timeout: Math.round(timeoutMs / 1000) });
  });
}

async function executePythonViaDashboard({ code, packages = [], timeoutMs = 30000 }) {
  const dashUrl = chrome.runtime.getURL("dashboard/dashboard.html");
  const tabs = await chrome.tabs.query({ url: dashUrl + "*" });
  const tab = tabs[0] || null;

  if (!tab) return { ok: false, error: "No dashboard tab open. Open Code Lab first to bootstrap Pyodide." };

  try {
    const r = await chrome.tabs.sendMessage(tab.id, {
      type: "PYRUN_PROXY", code, packages, timeoutMs, freshNamespace: true,
    });
    return r || { ok: false, error: "No response from dashboard" };
  } catch (e) {
    return { ok: false, error: "Dashboard message failed: " + (e?.message || e) };
  }
}

async function validateNative({ validatorCode, stdout, stderr, timeoutMs = 10000 }) {
  const safeStdout = JSON.stringify(JSON.stringify(stdout));
  const safeStderr = JSON.stringify(JSON.stringify(stderr));

  const cleanScript = `
import json
stdout = json.loads(${safeStdout})
stderr = json.loads(${safeStderr})

${validatorCode}

try:
    res = validate(stdout, stderr, None)
    if res is True or res == "": print("__PASS__")
    else: print(str(res) if res is not False else "FAIL")
except Exception as e:
    print("ERROR: " + str(e))
`;
  const r = await executePythonNative({ code: cleanScript, timeoutMs });
  if (r.stdout && r.stdout.trim() === "__PASS__") return { passed: true, message: "" };
  return { passed: false, message: r.stdout.trim() || r.stderr.trim() || r.error || "Validation failed" };
}

async function validateViaDashboard({ validatorCode, stdout, stderr }) {
  const dashUrl = chrome.runtime.getURL("dashboard/dashboard.html");
  const tabs = await chrome.tabs.query({ url: dashUrl + "*" });
  if (!tabs[0]) return { ok: false, passed: false, message: "No dashboard tab open" };
  try {
    const r = await chrome.tabs.sendMessage(tabs[0].id, {
      type: "PYRUN_VALIDATE_PROXY", validatorCode, stdout, stderr,
    });
    return r || { ok: false, passed: false, message: "No response" };
  } catch (e) {
    return { ok: false, passed: false, message: e?.message || String(e) };
  }
}

// ---------- (#12) Code & answer extraction ----------
// More thorough Python extractor than before. Strategy:
//   1) ```python``` fenced block (first match wins)
//   2) ```py``` / ```python3``` / ```py3``` fenced block
//   3) Any ``` … ``` fenced block whose content looks Python-ish
//   4) <code>…</code> tag
//   5) Indented "looks like a script" heuristic — find the first line that
//      starts with `def `/`import `/`from `/`print(` and grab the rest of the
//      message, trimming trailing prose.
//   6) Whole text fallback (only if it has python keywords).
function extractPythonFromText(text) {
  if (!text) return "";

  const tries = [
    /```python\s*([\s\S]*?)```/i,
    /```py(?:thon)?3?\s*([\s\S]*?)```/i,
    /<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/i,
  ];
  for (const re of tries) {
    const m = text.match(re);
    if (m) {
      const body = (m[1] || "").trim();
      if (body && hasPythonKeywords(body)) return body;
    }
  }

  // Generic ``` … ``` blocks — take the first one that looks like Python.
  const generic = text.match(/```[\w-]*\s*([\s\S]*?)```/g) || [];
  for (const block of generic) {
    const inner = block.replace(/^```[\w-]*\s*/, "").replace(/```$/, "").trim();
    if (inner && hasPythonKeywords(inner)) return inner;
  }

  // Indented script heuristic
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^(\s*)(def |import |from |class |print\(|for |while |if )/.test(lines[i])) {
      // Walk forward as long as lines are plausibly code (not pure prose).
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j];
        if (/^[A-Z][^a-z]{0,20}[a-z]/.test(ln) && /\.\s*$/.test(ln) && !/[():=]/.test(ln)) {
          end = j; break;
        }
      }
      const slice = lines.slice(i, end).join("\n").trim();
      if (slice && hasPythonKeywords(slice)) return slice;
    }
  }

  if (hasPythonKeywords(text)) return text.trim();
  return "";
}

function hasPythonKeywords(s) {
  return /\b(def |import |from |print\(|return |class |for |while |if |elif |else:|with |try:|except|lambda |async )/.test(s);
}

// (#12) User-defined extractor for a value embedded in the LLM's prose.
// `pattern` is a JS regex string (without // delimiters). If it captures group 1,
// that's the answer; otherwise the whole match. Special tokens supported:
//   "<bbox>"     — match bbox-style coordinates "[x1,y1,x2,y2]" or "x1,y1,x2,y2"
//   "<json>"     — match the first JSON object/array
//   "<number>"   — first number in the response
//   "<final>"    — text after "final answer:" / "answer:"  (case-insensitive)
function extractAnswer(text, pattern) {
  if (!text || !pattern) return "";
  const trimmed = String(pattern).trim();

  // Built-ins
  if (trimmed === "<bbox>") {
    const m = text.match(/\[?\s*(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)\s*\]?/);
    return m ? `[${m[1]}, ${m[2]}, ${m[3]}, ${m[4]}]` : "";
  }
  if (trimmed === "<json>") {
    // Find the first balanced {...} or [...]
    for (const opener of ["{", "["]) {
      const i = text.indexOf(opener);
      if (i === -1) continue;
      const closer = opener === "{" ? "}" : "]";
      let depth = 0;
      for (let j = i; j < text.length; j++) {
        if (text[j] === opener) depth++;
        else if (text[j] === closer) {
          depth--;
          if (depth === 0) return text.slice(i, j + 1).trim();
        }
      }
    }
    return "";
  }
  if (trimmed === "<number>") {
    const m = text.match(/-?\d+(?:\.\d+)?/);
    return m ? m[0] : "";
  }
  if (trimmed === "<final>") {
    const m = text.match(/(?:final answer|answer)\s*[:\-]\s*([\s\S]+?)(?:\n\n|$)/i);
    return m ? m[1].trim() : "";
  }

  // Custom regex
  try {
    const re = new RegExp(trimmed, "i");
    const m = text.match(re);
    if (!m) return "";
    return (m[1] || m[0] || "").trim();
  } catch (e) {
    return "";
  }
}

async function runAgentLoopForRow(job, w, rowIndex, llmText) {
  const st = job.rowState[rowIndex];
  st.code = extractPythonFromText(llmText);
  st.repairAttempts = 0;
  st.repairedVersions = [];
  st.execStatus = "skipped";
  st.execStdout = "";
  st.execStderr = "";

  if (!st.code) {
    st.execStatus = "no_code";
    return false;
  }

  const codeOpts = job.codeExec || {};
  const pkgs = (codeOpts.packages || "").split(",").map((s) => s.trim()).filter(Boolean);
  const maxLoops = Math.max(0, codeOpts.maxRepairLoops || 0);
  const timeoutMs = (codeOpts.codeTimeoutS || 30) * 1000;

  // (#11) If a code template is provided, splice the LLM's code into it where
  // [llm_response] (or [llm_code]) appears.
  let currentCode = applyCodeTemplate(codeOpts.codeTemplate, st.code);
  let attempt = 0;

  while (true) {
    attempt++;
    st.repairAttempts = attempt;

    const isNative = job.codeExec?.runtime === "native";
    const execR = isNative
        ? await executePythonNative({ code: currentCode, timeoutMs })
        : await executePythonViaDashboard({ code: currentCode, packages: pkgs, timeoutMs });

    st.execStdout = execR.stdout || "";
    st.execStderr = (execR.error || "") + (execR.stderr ? "\n" + execR.stderr : "");
    if (execR.ok === false && !execR.stdout && !execR.stderr) {
      st.execStatus = "bridge_error";
      st.execStderr = execR.error || "bridge error";
      return false;
    }

    const passed = await applyValidatorForJob(job, execR, isNative);
    if (!execR.error && !execR.timedOut && passed.passed) {
      st.execStatus = "passed";
      st.code = currentCode;
      return true;
    }

    st.execStatus = "failed";
    st.repairedVersions.push({ code: currentCode, error: st.execStderr || "validation failed" });

    if (!codeOpts.autoRepair || attempt > maxLoops) {
      st.code = currentCode;
      return false;
    }

    const feedback = buildRepairPromptText({
      originalPrompt: buildPrompt(job, rowIndex),
      previousCode: currentCode,
      stdout: execR.stdout || "",
      errorOrStderr: st.execStderr,
      validatorMessage: passed.passed ? "" : passed.message,
    });

    let resp;
    try {
      resp = await dispatchPrompt(job, w, feedback, { rowIndex, modelIndex: w.modelIndex, thinking: w.thinking });
    } catch (e) {
      st.execStderr += "\nLLM repair dispatch failed: " + (e?.message || e);
      st.code = currentCode;
      return false;
    }
    if (resp.kind !== "ok") {
      st.execStderr += "\nLLM repair returned " + resp.kind + ": " + (resp.message || "");
      st.code = currentCode;
      return false;
    }
    const nextCode = extractPythonFromText(resp.text || "");
    if (!nextCode) {
      st.execStderr += "\nLLM repair response had no extractable code";
      st.code = currentCode;
      return false;
    }
    currentCode = applyCodeTemplate(codeOpts.codeTemplate, nextCode);
  }
}

// (#11) Splice the LLM's response into a user-supplied template at [llm_response]
// or [llm_code]. If the template is empty or the placeholder isn't present, fall
// back to using the LLM code directly.
function applyCodeTemplate(template, llmCode) {
  if (!template || !template.trim()) return llmCode;
  if (!/\[llm_(response|code)\]/i.test(template)) {
    return llmCode;
  }
  return template.replace(/\[llm_(?:response|code)\]/gi, () => llmCode);
}

async function applyValidatorForJob(job, execR, isNative) {
  const v = job.codeExec?.validator || { mode: "none" };
  if (v.mode === "none") return { passed: true, message: "" };
  if (execR.error || execR.timedOut) return { passed: false, message: "execution error" };

  if (v.mode === "expected") {
    const exp = (v.expected || "").replace(/\r\n/g, "\n").trim();
    const got = (execR.stdout || "").replace(/\r\n/g, "\n").trim();
    return { passed: exp === got, message: exp === got ? "" : "stdout mismatch" };
  }

  if (v.mode === "custom") {
    if (isNative) {
      return await validateNative({ validatorCode: v.code || "", stdout: execR.stdout || "", stderr: execR.stderr || "" });
    } else {
      const r = await validateViaDashboard({ validatorCode: v.code || "", stdout: execR.stdout || "", stderr: execR.stderr || "" });
      return { passed: !!r.passed, message: r.message || "" };
    }
  }
  return { passed: true, message: "" };
}

function buildRepairPromptText({ originalPrompt, previousCode, stdout, errorOrStderr, validatorMessage }) {
  let p = "The previous Python code did not work as expected.\n\n";
  p += "Original task:\n" + originalPrompt + "\n\n";
  p += "Code:\n```python\n" + previousCode + "\n```\n\n";
  if (stdout && stdout.trim()) p += "stdout:\n```\n" + stdout.slice(0, 2000) + "\n```\n\n";
  if (errorOrStderr && errorOrStderr.trim()) p += "error / stderr:\n```\n" + errorOrStderr.slice(0, 2000) + "\n```\n\n";
  if (validatorMessage) p += "Validator: " + validatorMessage + "\n\n";
  p += "Please fix the code and respond with the corrected version inside a single ```python``` code block.";
  return p;
}

// ---------- (#8) Scheduling ----------
async function resolveScheduleAt(job) {
  if (!job.schedule) return null;
  const s = job.schedule;
  if (s.kind === "immediate" || !s.kind) return null;
  if (s.kind === "at" && s.at) return Number(s.at);
  if (s.kind === "reset") {
    if (s.at) return Number(s.at);
    // Try to scrape the worker tab right now.
    for (const w of Object.values(job.workers || {})) {
      try {
        const r = await chrome.tabs.sendMessage(w.tabId, { type: "GET_RESET_TIME" });
        if (r?.resetAt) return Number(r.resetAt);
      } catch {}
    }
    return null; // no reset time discoverable — start immediately
  }
  return null;
}

function registerScheduleAlarm(jobId, at) {
  const when = Math.max(at, Date.now() + 1000);
  chrome.alarms.create("pp_sched_" + jobId, { when });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const m = alarm.name.match(/^pp_sched_(.+)$/);
  if (!m) return;
  const jobId = m[1];
  const job = jobs[jobId];
  if (!job) return;
  if (job.status !== "scheduled") return;
  // Clear the schedule and start
  job.schedule = { kind: "immediate" };
  job.scheduledFor = null;
  await saveJobs(); notifyAll();
  await startJob(jobId);
});

// ---------- (#6, #7) Cloud-based background runs ----------
// We don't directly drive cloud APIs from inside an MV3 service worker (signing
// SigV4 requests, OAuth refresh tokens, etc. would balloon the bundle). Instead
// we collect credentials, persist them in chrome.storage, and expose two
// transports the user can plug in:
//   - "fetch_endpoint":  POST https://… with the job manifest as JSON. Useful
//                        when the user runs their own deploy of an open-source
//                        backend on the chosen cloud.
//   - "passthrough":     Just hand the job manifest off to the dashboard tab
//                        (which the user keeps open in a small VM running
//                        Chrome via xvfb). Falls back to local foreground.
// For now we treat the cloud run as "scheduled remote": we mark the job as
// running, but stamp it `runMode='background'` and persist the manifest so the
// user's cloud-side runner can pick it up via the storage / fetch endpoint.

async function getCloudCreds() {
  const data = await chrome.storage.local.get(CLOUD_CRED_KEY);
  return data[CLOUD_CRED_KEY] || null;
}

async function setCloudCreds(creds) {
  // Only persist non-secret-prefixed fields; the user can opt-in to storing
  // secrets too. We refuse to save with empty provider.
  if (!creds || !creds.provider) throw new Error("Provider is required");
  await chrome.storage.local.set({ [CLOUD_CRED_KEY]: creds });
  return true;
}

async function clearCloudCreds() {
  await chrome.storage.local.remove(CLOUD_CRED_KEY);
}

// "Test boot" — simulates a tiny round-trip with the configured endpoint to
// confirm the user's creds + endpoint are reachable. We do NOT spin up a real
// VM from MV3; doing so requires service-account-signed API calls that aren't
// safe in an extension. Instead we just probe the user's endpoint with a
// /health request, returning ok or the http error.
async function testCloudBoot() {
  const creds = await getCloudCreds();
  if (!creds) return { ok: false, error: "No cloud credentials configured" };
  if (!creds.endpoint) return { ok: false, error: "No endpoint URL configured" };

  try {
    const t0 = Date.now();
    const headers = { "Content-Type": "application/json" };
    if (creds.apiKey) headers["X-API-Key"] = creds.apiKey;
    const resp = await fetch(creds.endpoint.replace(/\/$/, "") + "/health", {
      method: "POST",
      headers,
      body: JSON.stringify({ probe: true, provider: creds.provider }),
    });
    const elapsed = Date.now() - t0;
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}`, elapsed };
    let body = null;
    try { body = await resp.json(); } catch {}
    return { ok: true, elapsed, info: body || {}, status: resp.status };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Move a job to background. We mark runMode and POST the job manifest to the
// configured endpoint. From this point the local worker loop is paused and the
// user's cloud runner is responsible for processing rows and posting state
// updates back via the JOBS_UPDATE webhook (out of scope here — UI scaffolding
// only).
async function moveJobToBackground(jobId) {
  const job = jobs[jobId];
  if (!job) return { ok: false, error: "No such job" };
  const creds = await getCloudCreds();
  if (!creds) return { ok: false, error: "Configure cloud credentials in the Background Jobs tab first." };

  // Pause local execution
  if (job.status === "running") await pauseJob(jobId, "Moved to background");
  job.runMode = "background";
  await saveJobs(); notifyAll();

  // POST the manifest. Errors are non-fatal — the user can re-trigger.
  if (creds.endpoint) {
    try {
      const headers = { "Content-Type": "application/json" };
      if (creds.apiKey) headers["X-API-Key"] = creds.apiKey;
      await fetch(creds.endpoint.replace(/\/$/, "") + "/jobs/enqueue", {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider: creds.provider,
          job: serializeJobForCloud(job),
          submittedAt: Date.now(),
        }),
      });
    } catch (e) {
      // best-effort
      job.error = "Background submit warning: " + (e?.message || e);
      await saveJobs(); notifyAll();
    }
  }
  return { ok: true };
}

function serializeJobForCloud(job) {
  return {
    id: job.id,
    name: job.name,
    csv: job.csv,
    skipped: job.skipped,
    distribution: job.distribution,
    parallelCount: job.parallelCount,
    primaryLlm: job.primaryLlm,
    primaryModelIndex: job.primaryModelIndex,
    primaryThinking: job.primaryThinking,
    geminiUserNumber: job.geminiUserNumber,
    optionalPrompt: job.optionalPrompt,
    rowFromIndex: job.rowFromIndex,
    rowToIndex: job.rowToIndex,
    codeExec: job.codeExec,
    settings: job.settings,
    schedule: job.schedule,
    rowState: job.rowState,
    responseColumn: job.responseColumn,
  };
}

// ---------- Message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_JOBS":
          sendResponse({ jobs }); break;
        case "CREATE_JOB": {
          const j = await createJob(msg.payload);
          sendResponse({ ok: true, job: j }); break;
        }
        case "START_JOB":
          await startJob(msg.jobId); sendResponse({ ok: true }); break;
        case "PAUSE_JOB":
          await pauseJob(msg.jobId); sendResponse({ ok: true }); break;
        case "DELETE_JOB":
          await deleteJob(msg.jobId); sendResponse({ ok: true }); break;
        case "UPDATE_JOB": {
          const j = jobs[msg.jobId];
          if (!j) return sendResponse({ ok: false, error: "No such job" });
          Object.assign(j, msg.patch || {});
          await saveJobs(); notifyAll();
          sendResponse({ ok: true, job: j }); break;
        }
        case "SCHEDULE_JOB": {
          const j = jobs[msg.jobId];
          if (!j) return sendResponse({ ok: false, error: "No such job" });
          j.schedule = msg.schedule || null;
          if (j.schedule && j.schedule.at && j.status !== "running") {
            j.status = "scheduled";
            j.scheduledFor = j.schedule.at;
            registerScheduleAlarm(j.id, j.schedule.at);
          }
          await saveJobs(); notifyAll();
          sendResponse({ ok: true, job: j }); break;
        }
        case "MOVE_JOB_TO_BACKGROUND": {
          const r = await moveJobToBackground(msg.jobId);
          sendResponse(r); break;
        }
        case "GET_OPEN_TABS": {
          const tabs = await chrome.tabs.query({});
          const supported = tabs
            .filter((t) => detectLLMFromUrl(t.url || ""))
            .map((t) => ({ id: t.id, title: t.title, url: t.url, llm: detectLLMFromUrl(t.url) }));
          sendResponse({ tabs: supported }); break;
        }
        case "CODELAB_RUN_PROMPT_ON_TAB": {
          const { tabId, llm, prompt, modelIndex = 0, thinking = false, autoContinue = false } = msg;
          if (!tabId) return sendResponse({ ok: false, error: "No tabId" });
          if (!(await tabExists(tabId))) return sendResponse({ ok: false, error: "Tab no longer exists" });
          await ensureContentScriptInjected(tabId);
          try {
            const resp = await chrome.tabs.sendMessage(tabId, {
              type: "RUN_PROMPT",
              llm, modelIndex, thinking, prompt,
              autoContinue: !!autoContinue, maxContinues: 5, isPriming: false,
            });
            sendResponse({
              ok: true,
              kind: resp?.kind || "ok",
              text: resp?.text || "",
              partialText: resp?.partialText || "",
              message: resp?.message || "",
              resetAt: resp?.resetAt || null,
            });
          } catch (e) {
            sendResponse({ ok: false, error: e?.message || String(e) });
          }
          break;
        }
        case "GET_LLM_RESET_TIME": {
          // Ask a specific tab when its current rate-limit (if any) resets.
          const tabId = msg.tabId;
          if (!tabId || !(await tabExists(tabId))) return sendResponse({ ok: false, error: "Tab not found" });
          try {
            const r = await chrome.tabs.sendMessage(tabId, { type: "GET_RESET_TIME" });
            sendResponse({ ok: true, ...r });
          } catch (e) { sendResponse({ ok: false, error: e?.message }); }
          break;
        }
        case "HELPER_PING": {
          // Backwards compat — UI uses CLOUD_GET / CLOUD_TEST_BOOT now, but
          // some legacy paths still call this. Always returns helper-missing.
          sendResponse({ ok: false, error: "Local helper deprecated — use Cloud Background Jobs" });
          break;
        }
        case "CLOUD_GET": {
          sendResponse({ ok: true, creds: await getCloudCreds() }); break;
        }
        case "CLOUD_SET": {
          try { await setCloudCreds(msg.creds || {}); sendResponse({ ok: true }); }
          catch (e) { sendResponse({ ok: false, error: e.message }); }
          break;
        }
        case "CLOUD_CLEAR": {
          await clearCloudCreds(); sendResponse({ ok: true }); break;
        }
        case "CLOUD_TEST_BOOT": {
          const r = await testCloudBoot();
          sendResponse(r); break;
        }
        case "OPEN_LLM_TAB": {
          const url = buildLlmUrl(msg.llm, { userNumber: msg.userNumber });
          if (!url) return sendResponse({ ok: false, error: "Unknown LLM" });
          const tab = await chrome.tabs.create({ url, active: false });
          sendResponse({ ok: true, tab }); break;
        }
        case "OPEN_DASHBOARD":
          chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
          sendResponse({ ok: true }); break;
        case "PROMPT_PROGRESS": {
          const tabId = sender.tab?.id;
          for (const job of Object.values(jobs)) {
            for (const w of Object.values(job.workers || {})) {
              if (w.tabId === tabId && w.currentRow !== null && w.currentRow !== undefined) {
                if (job.rowState[w.currentRow]) {
                  job.rowState[w.currentRow].partialText = msg.text || "";
                  notifyAll();
                }
              }
            }
          }
          sendResponse({ ok: true }); break;
        }
        case "PROMPT_RESPONSE":
          sendResponse({ ok: true }); break;
        case "NATIVE_EXECUTE": {
          const r = await executePythonNative({ code: msg.code, timeoutMs: msg.timeoutMs });
          sendResponse(r); break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message: " + msg.type });
      }
    } catch (e) {
      console.error("SW error", e);
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  let changed = false;
  for (const job of Object.values(jobs)) {
    for (const w of Object.values(job.workers || {})) {
      if (w.tabId === tabId && (w.status === "running" || w.status === "idle")) {
        w.status = "error";
        w.lastError = "Tab was closed";
        changed = true;
      }
    }
    if (Object.values(job.workers || {}).every((w) => w.status === "error") && job.status === "running") {
      job.status = "error"; job.error = "All worker tabs closed"; changed = true;
    }
  }
  if (changed) { await saveJobs(); notifyAll(); }
});

chrome.action.onClicked.addListener?.(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
});
