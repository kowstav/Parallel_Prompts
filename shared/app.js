// shared/app.js
// Shared UI for popup + dashboard. Both modes use the same code; CSS handles layout.

(function () {
  const { LLMS } = window.PP_LLMS;

  const STATE = {
    mode: "dashboard",
    root: null,
    jobs: {},
    draft: null,
    activeView: "jobs",
    openTabs: [],
    // Code Lab state — persists across tab switches in this session
    lab: {
      llm: "chatgpt",
      modelIndex: 0,
      thinking: false,
      // Use existing tab? otherwise open new
      useExistingTab: false,
      existingTabId: null,
      promptText: "",
      systemPrompt: "",
      generatedCode: "",
      packages: "",
      maxRepairs: 5,
      timeoutSec: 60,
      freshNamespace: true,
      validatorMode: "none", // 'none' | 'expected' | 'custom'
      expectedOutput: "",
      validatorCode: "def validate(stdout, stderr, value):\n    return True",
      // Run state
      busy: false,
      attempts: [], // [{kind, code, stdout, stderr, error, validatorMessage, passed}]
      pyReady: false,
    },
  };

  // ---------- Icon helpers (Linear-style stroke-1.5 SVGs) ----------
  // Returns inline SVG strings — used inside template literals.
  const IS = (path, size = 14, fill = false) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'}>${path}</svg>`;
  const Icon = {
    play:     (s = 12) => IS(`<path d="M4 3l9 5-9 5V3z"/>`, s, true),
    pause:    (s = 12) => IS(`<rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/>`, s, true),
    download: (s = 12) => IS(`<path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13h10"/>`, s),
    upload:   (s = 12) => IS(`<path d="M8 14V6M4.5 9.5L8 6l3.5 3.5M3 3h10"/>`, s),
    more:     (s = 13) => IS(`<circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/>`, s, true),
    refresh:  (s = 13) => IS(`<path d="M2 8a6 6 0 0 1 10.5-3.96M14 8a6 6 0 0 1-10.5 3.96"/><path d="M12 1.5V5h-3.5M4 14.5V11h3.5"/>`, s),
    expand:   (s = 13) => IS(`<path d="M9.5 2H14v4.5M6.5 14H2V9.5M14 2l-5 5M2 14l5-5"/>`, s),
    alert:    (s = 13) => IS(`<path d="M8 2L1.5 13.5h13L8 2z"/><path d="M8 6.5v3M8 11.5v.5"/>`, s),
    plus:     (s = 12) => IS(`<path d="M8 3v10M3 8h10"/>`, s),
    minus:    (s = 12) => IS(`<path d="M3 8h10"/>`, s),
    x:        (s = 12) => IS(`<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>`, s),
    check:    (s = 11) => IS(`<path d="M3 8.5L6 11.5L13 4.5"/>`, s),
    chev:     (s = 11) => IS(`<path d="M5 3l5 5-5 5"/>`, s),
    trash:    (s = 12) => IS(`<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.5 9a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1L12 4"/>`, s),
    doc:      (s = 18) => IS(`<path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5z"/><path d="M9 1.5V5.5h4M5.5 9h5M5.5 11.5h3"/>`, s),
    arrow:    (s = 11) => IS(`<path d="M3 8h10M9 4l4 4-4 4"/>`, s),
    skip:     (s = 11) => IS(`<path d="M3 8h7M7 4l3 4-3 4"/>`, s),
    cloud:    (s = 12) => IS(`<path d="M4.5 12h7a3 3 0 0 0 0-6 .1.1 0 0 1-.09-.06 4 4 0 0 0-7.42.06A2.5 2.5 0 0 0 4.5 12z"/>`, s),
    clock:    (s = 12) => IS(`<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2 1.5"/>`, s),
  };
  // Make Icon available to other helpers in the IIFE
  STATE.Icon = Icon;

  function init({ mode, root }) {
    STATE.mode = mode;
    STATE.root = root;
    renderShell();
    refreshJobs();
    refreshOpenTabs();
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === "JOBS_UPDATED") {
        STATE.jobs = msg.jobs || {};
        renderJobsList();
        return false;
      }
      // The SW can ask the dashboard to execute python via the local Pyodide bridge.
      // This lets job pipeline rows run code without the SW itself hosting Pyodide.
      // Dashboard mode only — popup wouldn't survive long-running execution.
      if (msg.type === "PYRUN_PROXY" && STATE.mode === "dashboard" && window.PP_PYODIDE) {
        (async () => {
          try {
            await window.PP_PYODIDE.bootstrap();
            const r = await window.PP_PYODIDE.execute({
              code: msg.code,
              packages: msg.packages || [],
              timeoutMs: msg.timeoutMs || 30000,
              freshNamespace: msg.freshNamespace !== false,
            });
            sendResponse({ ok: true, ...r });
          } catch (e) {
            sendResponse({ ok: false, error: e?.message || String(e) });
          }
        })();
        return true; // keep channel open for async response
      }
      if (msg.type === "PYRUN_VALIDATE_PROXY" && STATE.mode === "dashboard" && window.PP_PYODIDE) {
        (async () => {
          try {
            await window.PP_PYODIDE.bootstrap();
            const r = await window.PP_PYODIDE.validate({
              validatorCode: msg.validatorCode || "",
              stdout: msg.stdout || "",
              stderr: msg.stderr || "",
            });
            sendResponse({ ok: true, ...r });
          } catch (e) {
            sendResponse({ ok: false, error: e?.message || String(e) });
          }
        })();
        return true;
      }
      return false;
    });
    setInterval(refreshJobs, 4000);
  }

  // ---------- Shell ----------
  function renderShell() {
    const showLabTabs = STATE.mode === "dashboard" && typeof window.PP_PYODIDE !== "undefined";
    STATE.root.innerHTML = `
      <div class="tabs" id="mainTabs">
        <button data-view="jobs" class="active">Jobs</button>
        <button data-view="newJob">+ New job</button>
        ${showLabTabs ? `<button data-view="codeLab">⚙ Code Lab</button>` : ""}
        ${showLabTabs ? `<button data-view="bgJobs">◇ Background Jobs</button>` : ""}
      </div>
      <div id="viewJobs" class="view"></div>
      <div id="viewNewJob" class="view hidden"></div>
      ${showLabTabs ? `<div id="viewCodeLab" class="view hidden"></div>` : ""}
      ${showLabTabs ? `<div id="viewBgJobs" class="view hidden"></div>` : ""}
    `;
    document.querySelectorAll("#mainTabs button").forEach((b) => {
      b.addEventListener("click", () => switchView(b.dataset.view));
    });
    renderJobsList();
    renderNewJobForm();
    if (showLabTabs) {
      renderCodeLab();
      renderBackgroundJobs();
    }
    // Position the animated tab indicator now that tabs exist
    requestAnimationFrame(updateTabIndicator);
  }

  function updateTabIndicator() {
    const tabs = document.getElementById("mainTabs");
    if (!tabs) return;
    const active = tabs.querySelector("button.active");
    if (!active) return;
    tabs.style.setProperty("--ind-left", active.offsetLeft + "px");
    tabs.style.setProperty("--ind-width", active.offsetWidth + "px");
  }

  function switchView(view) {
    STATE.activeView = view;
    document.querySelectorAll("#mainTabs button").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === view)
    );
    const set = (id, show) => { const el = document.getElementById(id); if (el) el.classList.toggle("hidden", !show); };
    set("viewJobs", view === "jobs");
    set("viewNewJob", view === "newJob");
    set("viewCodeLab", view === "codeLab");
    set("viewBgJobs", view === "bgJobs");
    // Refresh background jobs each time we navigate to it
    if (view === "bgJobs") renderBackgroundJobs();
    updateTabIndicator();
  }

  // ============================================================
  // JOBS LIST
  // ============================================================
  async function refreshJobs() {
    const r = await chrome.runtime.sendMessage({ type: "GET_JOBS" });
    STATE.jobs = r?.jobs || {};
    renderJobsList();
  }

  async function refreshOpenTabs() {
    const r = await chrome.runtime.sendMessage({ type: "GET_OPEN_TABS" });
    STATE.openTabs = r?.tabs || [];
    // Re-render the form's tab picker if visible
    const picker = document.getElementById("tabPickerBox");
    if (picker) renderTabPicker();
  }

  function renderJobsList() {
    const view = document.getElementById("viewJobs");
    if (!view) return;
    const ids = Object.keys(STATE.jobs).sort(
      (a, b) => (STATE.jobs[b].createdAt || 0) - (STATE.jobs[a].createdAt || 0)
    );

    if (!ids.length) {
      view.innerHTML = `
        <div class="empty">
          <div class="empty-icon">${Icon.doc(20)}</div>
          <h3>No jobs yet</h3>
          <p class="muted">Create one to start running prompts on web LLMs.</p>
          <button class="primary" id="emptyNewBtn">+ New job</button>
        </div>
      `;
      view.querySelector("#emptyNewBtn").addEventListener("click", () => switchView("newJob"));
      return;
    }

    view.innerHTML = `
      <div class="row" style="margin-bottom: 14px; justify-content: space-between;">
        <span class="muted small">${ids.length} job${ids.length === 1 ? "" : "s"}</span>
        <button class="ghost icon" id="refreshBtn" title="Refresh">${Icon.refresh(13)}</button>
      </div>
      <div class="jobs-list" id="jobsList"></div>
    `;
    view.querySelector("#refreshBtn").addEventListener("click", refreshJobs);
    const list = view.querySelector("#jobsList");
    ids.forEach((id) => list.appendChild(buildJobCard(STATE.jobs[id])));
  }

  function buildJobCard(job) {
    const total = job.totalRows || job.csv.rows.length;
    const skipped = (job.skipped || []).length;
    const counts = countRowStates(job);
    const effectiveTotal = (counts.done + counts.failed + counts.in_progress + counts.pending + counts.interrupted);
    const completed = counts.done;
    const pct = effectiveTotal === 0 ? 0 : Math.round((completed / effectiveTotal) * 100);

    const card = document.createElement("div");
    card.className = "card job-card";
    card.innerHTML = `
      <div class="job-row">
        <div class="job-title">
          <span class="dot ${job.status}"></span>
          <h3>${escapeHtml(job.name)}</h3>
        </div>
        <div class="row" style="gap: 6px;">
          <span class="pill">${escapeHtml(job.distribution)}</span>
          <span class="pill ${statusPill(job.status)}">${job.status}</span>
        </div>
      </div>
      <div class="progress ${job.status === "running" ? "running" : ""}">
        <div style="width: ${pct}%"></div>
      </div>
      <div class="job-meta">
        <span><strong>${completed}/${effectiveTotal}</strong> done · ${pct}%</span>
        ${counts.in_progress ? `<span class="muted">${Icon.refresh(11)} ${counts.in_progress} running</span>` : ""}
        ${counts.failed ? `<span class="muted">${Icon.x(11)} ${counts.failed} failed</span>` : ""}
        ${counts.interrupted ? `<span class="muted">${Icon.alert(11)} ${counts.interrupted} interrupted</span>` : ""}
        ${counts.skipped ? `<span class="muted">${Icon.skip(11)} ${counts.skipped} skipped</span>` : ""}
        ${job.runMode === "background" ? `<span class="pill accent">background</span>` : ""}
        ${job.scheduledFor ? `<span class="pill">scheduled · ${escapeHtml(new Date(job.scheduledFor).toLocaleString())}</span>` : ""}
      </div>
      <div class="job-workers">
        ${Object.values(job.workers || {}).map((w) => `
          <div class="worker-chip" title="Tab #${w.tabId}${w.lastError ? " — " + escapeHtml(w.lastError) : ""}">
            <span class="dot ${w.status}"></span>
            <span class="mono">${escapeHtml(LLMS[w.llm]?.label || w.llm)}</span>
            ${w.modelIndex ? `<span class="muted">#${w.modelIndex}</span>` : ""}
            ${w.thinking ? `<span class="pill accent" style="padding: 0 6px; font-size: 9px;">think</span>` : ""}
            ${w.currentRow !== null && w.currentRow !== undefined ? `<span class="muted">· row ${w.currentRow + 1}</span>` : ""}
          </div>
        `).join("")}
      </div>
      ${job.error ? `<div class="job-error">${Icon.alert(13)}<div>${escapeHtml(job.error)}</div></div>` : ""}
      <div class="job-actions">
        ${job.status === "running"
          ? `<button data-act="pause">${Icon.pause(11)} Pause</button>`
          : job.status === "done"
          ? `<button class="ghost" data-act="restart">${Icon.refresh(11)} Run again</button>`
          : `<button class="primary" data-act="start">${Icon.play(11)} ${job.status === "paused" ? "Resume" : "Start"}</button>`
        }
        <button data-act="download">${Icon.download(12)} Download CSV</button>
        ${job.runMode !== "background" ? `<button class="ghost" data-act="background" title="Move to cloud background">${Icon.cloud(12)} Background</button>` : ""}
        <button class="ghost" data-act="schedule" title="Schedule a future start">${Icon.clock(12)} Schedule</button>
        <button class="ghost icon" data-act="details" title="Details">${Icon.more(13)}</button>
        <span class="spacer"></span>
        <button class="danger" data-act="delete">Delete</button>
      </div>
    `;
    card.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => handleJobAction(btn.dataset.act, job.id));
    });
    return card;
  }

  function countRowStates(job) {
    const counts = { done: 0, pending: 0, in_progress: 0, failed: 0, skipped: 0, interrupted: 0 };
    for (const s of Object.values(job.rowState || {})) counts[s.status] = (counts[s.status] || 0) + 1;
    return counts;
  }
  function statusPill(s) {
    return { running: "success", paused: "accent", done: "accent", error: "danger", idle: "" }[s] || "";
  }

  async function handleJobAction(act, jobId) {
    const job = STATE.jobs[jobId];
    if (!job) return;
    switch (act) {
      case "start":
        await chrome.runtime.sendMessage({ type: "START_JOB", jobId }); break;
      case "pause":
        await chrome.runtime.sendMessage({ type: "PAUSE_JOB", jobId }); break;
      case "restart": {
        const newRowState = {};
        const skipSet = new Set(job.skipped || []);
        for (let i = 0; i < job.csv.rows.length; i++) {
          if (skipSet.has(i)) newRowState[i] = { status: "skipped" };
          else if (i < (job.rowFromIndex || 0)) newRowState[i] = { status: "skipped" };
          else if (job.rowToIndex !== null && job.rowToIndex !== undefined && i > job.rowToIndex) newRowState[i] = { status: "skipped" };
          else newRowState[i] = { status: "pending", attempts: 0, partialText: "" };
        }
        await chrome.runtime.sendMessage({
          type: "UPDATE_JOB", jobId,
          patch: { rowState: newRowState, status: "idle", error: null, workers: {} },
        });
        await chrome.runtime.sendMessage({ type: "START_JOB", jobId });
        break;
      }
      case "delete":
        if (!confirm("Delete this job? Progress will be lost.")) return;
        await chrome.runtime.sendMessage({ type: "DELETE_JOB", jobId });
        break;
      case "download":
        downloadJobCsv(job); break;
      case "details":
        openDetailsModal(job); break;
      case "background": {
        // (#7) Move this job to the cloud background. Requires cloud creds set in
        //      the Background Jobs tab; if not set, point the user there.
        const cloudCheck = await chrome.runtime.sendMessage({ type: "CLOUD_GET" });
        if (!cloudCheck?.creds?.endpoint) {
          alert("Set up cloud credentials in the Background Jobs tab first.");
          switchView("backgroundJobs");
          return;
        }
        if (!confirm(`Move "${job.name}" to cloud background?\nIt will be sent to ${cloudCheck.creds.endpoint} and continue running even if you close Chrome.`)) return;
        const r = await chrome.runtime.sendMessage({ type: "MOVE_JOB_TO_BACKGROUND", jobId });
        if (!r?.ok) alert("Failed: " + (r?.error || r?.message || "unknown"));
        break;
      }
      case "schedule": {
        // (#8) Quick scheduler from the job card.
        const choice = prompt(
          `Schedule "${job.name}":\n` +
          `  1 = run immediately\n` +
          `  2 = at a specific time\n` +
          `  3 = wait for the LLM's reset / quota timestamp\n\n` +
          `Enter 1, 2 or 3:`,
          "1"
        );
        if (!choice) return;
        if (choice.trim() === "1") {
          await chrome.runtime.sendMessage({ type: "SCHEDULE_JOB", jobId, schedule: { kind: "immediate" } });
        } else if (choice.trim() === "2") {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
          const when = prompt(`Enter a start time in your local timezone (${tz}).\nFormats accepted: "2025-12-31 14:30", ISO datetime, or any date Chrome can parse.`);
          if (!when) return;
          const ts = new Date(when).getTime();
          if (!Number.isFinite(ts)) return alert("Couldn't parse that date.");
          await chrome.runtime.sendMessage({ type: "SCHEDULE_JOB", jobId, schedule: { kind: "at", at: ts, tz } });
        } else if (choice.trim() === "3") {
          await chrome.runtime.sendMessage({ type: "SCHEDULE_JOB", jobId, schedule: { kind: "reset" } });
        }
        break;
      }
    }
    refreshJobs();
  }

  function downloadJobCsv(job) {
    const csv = Papa.unparse({ fields: job.csv.headers, data: job.csv.rows });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    // (#10) Suffix downloaded CSVs with _with_response so users can tell them apart from the originals.
    a.href = url; a.download = `${job.name.replace(/[^a-z0-9-_]+/gi, "_")}_with_response.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // ============================================================
  // NEW JOB FORM
  // ============================================================
  function defaultDraft() {
    return {
      name: "",
      file: null,
      csv: null,
      // 'csv' = upload a file; 'stacker' = type rows manually
      inputMode: "csv",
      stackerMode: false, // mirrors inputMode==='stacker' for use inside renderCsvPreview
      promptColumn: null,
      modelColumn: null,
      responseColumn: "response",
      overwrite: false,
      skipped: new Set(),
      rowFromIndex: 0,
      rowToIndex: null,
      distribution: "single",
      parallelCount: 2,
      primaryLlm: "chatgpt",
      primaryModelIndex: 0, // 0 = use whatever's selected (free-tier-friendly)
      primaryThinking: false,
      geminiUserNumber: "",
      // Tab usage
      useExistingTab: false,
      existingTabIds: {}, // {primary, parallel_0, parallel_1, ...}
      // New chat per row
      perRowNewChat: false,
      parallelNewChat: false,
      singleNewChat: false,
      optionalPrompt: { mode: "none", text: "" },
      delayMs: 3000,
      timeoutMs: 240000,
      retryOnError: true,
      autoContinueClaude: true,
      maxContinues: 5,
      onInterruptResume: "resume",
      // ----- Code execution / agent loop -----
      executeCode: false,
      autoRepair: false,
      maxRepairLoops: 5,
      codeTimeoutS: 30,
      codePackages: "",
      validatorMode: "none",       // 'none' | 'expected' | 'custom'
      validatorExpected: "",
      validatorCustomCode: "def validate(stdout, stderr, value):\n    # return True/False, or '' for pass / 'msg' for fail\n    return True\n",
      // Optional artifact column names for the CSV output (blank = don't write)
      codeColumn: "code",
      stdoutColumn: "stdout",
      stderrColumn: "stderr",
      execStatusColumn: "exec_status",
      codeRuntime: "pyodide", // 'pyodide' | 'native'
      // (#11) Code template — splices LLM-generated code at [llm_response] before running.
      codeTemplate: "",
      // (#12) Answer extractor — pulls a final answer out of LLM text. Special tokens:
      //       <bbox>, <json>, <number>, <final>, or any regex.
      answerExtractor: "",
      answerColumn: "answer",
      // (#2) Max retries per row when the LLM returns an empty/failed response.
      //      The runner reloads the LLM tab between attempts.
      maxRowRetries: 3,
      // (#8) Schedule the job's start. 'immediate' starts as soon as you click Start.
      //      'at' starts at a specific user-set time. 'reset' waits for the LLM's own
      //      reset/quota timestamp scraped from the page (falls back to immediate).
      schedule: {
        kind: "immediate",       // 'immediate' | 'at' | 'reset'
        at: "",                  // ISO local datetime string (from <input type="datetime-local">)
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      },
    };
  }

  // Initialise stacker mode: empty CSV scaffold the user can fill in
  function initStacker(d) {
    const hasModel = d.distribution === "per-row";
    d.stackerMode = true;
    d.csv = {
      headers: hasModel ? ["prompt", "model"] : ["prompt"],
      rows: [
        // start with three empty rows so the grid is visible immediately
        ...Array.from({ length: 3 }, () => {
          const r = {};
          (hasModel ? ["prompt", "model"] : ["prompt"]).forEach((h) => (r[h] = ""));
          return r;
        }),
      ],
    };
    d.skipped = new Set();
    d.rowFromIndex = 0;
    d.rowToIndex = null;
    d.promptColumn = "prompt";
    d.modelColumn = hasModel ? "model" : null;
  }

  function renderNewJobForm() {
    if (!STATE.draft) STATE.draft = defaultDraft();
    const d = STATE.draft;
    const view = document.getElementById("viewNewJob");
    const isClaude = d.primaryLlm === "claude" || (d.distribution === "per-row");

    view.innerHTML = `
      <div class="card">
        <h2>Create a new job</h2>

        <div class="${STATE.mode === "dashboard" ? "new-job-grid" : "stack-md"}">

          <label class="${STATE.mode === "dashboard" ? "" : "full"}">
            <span class="label-text">Job name</span>
            <input type="text" id="f_name" placeholder="e.g. Marketing prompts on Claude" value="${escapeHtml(d.name)}" />
          </label>

          <div class="full">
            <span class="label-text">Prompt source</span>
            <div class="segmented">
              <label><input type="radio" name="inputMode" value="csv"     ${d.inputMode === "csv" ? "checked" : ""}/><span>Upload CSV</span></label>
              <label><input type="radio" name="inputMode" value="stacker" ${d.inputMode === "stacker" ? "checked" : ""}/><span>Stack prompts manually</span></label>
            </div>
            <p class="muted small" id="inputModeHelp" style="margin-top: 6px;"></p>
          </div>

          <label class="${STATE.mode === "dashboard" ? "" : "full"}" id="fileInputBox" ${d.inputMode === "stacker" ? 'style="display:none"' : ""}>
            <span class="label-text">CSV file</span>
            <input type="file" id="f_file" accept=".csv,text/csv" />
          </label>

          <div class="full" id="csvPreviewBox" ${d.csv ? "" : 'style="display:none"'}>
            <div class="row" style="justify-content: space-between; margin-bottom: 8px;">
              <strong style="font-size: 13px;">Rows</strong>
              <span class="muted small" id="rowCountLabel"></span>
            </div>

            <div class="row wrap" style="margin-bottom: 8px; gap: 8px;">
              <label style="flex: 1; min-width: 130px; margin: 0;">
                <span class="label-text">Start at row</span>
                <input type="number" id="f_rowFrom" min="1" value="${(d.rowFromIndex || 0) + 1}" />
              </label>
              <label style="flex: 1; min-width: 130px; margin: 0;">
                <span class="label-text">End at row (blank = last)</span>
                <input type="number" id="f_rowTo" min="1" value="${d.rowToIndex !== null && d.rowToIndex !== undefined ? d.rowToIndex + 1 : ""}" placeholder="last" />
              </label>
            </div>

            <div class="row" style="margin-bottom: 8px; gap: 6px;">
              <button class="ghost" id="selAll">Select all</button>
              <button class="ghost" id="selNone">Deselect all</button>
              <button class="ghost" id="selInvert">Invert</button>
              <span class="spacer"></span>
              <button class="ghost" id="addRowBtn" title="Add empty row at the end">+ Add row</button>
            </div>
            <div class="csv-preview" id="csvPreview"></div>

            <div class="row wrap" style="margin-top: 12px; gap: 12px;">
              <label style="flex:1; min-width: 160px;">
                <span class="label-text">Prompt column</span>
                <select id="f_promptCol"></select>
              </label>
              <label style="flex:1; min-width: 160px;">
                <span class="label-text">Response column name</span>
                <input type="text" id="f_responseCol" value="${escapeHtml(d.responseColumn)}" />
              </label>
            </div>

            <label class="checkbox-row" style="margin-top: 8px;">
              <input type="checkbox" id="f_overwrite" ${d.overwrite ? "checked" : ""} />
              <span>Overwrite existing values in the response column</span>
            </label>
          </div>

          <div class="full">
            <span class="label-text">Distribution</span>
            <div class="segmented">
              <label><input type="radio" name="dist" value="single"   ${d.distribution === "single" ? "checked" : ""}/><span>Single chat</span></label>
              <label><input type="radio" name="dist" value="parallel" ${d.distribution === "parallel" ? "checked" : ""}/><span>Parallel chats (same LLM)</span></label>
              <label><input type="radio" name="dist" value="per-row"  ${d.distribution === "per-row" ? "checked" : ""}/><span>Per-row LLM column</span></label>
            </div>
            <p class="muted small" id="distHelp" style="margin-top: 6px;"></p>
          </div>

          <div id="distSingle" class="${STATE.mode === "dashboard" ? "" : "full"}">
            <label>
              <span class="label-text">LLM</span>
              <select id="f_llm">
                ${Object.entries(LLMS).map(([k, v]) => `<option value="${k}" ${k === d.primaryLlm ? "selected" : ""}>${escapeHtml(v.label)}</option>`).join("")}
              </select>
            </label>
            <label style="margin-top: 10px;">
              <span class="label-text">Model number (1 = first in site's dropdown, 6 = sixth)</span>
              <input type="number" id="f_modelIndex" min="0" max="6" value="${d.primaryModelIndex}" placeholder="0" />
              <span class="muted small">0 = use whatever's currently selected on the site (recommended for free users).</span>
            </label>
            <label class="checkbox-row" style="margin-top: 10px;" id="thinkingToggleRow">
              <input type="checkbox" id="f_thinking" ${d.primaryThinking ? "checked" : ""} />
              <span>Enable "Thinking" / reasoning mode (if supported by the selected LLM)</span>
            </label>
            <label class="checkbox-row" style="margin-top: 10px;">
              <input type="checkbox" id="f_singleNewChat" ${d.singleNewChat ? "checked" : ""} />
              <span>Open a new chat for every row (previous chats stay in sidebar)</span>
            </label>
          </div>

          <div id="distParallel" class="${STATE.mode === "dashboard" ? "" : "full"}">
            <label>
              <span class="label-text">Number of parallel chats: <strong id="parallelLabel">${d.parallelCount}</strong></span>
              <input type="range" id="f_parallel" min="2" max="8" value="${d.parallelCount}" />
            </label>
            <label class="checkbox-row" style="margin-top: 10px;">
              <input type="checkbox" id="f_parallelNewChat" ${d.parallelNewChat ? "checked" : ""} />
              <span>Open a new chat for every row in each tab</span>
            </label>
          </div>

          <div id="distPerRow" class="full" style="display:none;">
            <label>
              <span class="label-text">Model column in CSV</span>
              <select id="f_modelCol"></select>
            </label>
            <p class="muted small" style="margin-top: 6px;">
              Cell format: <code>llm number [thinking]</code> — e.g. <code>claude 1</code>, <code>gemini 2 thinking</code>, <code>chatgpt 3</code>.
              Number means "Nth model in the site's dropdown". Add the word <code>thinking</code> (or <code>reason</code>) to enable reasoning mode.
            </p>
            <label class="checkbox-row" style="margin-top: 10px;">
              <input type="checkbox" id="f_perRowNewChat" ${d.perRowNewChat ? "checked" : ""} />
              <span>Open a new chat for every row (one tab per LLM, fresh chat each row)</span>
            </label>
            <p class="muted small" style="margin-top: 4px;">
              Off → one tab per unique LLM/model/thinking combo, all rows share the chat history.<br>
              On → one tab per LLM, fresh new chat for every row (slower but isolates rows).
            </p>
          </div>

          <div id="geminiUserBox" class="full" style="display:none;">
            <label>
              <span class="label-text">Gemini account number (optional)</span>
              <input type="number" id="f_geminiUser" min="0" max="20" placeholder="e.g. 1" value="${escapeHtml(d.geminiUserNumber)}" />
            </label>
            <p class="muted small" style="margin-top: 4px;">Builds <code>https://gemini.google.com/u/{number}/app</code> for multi-account Google users.</p>
          </div>

          <div class="full" id="tabSourceBox">
            <span class="label-text">Tab source</span>
            <div class="segmented">
              <label><input type="radio" name="tabSource" value="new" ${!d.useExistingTab ? "checked" : ""}/><span>Open new tabs</span></label>
              <label><input type="radio" name="tabSource" value="existing" ${d.useExistingTab ? "checked" : ""}/><span>Use already-open tabs</span></label>
            </div>
            <div id="tabPickerBox" style="margin-top: 10px; display: ${d.useExistingTab ? "block" : "none"};"></div>
          </div>

          <div class="full">
            <span class="label-text">Optional prompt (system / wrapper)</span>
            <div class="segmented" style="margin-bottom: 8px;">
              <label><input type="radio" name="optMode" value="none"   ${d.optionalPrompt.mode === "none" ? "checked" : ""}/><span>None</span></label>
              <label><input type="radio" name="optMode" value="first"  ${d.optionalPrompt.mode === "first" ? "checked" : ""}/><span>Send first</span></label>
              <label><input type="radio" name="optMode" value="prefix" ${d.optionalPrompt.mode === "prefix" ? "checked" : ""}/><span>Prefix every prompt</span></label>
              <label><input type="radio" name="optMode" value="suffix" ${d.optionalPrompt.mode === "suffix" ? "checked" : ""}/><span>Suffix every prompt</span></label>
            </div>
            <textarea id="f_optionalText" rows="3" placeholder="e.g. You are a helpful expert in marketing copy. Respond in JSON.">${escapeHtml(d.optionalPrompt.text)}</textarea>
          </div>

          <details class="full">
            <summary>Advanced</summary>
            <div class="stack-md" style="padding: 12px; background: var(--bg-2); border-radius: var(--r); border: 1px solid var(--line); margin-top: 8px;">
              <label>
                <span class="label-text">Delay between prompts: <strong><span id="delayLabel">${d.delayMs}</span> ms</strong></span>
                <input type="range" id="f_delay" min="0" max="20000" step="500" value="${d.delayMs}" />
              </label>
              <label>
                <span class="label-text">Per-response timeout: <strong><span id="timeoutLabel">${Math.round(d.timeoutMs / 1000)}</span> s</strong></span>
                <input type="range" id="f_timeout" min="0" max="600" step="10" value="${Math.round(d.timeoutMs / 1000)}" />
              </label>
              <label class="checkbox-row">
                <input type="checkbox" id="f_retry" ${d.retryOnError ? "checked" : ""} />
                <span>On error, write [ERROR] to that row and continue</span>
              </label>

              <div id="claudeAdvancedBox" style="display: ${isClaude ? "block" : "none"};">
                <label class="checkbox-row">
                  <input type="checkbox" id="f_autoContinue" ${d.autoContinueClaude ? "checked" : ""} />
                  <span>Claude: auto-press "Continue" if response is cut off</span>
                </label>
                <label style="margin-top: 8px;">
                  <span class="label-text">Max Claude continues per row</span>
                  <input type="number" id="f_maxContinues" min="0" max="20" value="${d.maxContinues}" />
                </label>
              </div>

              <div>
                <span class="label-text">If a row is interrupted by a rate-limit mid-stream, when resuming…</span>
                <div class="segmented">
                  <label><input type="radio" name="onInterrupt" value="resume" ${d.onInterruptResume === "resume" ? "checked" : ""}/><span>Resume that row</span></label>
                  <label><input type="radio" name="onInterrupt" value="next"   ${d.onInterruptResume === "next" ? "checked" : ""}/><span>Skip to next row</span></label>
                </div>
              </div>
            </div>
          </details>

          <details class="full" ${d.executeCode ? "open" : ""}>
            <summary>Execute generated code (agent loop)</summary>
            <div class="stack-md" style="padding: 12px; background: var(--bg-2); border-radius: var(--r); border: 1px solid var(--line); margin-top: 8px;">
              <p class="muted small" style="margin: 0;">
                After each LLM response, extract Python code, run it locally via Pyodide, and (optionally) feed errors back to the LLM until it works.
                <strong>Requires the dashboard tab to be open</strong> while the job runs.
              </p>

              <label class="checkbox-row">
                <input type="checkbox" id="f_executeCode" ${d.executeCode ? "checked" : ""} />
                <span>Execute generated Python code locally</span>
              </label>

              <div id="codeExecPanel" style="${d.executeCode ? "" : "display:none;"}">
                  <div style="margin-top: 10px; margin-bottom: 12px;">
                  <span class="label-text">Execution Engine</span>
                  <div class="segmented">
                    <label><input type="radio" name="cRuntime" value="pyodide" ${d.codeRuntime === "pyodide" ? "checked" : ""}/><span>Browser Python (Pyodide)</span></label>
                    <label><input type="radio" name="cRuntime" value="native"  ${d.codeRuntime === "native" ? "checked" : ""}/><span>Local Python (Native Helper)</span></label>
                  </div>
                </div>
                <label class="checkbox-row">
                  <input type="checkbox" id="f_autoRepair" ${d.autoRepair ? "checked" : ""} />
                  <span>Auto-repair via LLM if execution fails</span>
                </label>

                <div class="row wrap" style="gap: 12px; margin-top: 8px;">
                  <label style="flex: 1; min-width: 160px; margin: 0;">
                    <span class="label-text">Max repair loops</span>
                    <input type="number" id="f_maxRepairLoops" min="0" max="20" value="${d.maxRepairLoops}" />
                  </label>
                  <label style="flex: 1; min-width: 160px; margin: 0;">
                    <span class="label-text">Code timeout (s)</span>
                    <input type="number" id="f_codeTimeoutS" min="1" max="600" value="${d.codeTimeoutS}" />
                  </label>
                </div>

                <label style="margin-top: 8px;">
                  <span class="label-text">Pip packages (comma-separated)</span>
                  <input type="text" id="f_codePackages" value="${escapeAttr(d.codePackages)}" placeholder="e.g. numpy, pandas" />
                </label>

                <div style="margin-top: 10px;">
                  <span class="label-text">Validation</span>
                  <div class="segmented">
                    <label><input type="radio" name="vMode" value="none"     ${d.validatorMode === "none" ? "checked" : ""}/><span>None</span></label>
                    <label><input type="radio" name="vMode" value="expected" ${d.validatorMode === "expected" ? "checked" : ""}/><span>Expected output</span></label>
                    <label><input type="radio" name="vMode" value="custom"   ${d.validatorMode === "custom" ? "checked" : ""}/><span>Custom validator</span></label>
                  </div>
                  <div id="vExpectedBox" style="margin-top: 8px;${d.validatorMode === "expected" ? "" : "display:none;"}">
                    <textarea id="f_validatorExpected" rows="3" placeholder="Exact expected stdout">${escapeHtml(d.validatorExpected)}</textarea>
                  </div>
                  <div id="vCustomBox" style="margin-top: 8px;${d.validatorMode === "custom" ? "" : "display:none;"}">
                    <p class="muted small" style="margin: 0 0 4px;">Define <code>validate(stdout, stderr, value)</code> — return True/False or string.</p>
                    <textarea id="f_validatorCustomCode" rows="6" class="code-editor mini">${escapeHtml(d.validatorCustomCode)}</textarea>
                  </div>
                </div>

                <details style="margin-top: 10px;">
                  <summary>Output columns (write artifacts back to CSV)</summary>
                  <div class="row wrap" style="gap: 8px; margin-top: 8px;">
                    <label style="flex: 1; min-width: 130px; margin: 0;">
                      <span class="label-text">Code column</span>
                      <input type="text" id="f_codeColumn" value="${escapeAttr(d.codeColumn)}" placeholder="leave blank to skip" />
                    </label>
                    <label style="flex: 1; min-width: 130px; margin: 0;">
                      <span class="label-text">stdout column</span>
                      <input type="text" id="f_stdoutColumn" value="${escapeAttr(d.stdoutColumn)}" />
                    </label>
                    <label style="flex: 1; min-width: 130px; margin: 0;">
                      <span class="label-text">stderr column</span>
                      <input type="text" id="f_stderrColumn" value="${escapeAttr(d.stderrColumn)}" />
                    </label>
                    <label style="flex: 1; min-width: 130px; margin: 0;">
                      <span class="label-text">exec status column</span>
                      <input type="text" id="f_execStatusColumn" value="${escapeAttr(d.execStatusColumn)}" />
                    </label>
                  </div>
                </details>

                <details style="margin-top: 10px;">
                  <summary>Code template &amp; answer extraction</summary>
                  <div style="padding: 8px 0;">
                    <label>
                      <span class="label-text">Code template (use <code>[llm_response]</code> placeholder)</span>
                      <textarea id="f_codeTemplate" rows="5" class="code-editor mini" placeholder="# Optional. The LLM's extracted code is spliced in at [llm_response].&#10;# Example:&#10;# import pandas as pd&#10;# df = pd.read_csv('/home/pyodide/work/data.csv')&#10;# [llm_response]&#10;# print(df.head())">${escapeHtml(d.codeTemplate || "")}</textarea>
                    </label>
                    <label style="margin-top: 8px;">
                      <span class="label-text">Answer extractor</span>
                      <input type="text" id="f_answerExtractor" value="${escapeAttr(d.answerExtractor || "")}" placeholder="&lt;bbox&gt;, &lt;json&gt;, &lt;number&gt;, &lt;final&gt;, or any regex" />
                    </label>
                    <label style="margin-top: 8px;">
                      <span class="label-text">Answer column (where to write the extracted answer)</span>
                      <input type="text" id="f_answerColumn" value="${escapeAttr(d.answerColumn || "answer")}" placeholder="answer" />
                    </label>
                  </div>
                </details>
              </div>
            </div>
          </details>
        </div>

        <details class="full">
          <summary>Schedule &amp; retries</summary>
          <div class="stack-md" style="padding: 12px; background: var(--bg-2); border-radius: var(--r); border: 1px solid var(--line); margin-top: 8px;">
            <div>
              <span class="label-text">When to start</span>
              <div class="segmented">
                <label><input type="radio" name="schedKind" value="immediate" ${(d.schedule?.kind || "immediate") === "immediate" ? "checked" : ""}/><span>Immediate</span></label>
                <label><input type="radio" name="schedKind" value="at"        ${d.schedule?.kind === "at" ? "checked" : ""}/><span>At a specific time</span></label>
                <label><input type="radio" name="schedKind" value="reset"     ${d.schedule?.kind === "reset" ? "checked" : ""}/><span>Wait for LLM reset</span></label>
              </div>
              <p class="muted small" style="margin: 6px 0 0;">
                <strong>Wait for LLM reset:</strong> the runner reads the LLM's own quota/reset time off the page. If none is shown, the job starts right away.
              </p>
            </div>
            <div id="schedAtBox" style="${d.schedule?.kind === "at" ? "" : "display:none;"} margin-top: 8px;">
              <div class="row wrap" style="gap: 10px;">
                <label style="flex: 2; min-width: 220px;">
                  <span class="label-text">Start time (your local time)</span>
                  <input type="datetime-local" id="f_schedAt" value="${escapeAttr(d.schedule?.at || "")}" />
                </label>
                <label style="flex: 1; min-width: 180px;">
                  <span class="label-text">Time zone</span>
                  <input type="text" id="f_schedTz" value="${escapeAttr(d.schedule?.tz || "")}" placeholder="e.g. America/New_York" />
                </label>
              </div>
            </div>
            <label style="margin-top: 6px;">
              <span class="label-text">Max retries per row (#2)</span>
              <input type="number" id="f_maxRowRetries" min="0" max="10" value="${Number(d.maxRowRetries ?? 3)}" />
              <p class="muted small" style="margin: 4px 0 0;">If the LLM returns nothing or fails, reload its tab and try again, up to this many times.</p>
            </label>
          </div>
        </details>

        <div class="row" style="justify-content: flex-end; gap: 10px; margin-top: 18px;">
          <button class="ghost" id="cancelBtn">Reset</button>
          <button class="primary" id="createBtn">Create job</button>
        </div>
      </div>
    `;

    // Bind events ----------------------------------------------------------
    const $ = (s) => view.querySelector(s);

    $("#f_name").addEventListener("input", (e) => (d.name = e.target.value));
    $("#f_file").addEventListener("change", onFileSelected);
    $("#f_responseCol").addEventListener("input", (e) => (d.responseColumn = e.target.value));
    $("#f_overwrite").addEventListener("change", (e) => (d.overwrite = e.target.checked));

    view.querySelectorAll('input[name="inputMode"]').forEach((r) =>
      r.addEventListener("change", (e) => {
        d.inputMode = e.target.value;
        if (d.inputMode === "stacker") {
          // Initialise an empty grid the user can fill
          initStacker(d);
        } else {
          d.stackerMode = false;
          // Reset to upload-CSV defaults
          d.csv = null;
          d.skipped = new Set();
        }
        renderNewJobForm();
      })
    );

    $("#f_rowFrom")?.addEventListener("input", (e) => {
      const v = Math.max(1, Number(e.target.value || 1));
      d.rowFromIndex = v - 1;
      renderCsvPreview();
    });
    $("#f_rowTo")?.addEventListener("input", (e) => {
      const v = e.target.value;
      d.rowToIndex = v === "" ? null : Math.max(0, Number(v) - 1);
      renderCsvPreview();
    });
    $("#addRowBtn")?.addEventListener("click", () => {
      const empty = {};
      for (const h of d.csv.headers) empty[h] = "";
      d.csv.rows.push(empty);
      renderCsvPreview();
    });

    view.querySelectorAll('input[name="dist"]').forEach((r) =>
      r.addEventListener("change", (e) => {
        d.distribution = e.target.value;
        // In stacker mode, ensure a 'model' column exists when entering per-row
        if (d.inputMode === "stacker" && d.csv && d.distribution === "per-row") {
          if (!d.csv.headers.includes("model")) {
            d.csv.headers.push("model");
            for (const row of d.csv.rows) row.model = "";
            d.modelColumn = "model";
          }
        }
        updateDistributionUi();
        updateClaudeAdvanced();
        renderTabPicker();
        if (d.csv) renderCsvPreview();
      })
    );
    $("#f_llm")?.addEventListener("change", (e) => {
      d.primaryLlm = e.target.value;
      updateGeminiBox();
      updateClaudeAdvanced();
      renderTabPicker();
    });
    $("#f_modelIndex")?.addEventListener("input", (e) => (d.primaryModelIndex = Math.max(0, Math.min(6, Number(e.target.value || 0)))));
    $("#f_thinking")?.addEventListener("change", (e) => (d.primaryThinking = e.target.checked));
    $("#f_singleNewChat")?.addEventListener("change", (e) => (d.singleNewChat = e.target.checked));
    $("#f_parallel")?.addEventListener("input", (e) => { d.parallelCount = Number(e.target.value); $("#parallelLabel").textContent = d.parallelCount; renderTabPicker(); });
    $("#f_parallelNewChat")?.addEventListener("change", (e) => (d.parallelNewChat = e.target.checked));
    $("#f_perRowNewChat")?.addEventListener("change", (e) => (d.perRowNewChat = e.target.checked));
    $("#f_geminiUser")?.addEventListener("input", (e) => (d.geminiUserNumber = e.target.value));

    view.querySelectorAll('input[name="tabSource"]').forEach((r) =>
      r.addEventListener("change", (e) => {
        d.useExistingTab = e.target.value === "existing";
        document.getElementById("tabPickerBox").style.display = d.useExistingTab ? "block" : "none";
        if (d.useExistingTab) { refreshOpenTabs(); renderTabPicker(); }
      })
    );

    view.querySelectorAll('input[name="cRuntime"]').forEach((r) =>
      r.addEventListener("change", (e) => (d.codeRuntime = e.target.value))
    );

    view.querySelectorAll('input[name="optMode"]').forEach((r) =>
      r.addEventListener("change", (e) => (d.optionalPrompt.mode = e.target.value))
    );
    $("#f_optionalText").addEventListener("input", (e) => (d.optionalPrompt.text = e.target.value));

    $("#f_delay").addEventListener("input", (e) => { d.delayMs = Number(e.target.value); $("#delayLabel").textContent = d.delayMs; });
    $("#f_timeout").addEventListener("input", (e) => { d.timeoutMs = Number(e.target.value) * 1000; $("#timeoutLabel").textContent = e.target.value; });
    $("#f_retry").addEventListener("change", (e) => (d.retryOnError = e.target.checked));
    $("#f_autoContinue")?.addEventListener("change", (e) => (d.autoContinueClaude = e.target.checked));
    $("#f_maxContinues")?.addEventListener("input", (e) => (d.maxContinues = Number(e.target.value)));
    view.querySelectorAll('input[name="onInterrupt"]').forEach((r) =>
      r.addEventListener("change", (e) => (d.onInterruptResume = e.target.value))
    );

    // Code execution / agent loop bindings
    $("#f_executeCode")?.addEventListener("change", (e) => {
      d.executeCode = e.target.checked;
      const panel = view.querySelector("#codeExecPanel");
      if (panel) panel.style.display = d.executeCode ? "" : "none";
    });
    $("#f_autoRepair")?.addEventListener("change", (e) => (d.autoRepair = e.target.checked));
    $("#f_maxRepairLoops")?.addEventListener("input", (e) => (d.maxRepairLoops = Math.max(0, Math.min(20, Number(e.target.value) || 5))));
    $("#f_codeTimeoutS")?.addEventListener("input", (e) => (d.codeTimeoutS = Math.max(1, Math.min(600, Number(e.target.value) || 30))));
    $("#f_codePackages")?.addEventListener("input", (e) => (d.codePackages = e.target.value));
    view.querySelectorAll('input[name="vMode"]').forEach((r) =>
      r.addEventListener("change", (e) => {
        d.validatorMode = e.target.value;
        const eb = view.querySelector("#vExpectedBox");
        const cb = view.querySelector("#vCustomBox");
        if (eb) eb.style.display = d.validatorMode === "expected" ? "" : "none";
        if (cb) cb.style.display = d.validatorMode === "custom" ? "" : "none";
      })
    );
    $("#f_validatorExpected")?.addEventListener("input", (e) => (d.validatorExpected = e.target.value));
    $("#f_validatorCustomCode")?.addEventListener("input", (e) => (d.validatorCustomCode = e.target.value));
    $("#f_codeColumn")?.addEventListener("input", (e) => (d.codeColumn = e.target.value));
    $("#f_stdoutColumn")?.addEventListener("input", (e) => (d.stdoutColumn = e.target.value));
    $("#f_stderrColumn")?.addEventListener("input", (e) => (d.stderrColumn = e.target.value));
    $("#f_execStatusColumn")?.addEventListener("input", (e) => (d.execStatusColumn = e.target.value));
    // (#11) Code template
    $("#f_codeTemplate")?.addEventListener("input", (e) => (d.codeTemplate = e.target.value));
    // (#12) Answer extractor + column
    $("#f_answerExtractor")?.addEventListener("input", (e) => (d.answerExtractor = e.target.value));
    $("#f_answerColumn")?.addEventListener("input", (e) => (d.answerColumn = e.target.value));
    // (#2) Per-row retries
    $("#f_maxRowRetries")?.addEventListener("input", (e) => (d.maxRowRetries = Math.max(0, Math.min(10, Number(e.target.value) || 3))));
    // (#8) Schedule
    view.querySelectorAll('input[name="schedKind"]').forEach((r) =>
      r.addEventListener("change", (e) => {
        d.schedule = d.schedule || { kind: "immediate", at: "", tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
        d.schedule.kind = e.target.value;
        const atBox = view.querySelector("#schedAtBox");
        if (atBox) atBox.style.display = d.schedule.kind === "at" ? "" : "none";
      })
    );
    $("#f_schedAt")?.addEventListener("input", (e) => {
      d.schedule = d.schedule || { kind: "at", at: "", tz: "UTC" };
      d.schedule.at = e.target.value;
    });
    $("#f_schedTz")?.addEventListener("input", (e) => {
      d.schedule = d.schedule || { kind: "immediate", at: "", tz: "UTC" };
      d.schedule.tz = e.target.value;
    });

    $("#selAll").addEventListener("click", () => { d.skipped = new Set(); renderCsvPreview(); });
    $("#selNone").addEventListener("click", () => { d.skipped = new Set(d.csv.rows.map((_, i) => i)); renderCsvPreview(); });
    $("#selInvert").addEventListener("click", () => {
      const next = new Set();
      for (let i = 0; i < d.csv.rows.length; i++) if (!d.skipped.has(i)) next.add(i);
      d.skipped = next; renderCsvPreview();
    });
    $("#cancelBtn").addEventListener("click", () => { STATE.draft = defaultDraft(); renderNewJobForm(); });
    $("#createBtn").addEventListener("click", createJob);

    updateDistributionUi();
    updateGeminiBox();
    updateClaudeAdvanced();
    // Update prompt-source help text
    const helpEl = document.getElementById("inputModeHelp");
    if (helpEl) {
      helpEl.textContent = d.inputMode === "stacker"
        ? "Type prompts directly into the table. Use + to add rows, +col to add columns, × to delete a row."
        : "Upload a CSV file with at least one column of prompts.";
    }
    if (d.csv) {
      renderColumnDropdowns();
      renderCsvPreview();
    }
    renderTabPicker();
  }

  // ----- Helpers for new-job form -----
  function onFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (res) => {
        const d = STATE.draft;
        d.csv = { headers: res.meta.fields || [], rows: res.data || [] };
        d.skipped = new Set();
        d.rowFromIndex = 0;
        d.rowToIndex = null;
        if (!d.name) d.name = file.name.replace(/\.csv$/i, "");
        d.promptColumn = d.csv.headers.find((h) => /prompt|question|input|text|query/i.test(h)) || d.csv.headers[0];
        d.modelColumn = d.csv.headers.find((h) => /model|llm|version/i.test(h)) || d.csv.headers[0];
        renderNewJobForm();
      },
      error: (err) => alert("Failed to parse CSV: " + err.message),
    });
  }

  function renderColumnDropdowns() {
    const d = STATE.draft;
    if (!d.csv) return;
    const promptSel = document.getElementById("f_promptCol");
    if (promptSel) {
      promptSel.innerHTML = d.csv.headers.map((h) => `<option value="${escapeAttr(h)}" ${h === d.promptColumn ? "selected" : ""}>${escapeHtml(h)}</option>`).join("");
      promptSel.addEventListener("change", (e) => (d.promptColumn = e.target.value));
    }
    const modelSel = document.getElementById("f_modelCol");
    if (modelSel) {
      modelSel.innerHTML = d.csv.headers.map((h) => `<option value="${escapeAttr(h)}" ${h === d.modelColumn ? "selected" : ""}>${escapeHtml(h)}</option>`).join("");
      modelSel.addEventListener("change", (e) => (d.modelColumn = e.target.value));
    }
  }

  function renderCsvPreview() {
    const d = STATE.draft;
    const box = document.getElementById("csvPreviewBox");
    if (!d.csv) { box && (box.style.display = "none"); return; }
    box.style.display = "";
    const totalRows = d.csv.rows.length;
    const inRange = (i) => {
      if (i < (d.rowFromIndex || 0)) return false;
      if (d.rowToIndex !== null && d.rowToIndex !== undefined && i > d.rowToIndex) return false;
      return true;
    };
    const selectedCount = d.csv.rows.reduce((acc, _, i) => acc + (!d.skipped.has(i) && inRange(i) ? 1 : 0), 0);
    document.getElementById("rowCountLabel").textContent = `${totalRows} rows · ${selectedCount} will run`;

    const previewLimit = Math.min(d.csv.rows.length, 500);
    const tbl = document.createElement("table");

    // ----- Header row -----
    const trh = document.createElement("tr");
    // checkbox column header
    const thChk = document.createElement("th");
    trh.appendChild(thChk);
    // row-number header
    const thNum = document.createElement("th");
    thNum.textContent = "#";
    trh.appendChild(thNum);
    // column headers — editable in stacker mode
    d.csv.headers.forEach((h, hi) => {
      const th = document.createElement("th");
      if (d.stackerMode) {
        th.contentEditable = "true";
        th.dataset.headerIdx = hi;
        th.textContent = h;
        th.title = "Click to rename column";
        th.classList.add("editable-header");
      } else {
        th.textContent = h;
      }
      trh.appendChild(th);
    });
    // trailing actions header (insert / add column / delete)
    const thAct = document.createElement("th");
    if (d.stackerMode) {
      const addColBtn = document.createElement("button");
      addColBtn.className = "ghost icon";
      addColBtn.title = "Add column";
      addColBtn.textContent = "+col";
      addColBtn.dataset.action = "addColumn";
      thAct.appendChild(addColBtn);
    }
    trh.appendChild(thAct);
    const thead = document.createElement("thead");
    thead.appendChild(trh);
    tbl.appendChild(thead);

    // ----- Body -----
    const tbody = document.createElement("tbody");
    for (let i = 0; i < previewLimit; i++) {
      const isSkipped = d.skipped.has(i);
      const out = !inRange(i);
      const tr = document.createElement("tr");

      // checkbox cell
      const tdChk = document.createElement("td");
      tdChk.innerHTML = `<input type="checkbox" data-row="${i}" ${isSkipped ? "" : "checked"} ${out ? "disabled" : ""} />`;
      tr.appendChild(tdChk);

      // row number
      const tdNum = document.createElement("td");
      tdNum.className = "muted";
      tdNum.textContent = String(i + 1);
      tr.appendChild(tdNum);

      // editable data cells
      d.csv.headers.forEach((h) => {
        const td = document.createElement("td");
        const v = d.csv.rows[i][h] ?? "";
        td.contentEditable = "true";
        td.dataset.rowIdx = i;
        td.dataset.col = h;
        // The response column shouldn't be edited normally — mark it visually but still allow it
        if (h === d.responseColumn) td.classList.add("response-col");
        if (isSkipped || out) td.classList.add("cell-skipped");
        td.classList.add("editable-cell");
        td.textContent = String(v);
        td.title = String(v);
        tr.appendChild(td);
      });

      // trailing actions: insert below + delete
      const tdAct = document.createElement("td");
      tdAct.className = "row-actions";
      tdAct.innerHTML =
        `<button class="ghost icon" data-insert="${i}" title="Insert empty row below">+</button>` +
        `<button class="ghost icon" data-delete="${i}" title="Delete row">×</button>`;
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);

    const container = document.getElementById("csvPreview");
    container.innerHTML = "";
    container.appendChild(tbl);

    // ----- Bind events -----

    // Checkbox toggle (skip flag)
    container.querySelectorAll('input[type="checkbox"][data-row]').forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const i = Number(e.target.dataset.row);
        if (e.target.checked) d.skipped.delete(i);
        else d.skipped.add(i);
        // No re-render — toggle the row's class directly to keep focus elsewhere
        const tr = e.target.closest("tr");
        tr.querySelectorAll(".editable-cell").forEach((td) => td.classList.toggle("cell-skipped", !e.target.checked));
        document.getElementById("rowCountLabel").textContent = `${d.csv.rows.length} rows · ${d.csv.rows.reduce((a, _, j) => a + (!d.skipped.has(j) && inRange(j) ? 1 : 0), 0)} will run`;
      });
    });

    // Insert empty row below
    container.querySelectorAll("button[data-insert]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const i = Number(e.currentTarget.dataset.insert);
        const empty = {};
        for (const h of d.csv.headers) empty[h] = "";
        d.csv.rows.splice(i + 1, 0, empty);
        // Shift skipped indices > i upward by 1
        const next = new Set();
        for (const idx of d.skipped) next.add(idx > i ? idx + 1 : idx);
        d.skipped = next;
        if (d.rowToIndex !== null && d.rowToIndex !== undefined && d.rowToIndex > i) d.rowToIndex += 1;
        renderCsvPreview();
      });
    });

    // Delete row
    container.querySelectorAll("button[data-delete]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const i = Number(e.currentTarget.dataset.delete);
        d.csv.rows.splice(i, 1);
        // Rebuild skipped
        const next = new Set();
        for (const idx of d.skipped) {
          if (idx === i) continue;
          next.add(idx > i ? idx - 1 : idx);
        }
        d.skipped = next;
        if (d.rowToIndex !== null && d.rowToIndex !== undefined && d.rowToIndex >= i) d.rowToIndex = Math.max(0, d.rowToIndex - 1);
        renderCsvPreview();
      });
    });

    // Editable cells — write back on input (live) and on blur (final)
    container.querySelectorAll(".editable-cell").forEach((td) => {
      const writeBack = () => {
        const ri = Number(td.dataset.rowIdx);
        const col = td.dataset.col;
        if (!d.csv.rows[ri]) return;
        d.csv.rows[ri][col] = td.innerText;
      };
      td.addEventListener("input", writeBack);
      td.addEventListener("blur", writeBack);
      // Keep Tab moving cell-to-cell
      td.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          // Enter commits and moves to the same column in the next row
          e.preventDefault();
          writeBack();
          const ri = Number(td.dataset.rowIdx);
          const col = td.dataset.col;
          const nextCell = container.querySelector(`.editable-cell[data-row-idx="${ri + 1}"][data-col="${escapeAttr(col)}"]`);
          if (nextCell) { nextCell.focus(); }
          else td.blur();
        }
      });
    });

    // Editable column headers (stacker mode)
    container.querySelectorAll(".editable-header").forEach((th) => {
      th.addEventListener("blur", () => {
        const idx = Number(th.dataset.headerIdx);
        const newName = th.innerText.trim() || `col_${idx + 1}`;
        const oldName = d.csv.headers[idx];
        if (newName === oldName) return;
        // Avoid duplicates
        let unique = newName;
        let n = 2;
        while (d.csv.headers.includes(unique) && unique !== oldName) {
          unique = newName + "_" + n;
          n++;
        }
        d.csv.headers[idx] = unique;
        // Rename in every row
        for (const row of d.csv.rows) {
          row[unique] = row[oldName];
          delete row[oldName];
        }
        // Patch tracked column references in the draft
        if (d.promptColumn === oldName) d.promptColumn = unique;
        if (d.modelColumn === oldName) d.modelColumn = unique;
        if (d.responseColumn === oldName) d.responseColumn = unique;
        renderCsvPreview();
        renderColumnDropdowns();
      });
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); th.blur(); }
      });
    });

    // Add column (stacker mode)
    const addColBtn = container.querySelector("button[data-action='addColumn']");
    if (addColBtn) {
      addColBtn.addEventListener("click", () => {
        let name = "column_" + (d.csv.headers.length + 1);
        let n = 2;
        while (d.csv.headers.includes(name)) { name = "column_" + (d.csv.headers.length + n); n++; }
        d.csv.headers.push(name);
        for (const row of d.csv.rows) row[name] = "";
        renderCsvPreview();
        renderColumnDropdowns();
      });
    }

    renderColumnDropdowns();
  }

  function updateDistributionUi() {
    const d = STATE.draft;
    const help = {
      single: "One chat tab. Rows are sent sequentially.",
      parallel: "Open multiple tabs of the same LLM and split rows between them.",
      "per-row": "Use a CSV column to specify the LLM/model for each row.",
    };
    document.getElementById("distHelp").textContent = help[d.distribution] || "";
    const set = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? "" : "none"; };
    set("distSingle", d.distribution === "single" || d.distribution === "parallel");
    set("distParallel", d.distribution === "parallel");
    set("distPerRow", d.distribution === "per-row");
    // Tab source selector only makes sense when not opening many varied tabs (per-row creates lots)
    set("tabSourceBox", d.distribution !== "per-row");
  }

  function updateGeminiBox() {
    const d = STATE.draft;
    const showGemini = (d.distribution === "single" || d.distribution === "parallel")
      ? d.primaryLlm === "gemini" : true;
    const box = document.getElementById("geminiUserBox");
    if (box) box.style.display = showGemini ? "" : "none";
  }

  function updateClaudeAdvanced() {
    const d = STATE.draft;
    const isClaude = d.primaryLlm === "claude" || d.distribution === "per-row";
    const box = document.getElementById("claudeAdvancedBox");
    if (box) box.style.display = isClaude ? "block" : "none";

    // Thinking toggle is only really useful for some LLMs; show for all but only meaningful for some
    // Keep visible (toggling on a non-supporting LLM is harmless) but adjust hint
    const thinkRow = document.getElementById("thinkingToggleRow");
    if (thinkRow) {
      const supports = ["chatgpt", "claude", "gemini", "deepseek", "qwen", "perplexity", "copilot", "grok"];
      // All LLMs have some form of "thinking"/reasoning toggle, so just leave it visible
    }
  }

  function renderTabPicker() {
    const d = STATE.draft;
    const box = document.getElementById("tabPickerBox");
    if (!box) return;
    if (!d.useExistingTab) { box.innerHTML = ""; return; }
    if (d.distribution === "per-row") { box.innerHTML = '<p class="muted small">Existing tabs aren\'t supported in per-row mode (the extension auto-opens tabs for each LLM).</p>'; return; }

    const targetLlm = d.primaryLlm;
    const matching = STATE.openTabs.filter((t) => t.llm === targetLlm);

    let html = `<div class="row" style="justify-content: space-between; margin-bottom: 6px;">
      <strong style="font-size: 12px;">Select ${targetLlm} tab${d.distribution === "parallel" ? "s" : ""}:</strong>
      <button class="ghost icon" id="refreshTabsBtn" title="Refresh tabs">${Icon.refresh(13)}</button>
    </div>`;
    if (matching.length === 0) {
      html += `<p class="muted small">No open tabs of <strong>${escapeHtml(LLMS[targetLlm]?.label || targetLlm)}</strong> found. Open the LLM in a tab first, log in, then click ↻.</p>`;
    } else {
      const slots = d.distribution === "parallel" ? d.parallelCount : 1;
      for (let s = 0; s < slots; s++) {
        const slotKey = d.distribution === "parallel" ? `parallel_${s}` : "primary";
        html += `<label style="margin-bottom: 6px;">
          <span class="label-text">${d.distribution === "parallel" ? `Tab #${s + 1}` : "Tab"}</span>
          <select data-slot="${slotKey}">
            <option value="">— select —</option>
            ${matching.map((t) =>
              `<option value="${t.id}" ${d.existingTabIds[slotKey] == t.id ? "selected" : ""}>#${t.id} · ${escapeHtml((t.title || "").slice(0, 60))}</option>`
            ).join("")}
          </select>
        </label>`;
      }
    }
    box.innerHTML = html;
    box.querySelectorAll("select[data-slot]").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const slot = e.target.dataset.slot;
        const id = Number(e.target.value || 0);
        if (id) d.existingTabIds[slot] = id;
        else delete d.existingTabIds[slot];
      });
    });
    box.querySelector("#refreshTabsBtn")?.addEventListener("click", refreshOpenTabs);
  }

  async function createJob() {
    const d = STATE.draft;
    if (!d.csv) return alert(d.inputMode === "stacker" ? "Add at least one row first." : "Please upload a CSV first.");
    if (!d.promptColumn) return alert("Pick a prompt column.");
    if (d.distribution === "per-row" && !d.modelColumn) return alert("Pick the model column.");

    // For stacker mode, drop trailing rows that are entirely empty so the user doesn't
    // create a job with empty prompts taking up worker time.
    let cleanedRows = d.csv.rows;
    if (d.inputMode === "stacker") {
      cleanedRows = d.csv.rows.filter((r) =>
        d.csv.headers.some((h) => String(r[h] ?? "").trim().length > 0)
      );
      if (cleanedRows.length === 0) return alert("All rows are empty. Type some prompts before creating the job.");
    }

    if (d.useExistingTab && d.distribution !== "per-row") {
      const slots = d.distribution === "parallel" ? d.parallelCount : 1;
      for (let s = 0; s < slots; s++) {
        const slotKey = d.distribution === "parallel" ? `parallel_${s}` : "primary";
        if (!d.existingTabIds[slotKey]) return alert(`Pick a tab for slot "${slotKey}" or switch to "Open new tabs".`);
      }
    }

    const payload = {
      name: d.name || "Untitled job",
      csv: {
        headers: [...d.csv.headers],
        rows: cleanedRows.map((r) => ({ ...r })),
        promptColumn: d.promptColumn,
        modelColumn: d.distribution === "per-row" ? d.modelColumn : null,
      },
      skipped: Array.from(d.skipped).filter((i) => i < cleanedRows.length),
      rowFromIndex: d.rowFromIndex || 0,
      rowToIndex: d.rowToIndex,
      responseColumn: d.responseColumn || "response",
      distribution: d.distribution,
      parallelCount: d.parallelCount,
      primaryLlm: d.primaryLlm,
      primaryModelIndex: d.primaryModelIndex,
      primaryThinking: d.primaryThinking,
      geminiUserNumber: d.geminiUserNumber || null,
      perRowNewChat: d.perRowNewChat,
      parallelNewChat: d.parallelNewChat,
      singleNewChat: d.singleNewChat,
      
      existingTabIds: d.useExistingTab ? d.existingTabIds : null,
      optionalPrompt: { mode: d.optionalPrompt.mode, text: d.optionalPrompt.text },
      codeExec: d.executeCode ? {
        executeCode: true,
        runtime: d.codeRuntime,
        autoRepair: !!d.autoRepair,
        maxRepairLoops: d.maxRepairLoops,
        codeTimeoutS: d.codeTimeoutS,
        packages: d.codePackages,
        validator: {
          mode: d.validatorMode,
          expected: d.validatorExpected,
          code: d.validatorCustomCode,
        },
        codeColumn: d.codeColumn,
        stdoutColumn: d.stdoutColumn,
        stderrColumn: d.stderrColumn,
        execStatusColumn: d.execStatusColumn,
        // (#11)
        codeTemplate: d.codeTemplate || "",
        // (#12)
        answerExtractor: d.answerExtractor || "",
        answerColumn: d.answerColumn || "",
      } : (d.answerExtractor || d.codeTemplate ? {
        // executeCode is off but the user still configured an extractor / template,
        // so we send a minimal codeExec object so the SW can apply them per-row.
        executeCode: false,
        runtime: d.codeRuntime,
        codeTemplate: d.codeTemplate || "",
        answerExtractor: d.answerExtractor || "",
        answerColumn: d.answerColumn || "",
      } : null),
      settings: {
        delayBetweenPromptsMs: d.delayMs,
        perResponseTimeoutMs: d.timeoutMs,
        retryOnError: d.retryOnError,
        overwrite: d.overwrite,
        autoContinueClaude: d.autoContinueClaude,
        maxContinues: d.maxContinues,
        onInterruptResume: d.onInterruptResume,
        // (#2)
        maxRowRetries: Math.max(0, Math.min(10, Number(d.maxRowRetries) || 3)),
      },
      // (#8) Top-level schedule — the SW reads this when the job is started.
      schedule: d.schedule && d.schedule.kind ? {
        kind: d.schedule.kind,
        at: d.schedule.kind === "at" && d.schedule.at ? new Date(d.schedule.at).getTime() : null,
        tz: d.schedule.tz || "UTC",
      } : { kind: "immediate", at: null, tz: "UTC" },
    };

    const r = await chrome.runtime.sendMessage({ type: "CREATE_JOB", payload });
    if (!r?.ok) return alert("Failed to create job: " + (r?.error || "unknown"));

    STATE.draft = defaultDraft();
    renderNewJobForm();
    switchView("jobs");
    refreshJobs();
  }

  // ============================================================
  // DETAILS MODAL
  // ============================================================
  function openDetailsModal(job) {
    const counts = countRowStates(job);
    const html = `
      <div class="modal-backdrop" id="detailsBackdrop">
        <div class="modal">
          <div class="modal-header">
            <h2>${escapeHtml(job.name)}</h2>
            <button class="ghost icon" id="closeDetails">${Icon.x(12)}</button>
          </div>
          <div class="modal-body">
            <div class="row wrap" style="gap: 8px; margin-bottom: 12px;">
              <span class="pill">${escapeHtml(job.distribution)}</span>
              <span class="pill ${statusPill(job.status)}">${job.status}</span>
              <span class="pill">${job.totalRows} rows</span>
              <span class="pill success">${counts.done || 0} done</span>
              ${counts.failed ? `<span class="pill danger">${counts.failed} failed</span>` : ""}
              ${counts.interrupted ? `<span class="pill warning">${counts.interrupted} interrupted</span>` : ""}
            </div>
            <div class="card" style="margin-bottom: 12px;">
              <strong>Workers</strong>
              <div class="stack" style="margin-top: 8px;">
                ${Object.values(job.workers || {}).map((w) => `
                  <div class="row" style="gap: 8px; padding: 6px 8px; background: var(--bg-2); border-radius: 8px;">
                    <span class="dot ${w.status}"></span>
                    <strong>${escapeHtml(LLMS[w.llm]?.label || w.llm)}</strong>
                    ${w.modelIndex ? `<span class="muted">model #${w.modelIndex}</span>` : '<span class="muted">default model</span>'}
                    ${w.thinking ? `<span class="pill accent">thinking</span>` : ""}
                    <span class="muted small">tab #${w.tabId}</span>
                    <span class="spacer"></span>
                    <span class="muted small">${escapeHtml(w.status)}${w.lastError ? " · " + escapeHtml(w.lastError) : ""}</span>
                  </div>
                `).join("") || '<p class="muted small">No workers yet — start the job to spawn them.</p>'}
              </div>
            </div>
            <strong>Rows</strong>
            <div class="rows-detail">
              ${(job.csv.rows || []).slice(0, 100).map((row, i) => {
                const st = job.rowState[i] || { status: "pending" };
                const prompt = String(row[job.csv.promptColumn] || "").slice(0, 140);
                const resp = String(row[job.responseColumn] || "").slice(0, 140);
                const hasExec = st.code || st.repairAttempts || st.execStatus;
                const dagNodes = hasExec ? buildExecDag(st) : null;
                return `
                  <div class="row-detail row-${st.status}">
                    <div class="row-detail-main">
                      <span class="row-num">${i + 1}</span>
                      <span class="dot ${rowStatusToDot(st.status)}"></span>
                      <span class="row-prompt">${escapeHtml(prompt)}${prompt.length === 140 ? "…" : ""}</span>
                      <span class="row-resp muted">${escapeHtml(resp)}${resp.length === 140 ? "…" : ""}</span>
                    </div>
                    ${hasExec ? `
                      <details class="exec-details">
                        <summary>
                          <span class="exec-graph-inline">${dagNodes.inline}</span>
                          <span class="muted small" style="margin-left: 8px;">
                            ${st.repairAttempts > 1 ? `${st.repairAttempts} attempts` : ""}
                            ${st.execStatus ? ` · ${escapeHtml(st.execStatus)}` : ""}
                          </span>
                        </summary>
                        <div class="exec-graph">${dagNodes.full}</div>
                      </details>
                    ` : ""}
                  </div>`;
              }).join("")}
              ${job.csv.rows.length > 100 ? `<p class="muted small" style="padding: 8px;">…and ${job.csv.rows.length - 100} more rows.</p>` : ""}
            </div>
          </div>
          <div class="modal-footer">
            <button class="ghost" id="closeDetails2">Close</button>
            <button id="downloadFromDetails">${Icon.download(12)} Download CSV</button>
          </div>
        </div>
      </div>
    `;
    const el = document.createElement("div");
    el.innerHTML = html;
    document.body.appendChild(el.firstElementChild);
    document.getElementById("closeDetails").addEventListener("click", closeDetailsModal);
    document.getElementById("closeDetails2").addEventListener("click", closeDetailsModal);
    document.getElementById("downloadFromDetails").addEventListener("click", () => downloadJobCsv(job));
    document.getElementById("detailsBackdrop").addEventListener("click", (e) => {
      if (e.target.id === "detailsBackdrop") closeDetailsModal();
    });
  }
  function closeDetailsModal() { document.getElementById("detailsBackdrop")?.remove(); }
  function rowStatusToDot(s) {
    return { done: "done", in_progress: "running", interrupted: "paused", failed: "error", skipped: "idle", pending: "idle" }[s] || "idle";
  }

  // Build a tiny DAG showing the prompt → code → run → [repair]* → status chain
  // for a row that has been through the agent loop.
  function buildExecDag(st) {
    const versions = Array.isArray(st.repairedVersions) ? st.repairedVersions : [];
    const finalKind = st.execStatus === "passed" ? "ok" :
                      st.execStatus === "no_code" ? "fail" :
                      st.execStatus === "bridge_error" ? "error" :
                      st.execStatus === "failed" ? "fail" : "info";

    // Inline summary: dots with arrows
    const dots = [];
    dots.push(`<span class="dag-dot info" title="Prompt"></span>`);
    dots.push(`<span class="dag-arrow">→</span>`);
    if (st.code) dots.push(`<span class="dag-dot info" title="Code extracted"></span>`);
    else dots.push(`<span class="dag-dot fail" title="No code extracted"></span>`);
    // Each previous attempt is a failed dot, then a fresh code dot
    versions.forEach(() => {
      dots.push(`<span class="dag-arrow">→</span>`);
      dots.push(`<span class="dag-dot fail" title="Run failed"></span>`);
      dots.push(`<span class="dag-arrow">→</span>`);
      dots.push(`<span class="dag-dot info" title="Repair"></span>`);
    });
    dots.push(`<span class="dag-arrow">→</span>`);
    dots.push(`<span class="dag-dot ${finalKind}" title="Final: ${st.execStatus || ""}"></span>`);

    // Full vertical view
    const nodes = [];
    nodes.push(`<div class="dag-node info"><strong>1.</strong> Prompt sent to LLM</div>`);
    versions.forEach((v, i) => {
      nodes.push(`<div class="dag-node info"><strong>${i + 2}.</strong> LLM returned code (attempt ${i + 1})${v.code ? `<details><summary>code</summary><pre class="output-pre">${escapeHtml(v.code)}</pre></details>` : ""}</div>`);
      nodes.push(`<div class="dag-node fail"><strong>↳</strong> Execution failed${v.error ? `<details><summary>error</summary><pre class="output-pre stderr">${escapeHtml(v.error)}</pre></details>` : ""}</div>`);
      nodes.push(`<div class="dag-node info"><strong>↳</strong> Repair feedback sent to LLM</div>`);
    });
    if (st.code) {
      const finalIdx = versions.length + 2;
      nodes.push(`<div class="dag-node info"><strong>${finalIdx}.</strong> Final code<details><summary>code (${(st.code || "").length} chars)</summary><pre class="output-pre">${escapeHtml(st.code)}</pre></details></div>`);
    }
    nodes.push(`<div class="dag-node ${finalKind}"><strong>↳</strong> ${escapeHtml(st.execStatus || "unknown")}${
      st.execStdout ? `<details><summary>stdout</summary><pre class="output-pre">${escapeHtml(st.execStdout)}</pre></details>` : ""
    }${
      st.execStderr ? `<details><summary>stderr / error</summary><pre class="output-pre stderr">${escapeHtml(st.execStderr)}</pre></details>` : ""
    }</div>`);

    return { inline: dots.join(""), full: nodes.join("") };
  }

  // ============================================================
  // Code Lab — thin delegator (full implementation lives in code-lab/code-lab.js)
  // ============================================================
  let _codeLabBootstrapped = false;
  function renderCodeLab() {
    const view = document.getElementById("viewCodeLab");
    if (!view) return;
    if (_codeLabBootstrapped) return;
    if (window.PP_CODE_LAB && typeof window.PP_CODE_LAB.init === "function") {
      window.PP_CODE_LAB.init(view);
      _codeLabBootstrapped = true;
    } else {
      view.innerHTML = `<div class="card"><p class="muted small">Code Lab module failed to load.</p></div>`;
    }
  }

  // ============================================================
  // Background Jobs — thin delegator (implementation in background-jobs/background-jobs.js)
  // ============================================================
  let _bgJobsBootstrapped = false;
  function renderBackgroundJobs() {
    const view = document.getElementById("viewBgJobs");
    if (!view) return;
    if (window.PP_BG_JOBS && typeof window.PP_BG_JOBS.init === "function") {
      // Re-init each time the tab is selected so the helper status is fresh.
      window.PP_BG_JOBS.init(view);
      _bgJobsBootstrapped = true;
    } else {
      view.innerHTML = `<div class="card"><p class="muted small">Background Jobs module failed to load.</p></div>`;
    }
  }

  // ============================================================
  // Helpers
  // ============================================================
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  window.PP_APP = { init };
})();
