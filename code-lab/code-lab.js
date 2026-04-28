// code-lab/code-lab.js
// Code Lab — a mini notebook for running Python locally via Pyodide.
// Single-cell editor + run controls + output panels + package manager + history.
//
// Plus an LLM-assisted "Run + Repair" mode: takes a prompt, sends it to the
// currently-active LLM tab, extracts python code from the response, executes
// it, and if execution fails, feeds the traceback back to the LLM and asks
// for a fix — repeating up to maxRepairLoops times.
//
// New in this revision:
//   (#4)  Packages tab now also accepts user-uploaded files (custom .py modules,
//         .csv data, anything). Files are staged into the Pyodide FS at fixed
//         paths and the path is shown so the user can copy it into their code.
//   (#5)  After a run, any new files produced under WORK_DIR are surfaced as
//         download buttons that save to the user's Downloads folder, with the
//         in-Pyodide path shown so the user knows where the code wrote them.
//   (#11) Code template field with [llm_response] placeholder — splices the
//         LLM's extracted code into a user-defined wrapper before executing.
//   (#12) Answer extractor field — supports special tokens (<bbox>, <json>,
//         <number>, <final>) and arbitrary regex.

(function () {
  const STATE = {
    root: null,
    code: "# Try Python locally with Pyodide.\n# Edit me, then click Run.\nfor i in range(5):\n    print('hello', i)\n",
    packages: "",
    timeoutS: 30,
    freshNamespace: true,
    lastResult: null,
    runHistory: [],
    // Repair loop state
    repairPrompt: "",
    repairMaxLoops: 5,
    repairLog: [],
    repairActiveTabId: null,
    // Validation
    validatorMode: "none",
    expectedOutput: "",
    customValidatorCode: "def validate(stdout, stderr, value):\n    # return True/False, or '' for pass / 'msg' for fail\n    return True\n",
    runtime: "pyodide",
    // (#4) Staged files (mirrors Pyodide-side state — refreshed on demand)
    stagedFiles: [],
    // (#11)
    codeTemplate: "",
    // (#12)
    answerExtractor: "",
    lastExtractedAnswer: "",
  };

  function init(root) {
    STATE.root = root;
    render();
    if (window.PP_PYODIDE) {
      window.PP_PYODIDE.bootstrap()
        .then(async () => {
          updateStatus("Pyodide ready", "success");
          await refreshStagedFiles();
        })
        .catch((e) => updateStatus("Pyodide failed: " + (e?.message || e), "error"));
    } else {
      updateStatus("Pyodide bridge missing", "error");
    }
  }

  function render() {
    STATE.root.innerHTML = `
      <div class="card code-lab">
        <div class="row" style="justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
          <div>
            <h2 style="margin: 0 0 4px;">Code Lab</h2>
            <p class="muted small" style="margin: 0;">Local Python via Pyodide. Browser-sandboxed, no install.</p>
          </div>
          <span class="pill" id="pyodideStatus">Booting…</span>
        </div>

        <div class="tabs" style="margin-bottom: 14px;" id="labTabs">
          <button data-tab="editor" class="active">Editor</button>
          <button data-tab="repair">Run + Repair</button>
          <button data-tab="packages">Packages &amp; Files</button>
          <button data-tab="history">History</button>
        </div>

        <div id="labViewEditor" class="lab-view"></div>
        <div id="labViewRepair" class="lab-view hidden"></div>
        <div id="labViewPackages" class="lab-view hidden"></div>
        <div id="labViewHistory" class="lab-view hidden"></div>
      </div>
    `;

    STATE.root.querySelectorAll("#labTabs button").forEach((b) => {
      b.addEventListener("click", () => switchTab(b.dataset.tab));
    });

    renderEditor();
    renderRepair();
    renderPackages();
    renderHistory();

    requestAnimationFrame(() => updateLabTabIndicator());
  }

  function updateLabTabIndicator() {
    const tabs = STATE.root && STATE.root.querySelector("#labTabs");
    if (!tabs) return;
    const active = tabs.querySelector("button.active");
    if (!active) return;
    tabs.style.setProperty("--ind-left", active.offsetLeft + "px");
    tabs.style.setProperty("--ind-width", active.offsetWidth + "px");
  }

  function switchTab(tab) {
    STATE.root.querySelectorAll("#labTabs button").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === tab)
    );
    ["editor", "repair", "packages", "history"].forEach((t) => {
      const el = document.getElementById("labView" + t.charAt(0).toUpperCase() + t.slice(1));
      if (el) el.classList.toggle("hidden", t !== tab);
    });
    updateLabTabIndicator();
  }

  function updateStatus(text, kind = "") {
    const el = document.getElementById("pyodideStatus");
    if (!el) return;
    el.textContent = text;
    el.className = "pill " + (kind === "success" ? "success" : kind === "error" ? "danger" : "");
  }

  // ============================================================
  // EDITOR TAB
  // ============================================================
  function renderEditor() {
    const view = document.getElementById("labViewEditor");
    view.innerHTML = `
      <div class="row wrap" style="gap: 10px; margin-bottom: 10px;">
        <label style="width: 220px;">
          <span class="label-text">Engine</span>
          <select id="lab_runtime">
            <option value="pyodide" ${STATE.runtime === "pyodide" ? "selected" : ""}>Browser (Pyodide)</option>
            <option value="native" ${STATE.runtime === "native" ? "selected" : ""}>Native (Local Python)</option>
          </select>
        </label>
        <label style="flex: 1; min-width: 240px;">
          <span class="label-text">Pip packages (comma-separated, optional)</span>
          <input type="text" id="lab_pkgs" placeholder="numpy, pandas, networkx" value="${escapeAttr(STATE.packages)}" />
        </label>
        <label style="width: 120px;">
          <span class="label-text">Timeout (s)</span>
          <input type="number" id="lab_timeout" min="1" max="600" value="${STATE.timeoutS}" />
        </label>
        <label class="checkbox-row" style="margin-top: 22px;">
          <input type="checkbox" id="lab_fresh" ${STATE.freshNamespace ? "checked" : ""}/>
          <span>Fresh namespace</span>
        </label>
      </div>

      <textarea id="lab_code" class="code-editor" spellcheck="false">${escapeHtml(STATE.code)}</textarea>

      <details style="margin-top: 8px;">
        <summary class="muted small">Advanced: code template &amp; answer extractor</summary>
        <div style="padding: 10px 0;">
          <label>
            <span class="label-text">Code template (use <code>[llm_response]</code> as placeholder)</span>
            <textarea id="lab_template" rows="4" class="code-editor mini" placeholder="# Optional wrapper, leave blank to run the editor as-is.&#10;# Example:&#10;# import sys&#10;# [llm_response]&#10;# print('done')">${escapeHtml(STATE.codeTemplate)}</textarea>
          </label>
          <label style="margin-top: 8px;">
            <span class="label-text">Answer extractor (special tokens or regex; leave blank for none)</span>
            <input type="text" id="lab_extractor" value="${escapeAttr(STATE.answerExtractor)}" placeholder="e.g. &lt;bbox&gt;, &lt;json&gt;, &lt;number&gt;, &lt;final&gt;, or a regex" />
          </label>
        </div>
      </details>

      <div class="row" style="gap: 8px; margin-top: 10px;">
        <button class="primary" id="lab_run"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3l9 5-9 5V3z"/></svg> Run</button>
        <button class="ghost" id="lab_clear">Clear output</button>
        <span class="spacer"></span>
        <button class="ghost" id="lab_save">Save snippet</button>
      </div>

      <div class="output-panels" style="margin-top: 14px;">
        <div class="output-block">
          <div class="output-label">stdout</div>
          <pre id="lab_stdout" class="output-pre"></pre>
        </div>
        <div class="output-block">
          <div class="output-label">stderr</div>
          <pre id="lab_stderr" class="output-pre stderr"></pre>
        </div>
      </div>
      <div id="lab_files_out" class="muted small" style="margin-top: 10px;"></div>
      <div id="lab_extracted" class="muted small" style="margin-top: 6px;"></div>
      <div id="lab_result_meta" class="muted small" style="margin-top: 8px;"></div>
    `;

    const $ = (s) => view.querySelector(s);
    $("#lab_code").addEventListener("input", (e) => (STATE.code = e.target.value));
    $("#lab_pkgs").addEventListener("input", (e) => (STATE.packages = e.target.value));
    $("#lab_timeout").addEventListener("input", (e) => (STATE.timeoutS = Math.max(1, Number(e.target.value) || 30)));
    $("#lab_fresh").addEventListener("change", (e) => (STATE.freshNamespace = e.target.checked));
    $("#lab_template").addEventListener("input", (e) => (STATE.codeTemplate = e.target.value));
    $("#lab_extractor").addEventListener("input", (e) => (STATE.answerExtractor = e.target.value));

    $("#lab_run").addEventListener("click", runEditor);
    $("#lab_clear").addEventListener("click", () => {
      $("#lab_stdout").textContent = "";
      $("#lab_stderr").textContent = "";
      $("#lab_result_meta").textContent = "";
      $("#lab_files_out").innerHTML = "";
      $("#lab_extracted").innerHTML = "";
    });
    $("#lab_save").addEventListener("click", () => {
      const blob = new Blob([STATE.code], { type: "text/x-python" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `snippet_${Date.now()}.py`;
      a.click(); URL.revokeObjectURL(url);
    });

    $("#lab_runtime").addEventListener("change", (e) => (STATE.runtime = e.target.value));
    $("#lab_code").addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        runEditor();
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const start = this.selectionStart;
        const end = this.selectionEnd;
        this.value = this.value.substring(0, start) + "    " + this.value.substring(end);
        this.selectionStart = this.selectionEnd = start + 4;
        STATE.code = this.value;
      }
    });
  }

  async function runEditor() {
    if (!window.PP_PYODIDE) return alert("Pyodide bridge not loaded");
    const view = document.getElementById("labViewEditor");
    const $ = (s) => view.querySelector(s);
    const stdoutEl = $("#lab_stdout");
    const stderrEl = $("#lab_stderr");
    const metaEl = $("#lab_result_meta");
    const filesEl = $("#lab_files_out");
    const extractedEl = $("#lab_extracted");

    stdoutEl.textContent = ""; stderrEl.textContent = "";
    filesEl.innerHTML = ""; extractedEl.innerHTML = "";
    metaEl.innerHTML = `<span class="dot running"></span> running…`;
    $("#lab_run").disabled = true;

    const pkgs = STATE.packages.split(",").map((s) => s.trim()).filter(Boolean);
    // (#11) Apply template if it has the placeholder; otherwise run the editor
    // contents verbatim.
    let codeToRun = STATE.code;
    if (STATE.codeTemplate && /\[llm_(response|code)\]/.test(STATE.codeTemplate)) {
      codeToRun = window.PP_PYODIDE.applyCodeTemplate(STATE.codeTemplate, STATE.code);
    }

    const t0 = performance.now();
    try {
      let r;
      if (STATE.runtime === "native") {
        r = await chrome.runtime.sendMessage({
            type: "NATIVE_EXECUTE",
            code: codeToRun,
            timeoutMs: STATE.timeoutS * 1000
        });
      } else {
        r = await window.PP_PYODIDE.execute({
          code: codeToRun,
          packages: pkgs,
          timeoutMs: STATE.timeoutS * 1000,
          freshNamespace: STATE.freshNamespace,
        });
      }
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      stdoutEl.textContent = r.stdout || "";
      stderrEl.textContent = (r.error || "") + (r.stderr ? "\n" + r.stderr : "");

      // (#5) Surface output files as downloads
      if (Array.isArray(r.files) && r.files.length) {
        renderProducedFiles(filesEl, r.files);
      }

      // (#12) Extracted answer
      if (STATE.answerExtractor && r.stdout) {
        const ans = window.PP_PYODIDE.extractAnswer(r.stdout, STATE.answerExtractor);
        STATE.lastExtractedAnswer = ans;
        if (ans) {
          extractedEl.innerHTML = `<strong>Extracted answer:</strong> <code>${escapeHtml(ans.length > 400 ? ans.slice(0, 400) + "…" : ans)}</code>`;
        } else {
          extractedEl.innerHTML = `<em>Extractor matched nothing.</em>`;
        }
      }

      const okLabel = r.timedOut ? `<span class="pill danger">timed out</span>` :
                      r.ok ? `<span class="pill success">ok</span>` :
                             `<span class="pill danger">error</span>`;
      const pkgInfo = r.packages?.installed?.length ? ` · packages: ${r.packages.installed.join(", ")}` : "";
      const errs = r.packages?.errors?.length ? ` · pkg errors: ${r.packages.errors.map(e => e.pkg).join(", ")}` : "";
      const fileNote = (r.files && r.files.length) ? ` · produced ${r.files.length} file${r.files.length === 1 ? "" : "s"}` : "";
      metaEl.innerHTML = `${okLabel} · ${elapsed}s${pkgInfo}${errs}${fileNote}`;
      STATE.lastResult = r;
      pushHistory(STATE.code, r);
    } catch (e) {
      stderrEl.textContent = "Bridge error: " + (e?.message || e);
      metaEl.innerHTML = `<span class="pill danger">bridge error</span>`;
    } finally {
      $("#lab_run").disabled = false;
    }
  }

  // (#5) Render produced files as download buttons. Each click triggers a
  // browser download via the Downloads API so the user gets it on their FS.
  function renderProducedFiles(container, files) {
    container.innerHTML = `
      <div class="card" style="padding:10px; margin-top:6px;">
        <strong>Files produced by this run</strong>
        <p class="muted small" style="margin:4px 0 8px;">
          These were written by your code into the in-browser Pyodide filesystem at the path shown.
          Click <em>Download</em> to save the file to your computer's Downloads folder.
        </p>
        <div id="files_list"></div>
      </div>
    `;
    const list = container.querySelector("#files_list");
    files.forEach((f) => {
      const row = document.createElement("div");
      row.className = "row";
      row.style.cssText = "justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line-2);";
      row.innerHTML = `
        <div style="flex:1; min-width:0;">
          <div class="mono small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(f.path)}</div>
          <div class="muted small">${formatBytes(f.size || 0)}</div>
        </div>
        <button class="ghost">Download</button>
      `;
      row.querySelector("button").addEventListener("click", () => downloadProducedFile(f));
      list.appendChild(row);
    });
  }

  function downloadProducedFile(f) {
    try {
      const bin = atob(f.base64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const blob = new Blob([buf]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = f.name || "pp_output.bin";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      alert("Download failed: " + (e?.message || e));
    }
  }

  function formatBytes(n) {
    if (!n) return "0 B";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  // ============================================================
  // RUN + REPAIR TAB
  // ============================================================
  function renderRepair() {
    const view = document.getElementById("labViewRepair");
    view.innerHTML = `
      <p class="muted small" style="margin-top: 0;">
        Send a prompt to the active LLM tab. The extension extracts python from the response,
        runs it locally, and if execution fails, asks the LLM for a fix — repeating until
        success or max loops.
      </p>

      <label>
        <span class="label-text">Active LLM tab</span>
        <div class="row" style="gap: 6px;">
          <select id="rp_tab" style="flex: 1;"></select>
          <button class="ghost icon" id="rp_refresh"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8a6 6 0 0 1 10.5-3.96M14 8a6 6 0 0 1-10.5 3.96"/><path d="M12 1.5V5h-3.5M4 14.5V11h3.5"/></svg></button>
        </div>
      </label>

      <label style="margin-top: 10px;">
        <span class="label-text">Prompt</span>
        <textarea id="rp_prompt" rows="4" placeholder="e.g. write a python program that prints the first 20 prime numbers">${escapeHtml(STATE.repairPrompt)}</textarea>
      </label>

      <div class="row wrap" style="gap: 12px; margin-top: 10px;">
        <label style="flex: 1; min-width: 200px;">
          <span class="label-text">Max repair loops</span>
          <input type="number" id="rp_maxloops" min="0" max="20" value="${STATE.repairMaxLoops}" />
        </label>
        <label style="flex: 1; min-width: 200px;">
          <span class="label-text">Pip packages</span>
          <input type="text" id="rp_pkgs" value="${escapeAttr(STATE.packages)}" placeholder="optional" />
        </label>
      </div>

      <details style="margin-top: 10px;">
        <summary class="muted small">Advanced: code template &amp; answer extractor</summary>
        <div style="padding: 10px 0;">
          <label>
            <span class="label-text">Code template (use <code>[llm_response]</code> as placeholder)</span>
            <textarea id="rp_template" rows="4" class="code-editor mini" placeholder="# Optional wrapper for LLM-extracted code.&#10;# Leave blank to run the LLM's code as-is.">${escapeHtml(STATE.codeTemplate)}</textarea>
          </label>
          <label style="margin-top: 8px;">
            <span class="label-text">Answer extractor</span>
            <input type="text" id="rp_extractor" value="${escapeAttr(STATE.answerExtractor)}" placeholder="&lt;bbox&gt;, &lt;json&gt;, &lt;number&gt;, &lt;final&gt;, or a regex" />
          </label>
        </div>
      </details>

      <div style="margin-top: 12px;">
        <span class="label-text">Validation</span>
        <div class="segmented">
          <label><input type="radio" name="rpVal" value="none"     ${STATE.validatorMode === "none" ? "checked" : ""}/><span>None</span></label>
          <label><input type="radio" name="rpVal" value="expected" ${STATE.validatorMode === "expected" ? "checked" : ""}/><span>Expected output</span></label>
          <label><input type="radio" name="rpVal" value="custom"   ${STATE.validatorMode === "custom" ? "checked" : ""}/><span>Custom validator</span></label>
        </div>

        <div id="rp_expectedBox" style="margin-top: 8px;${STATE.validatorMode === "expected" ? "" : "display:none;"}">
          <textarea id="rp_expected" rows="3" placeholder="Exact expected stdout">${escapeHtml(STATE.expectedOutput)}</textarea>
        </div>
        <div id="rp_customBox" style="margin-top: 8px;${STATE.validatorMode === "custom" ? "" : "display:none;"}">
          <p class="muted small" style="margin: 0 0 4px;">Define a <code>validate(stdout, stderr, value)</code> function. Return True/False, or '' (pass) / message (fail).</p>
          <textarea id="rp_custom" rows="6" class="code-editor mini">${escapeHtml(STATE.customValidatorCode)}</textarea>
        </div>
      </div>

      <div class="row" style="gap: 8px; margin-top: 12px;">
        <button class="primary" id="rp_run"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3l9 5-9 5V3z"/></svg> Run + Repair</button>
        <button class="hidden" id="rp_stop"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/></svg> Stop</button>
      </div>

      <div id="rp_log" class="repair-log" style="margin-top: 14px;"></div>
    `;

    const $ = (s) => view.querySelector(s);
    $("#rp_prompt").addEventListener("input", (e) => (STATE.repairPrompt = e.target.value));
    $("#rp_maxloops").addEventListener("input", (e) => (STATE.repairMaxLoops = Math.max(0, Math.min(20, Number(e.target.value) || 5))));
    $("#rp_pkgs").addEventListener("input", (e) => (STATE.packages = e.target.value));
    $("#rp_template").addEventListener("input", (e) => (STATE.codeTemplate = e.target.value));
    $("#rp_extractor").addEventListener("input", (e) => (STATE.answerExtractor = e.target.value));

    view.querySelectorAll('input[name="rpVal"]').forEach((r) =>
      r.addEventListener("change", (e) => {
        STATE.validatorMode = e.target.value;
        $("#rp_expectedBox").style.display = STATE.validatorMode === "expected" ? "" : "none";
        $("#rp_customBox").style.display = STATE.validatorMode === "custom" ? "" : "none";
      })
    );
    $("#rp_expected")?.addEventListener("input", (e) => (STATE.expectedOutput = e.target.value));
    $("#rp_custom")?.addEventListener("input", (e) => (STATE.customValidatorCode = e.target.value));

    $("#rp_refresh").addEventListener("click", refreshRepairTabs);
    $("#rp_run").addEventListener("click", runRepair);
    refreshRepairTabs();
  }

  async function refreshRepairTabs() {
    const sel = document.getElementById("rp_tab");
    if (!sel) return;
    sel.innerHTML = `<option value="">— refreshing —</option>`;
    const r = await chrome.runtime.sendMessage({ type: "GET_OPEN_TABS" });
    const tabs = r?.tabs || [];
    if (!tabs.length) {
      sel.innerHTML = `<option value="">— no LLM tabs open —</option>`;
      return;
    }
    sel.innerHTML = tabs.map((t) =>
      `<option value="${t.id}" ${STATE.repairActiveTabId == t.id ? "selected" : ""}>${escapeHtml(t.llm)} · #${t.id} · ${escapeHtml((t.title || "").slice(0, 60))}</option>`
    ).join("");
    sel.addEventListener("change", (e) => (STATE.repairActiveTabId = Number(e.target.value)));
    if (!STATE.repairActiveTabId) STATE.repairActiveTabId = tabs[0].id;
    sel.value = STATE.repairActiveTabId;
  }

  async function runRepair() {
    const view = document.getElementById("labViewRepair");
    const log = view.querySelector("#rp_log");
    const runBtn = view.querySelector("#rp_run");
    log.innerHTML = "";
    runBtn.disabled = true;

    if (!STATE.repairActiveTabId) {
      log.innerHTML = `<div class="repair-step error">Pick an LLM tab first.</div>`;
      runBtn.disabled = false;
      return;
    }
    if (!STATE.repairPrompt.trim()) {
      log.innerHTML = `<div class="repair-step error">Enter a prompt.</div>`;
      runBtn.disabled = false;
      return;
    }

    const pkgs = STATE.packages.split(",").map((s) => s.trim()).filter(Boolean);
    const tabInfo = await chrome.tabs.get(STATE.repairActiveTabId).catch(() => null);
    if (!tabInfo) {
      log.innerHTML = `<div class="repair-step error">Tab no longer exists.</div>`;
      runBtn.disabled = false;
      return;
    }
    const llm = detectLLMFromUrl(tabInfo.url);
    if (!llm) {
      log.innerHTML = `<div class="repair-step error">That tab isn't a recognised LLM site.</div>`;
      runBtn.disabled = false;
      return;
    }

    let currentPrompt = STATE.repairPrompt;
    let attempt = 0;
    const maxLoops = STATE.repairMaxLoops;

    appendStep(log, "info", `Sending initial prompt to ${llm}…`);

    while (attempt <= maxLoops) {
      attempt++;
      let llmResp;
      try {
        llmResp = await chrome.runtime.sendMessage({
          type: "CODELAB_RUN_PROMPT_ON_TAB",
          tabId: STATE.repairActiveTabId,
          llm, prompt: currentPrompt,
        });
      } catch (e) {
        appendStep(log, "error", `LLM dispatch failed: ${e?.message || e}`);
        break;
      }
      if (!llmResp?.ok || llmResp.kind === "error") {
        appendStep(log, "error", `LLM error: ${llmResp?.message || "unknown"}`);
        break;
      }
      if (llmResp.kind && llmResp.kind !== "ok") {
        appendStep(log, "error", `LLM ${llmResp.kind}: ${llmResp.message}`);
        break;
      }

      const text = llmResp.text || "";
      const code = window.PP_PYODIDE.extractPythonCode(text);
      appendStep(log, "info", `Attempt ${attempt}: got ${text.length} chars from LLM, extracted ${code.length} chars of code`,
                  { details: code });

      if (!code) {
        appendStep(log, "error", "Couldn't extract any Python code from the response.");
        break;
      }

      // (#11) Apply optional template wrapping
      const finalCode = STATE.codeTemplate && /\[llm_(response|code)\]/.test(STATE.codeTemplate)
        ? window.PP_PYODIDE.applyCodeTemplate(STATE.codeTemplate, code)
        : code;

      appendStep(log, "info", `Running code locally via ${STATE.runtime}…`);
      let execResult;
      if (STATE.runtime === "native") {
        execResult = await chrome.runtime.sendMessage({
            type: "NATIVE_EXECUTE",
            code: finalCode,
            timeoutMs: STATE.timeoutS * 1000
        });
      } else {
        execResult = await window.PP_PYODIDE.execute({
          code: finalCode, packages: pkgs, timeoutMs: STATE.timeoutS * 1000, freshNamespace: true,
        });
      }

      const valResult = await applyValidator(execResult);
      const passed = !execResult.error && !execResult.timedOut && valResult.passed;

      // (#5) If files were produced, surface them
      const extras = {
        code, stdout: execResult.stdout, stderr: execResult.stderr || execResult.error || "",
        validation: valResult.message, files: execResult.files || [],
      };

      // (#12) Extract answer
      if (STATE.answerExtractor && execResult.stdout) {
        extras.extractedAnswer = window.PP_PYODIDE.extractAnswer(execResult.stdout, STATE.answerExtractor);
      }

      appendStep(log, passed ? "ok" : "fail",
        passed ? `Attempt ${attempt} succeeded.` :
                  `Attempt ${attempt} failed: ${execResult.timedOut ? "timeout" : execResult.error ? "runtime error" : "validation failed"}`,
        extras);

      if (passed) break;
      if (attempt > maxLoops) {
        appendStep(log, "error", `Hit max ${maxLoops} repair loops without success.`);
        break;
      }

      const errBlob = (execResult.error || "") + (execResult.stderr ? "\n" + execResult.stderr : "");
      currentPrompt = buildRepairPrompt({
        originalPrompt: STATE.repairPrompt,
        previousCode: code,
        stdout: execResult.stdout || "",
        errorOrStderr: errBlob,
        validatorMessage: valResult.passed ? "" : valResult.message,
      });
      appendStep(log, "info", `Asking LLM to fix the error (attempt ${attempt + 1})…`);
    }

    runBtn.disabled = false;
  }

  function buildRepairPrompt({ originalPrompt, previousCode, stdout, errorOrStderr, validatorMessage }) {
    let p = `The previous Python code you wrote did not work as expected.\n\n`;
    p += `Original task:\n${originalPrompt}\n\n`;
    p += `Code you wrote:\n\`\`\`python\n${previousCode}\n\`\`\`\n\n`;
    if (stdout && stdout.trim()) p += `stdout:\n\`\`\`\n${stdout.slice(0, 2000)}\n\`\`\`\n\n`;
    if (errorOrStderr && errorOrStderr.trim()) p += `error / stderr:\n\`\`\`\n${errorOrStderr.slice(0, 2000)}\n\`\`\`\n\n`;
    if (validatorMessage) p += `Validator message:\n${validatorMessage}\n\n`;
    p += `Please fix the code and respond with the corrected version inside a single \`\`\`python\`\`\` code block.`;
    return p;
  }

  async function applyValidator(execResult) {
    if (STATE.validatorMode === "none") return { passed: true, message: "no validator" };
    if (execResult.error || execResult.timedOut) return { passed: false, message: "execution failed" };

    if (STATE.validatorMode === "expected") {
      const expected = STATE.expectedOutput.replace(/\r\n/g, "\n").trim();
      const got = (execResult.stdout || "").replace(/\r\n/g, "\n").trim();
      const passed = expected === got;
      return { passed, message: passed ? "stdout matched expected" : `expected != got (got ${got.length} chars)` };
    }
    if (STATE.validatorMode === "custom") {
      try {
        const r = await window.PP_PYODIDE.validate({
          validatorCode: STATE.customValidatorCode,
          stdout: execResult.stdout || "",
          stderr: execResult.stderr || "",
        });
        return { passed: !!r.passed, message: r.message || "" };
      } catch (e) {
        return { passed: false, message: "validator threw: " + (e?.message || e) };
      }
    }
    return { passed: true, message: "" };
  }

  function appendStep(container, kind, headline, extra = {}) {
    const div = document.createElement("div");
    div.className = "repair-step " + kind;
    let html = `<div class="step-headline">${escapeHtml(headline)}</div>`;
    if (extra.code) {
      html += `<details><summary>code</summary><pre class="output-pre">${escapeHtml(extra.code)}</pre></details>`;
    }
    if (extra.stdout) {
      html += `<details><summary>stdout (${extra.stdout.length} chars)</summary><pre class="output-pre">${escapeHtml(extra.stdout)}</pre></details>`;
    }
    if (extra.stderr) {
      html += `<details><summary>error / stderr</summary><pre class="output-pre stderr">${escapeHtml(extra.stderr)}</pre></details>`;
    }
    if (extra.details) {
      html += `<details><summary>details</summary><pre class="output-pre">${escapeHtml(extra.details)}</pre></details>`;
    }
    if (extra.extractedAnswer) {
      html += `<div class="muted small" style="margin-top:6px;"><strong>Extracted answer:</strong> <code>${escapeHtml(String(extra.extractedAnswer).slice(0, 400))}</code></div>`;
    }
    if (extra.validation && kind !== "ok") {
      html += `<div class="muted small">Validation: ${escapeHtml(extra.validation)}</div>`;
    }
    div.innerHTML = html;

    // (#5) Output files block
    if (Array.isArray(extra.files) && extra.files.length) {
      const filesBlock = document.createElement("div");
      filesBlock.style.marginTop = "8px";
      const inner = document.createElement("div");
      renderProducedFiles(inner, extra.files);
      filesBlock.appendChild(inner.firstElementChild ? inner : inner);
      filesBlock.innerHTML = inner.innerHTML;
      // Re-bind the click handlers since innerHTML wipes them
      const buttons = filesBlock.querySelectorAll("button");
      buttons.forEach((b, i) => b.addEventListener("click", () => downloadProducedFile(extra.files[i])));
      div.appendChild(filesBlock);
    }

    container.appendChild(div);
    div.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ============================================================
  // PACKAGES & FILES TAB (#4)
  // ============================================================
  function renderPackages() {
    const view = document.getElementById("labViewPackages");
    view.innerHTML = `
      <p class="muted small" style="margin-top: 0;">
        Install pip packages or upload local files into the in-browser Pyodide filesystem.
        Both packages and files persist for this dashboard session — reload the dashboard and
        they'll need to be re-added.
      </p>

      <div class="card" style="padding:12px;">
        <strong>Pip packages</strong>
        <div class="row" style="gap: 8px; margin-top:8px;">
          <input type="text" id="pkg_name" placeholder="package name (e.g. pandas)" style="flex: 1;" />
          <button class="primary" id="pkg_install">Install</button>
        </div>
        <div id="pkg_log" class="repair-log" style="margin-top: 12px;"></div>
      </div>

      <div class="card" style="padding:12px; margin-top:12px;">
        <strong>Files</strong>
        <p class="muted small" style="margin:4px 0 8px;">
          Upload <code>.py</code> modules (importable by name), <code>.csv</code> data files, or anything else.
          Files land at <code>/home/pyodide/work/&lt;name&gt;</code> and that directory is on <code>sys.path</code>,
          so a file uploaded as <code>helpers.py</code> can be imported with <code>import helpers</code>.
          Reference data files via the path shown below.
        </p>
        <div class="row" style="gap: 8px;">
          <input type="file" id="file_upload" multiple style="flex:1;" />
          <button class="ghost" id="file_refresh">Refresh</button>
        </div>
        <div id="file_list" style="margin-top: 12px;"></div>
      </div>
    `;

    const $ = (s) => view.querySelector(s);
    $("#pkg_install").addEventListener("click", async () => {
      const name = $("#pkg_name").value.trim();
      if (!name) return;
      appendStep(view.querySelector("#pkg_log"), "info", `Installing ${name}…`);
      const r = await window.PP_PYODIDE.execute({
        code: `print("OK: " + ${JSON.stringify(name)})`,
        packages: [name], freshNamespace: true, timeoutMs: 120000,
      });
      const errs = r.packages?.errors || [];
      if (errs.length) {
        appendStep(view.querySelector("#pkg_log"), "fail", `Install of ${name} failed`, { stderr: errs.map((e) => `${e.pkg}: ${e.error}`).join("\n") });
      } else {
        appendStep(view.querySelector("#pkg_log"), "ok", `Installed ${name}`, { stdout: r.stdout });
      }
    });
    $("#pkg_name").addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("#pkg_install").click();
    });

    $("#file_upload").addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const log = view.querySelector("#pkg_log");
      for (const f of files) {
        appendStep(log, "info", `Staging ${f.name} (${formatBytes(f.size)})…`);
        try {
          const r = await window.PP_PYODIDE.stageFile(f);
          if (r?.ok) {
            appendStep(log, "ok", `Staged at ${r.path}`);
          } else {
            appendStep(log, "fail", `Failed: ${r?.error || "unknown"}`);
          }
        } catch (err) {
          appendStep(log, "fail", `Failed: ${err?.message || err}`);
        }
      }
      e.target.value = "";
      await refreshStagedFiles();
    });

    $("#file_refresh").addEventListener("click", refreshStagedFiles);

    refreshStagedFiles();
  }

  async function refreshStagedFiles() {
    if (!window.PP_PYODIDE) return;
    try {
      const r = await window.PP_PYODIDE.listStagedFiles();
      STATE.stagedFiles = (r && r.files) || [];
    } catch {
      STATE.stagedFiles = [];
    }
    const list = document.getElementById("file_list");
    if (!list) return;
    if (!STATE.stagedFiles.length) {
      list.innerHTML = `<p class="muted small" style="margin:0;">No files staged yet.</p>`;
      return;
    }
    list.innerHTML = STATE.stagedFiles.map((f, i) => `
      <div class="row" style="justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line-2);">
        <div style="flex:1; min-width:0;">
          <div class="mono small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(f.path)}</div>
          <div class="muted small">${formatBytes(f.size || 0)} · use as: <code>${suggestUsage(f)}</code> <button class="ghost small" data-copy="${escapeAttr(f.path)}" style="padding:2px 6px; font-size:10px;">Copy path</button></div>
        </div>
        <button class="ghost" data-unstage="${i}">Remove</button>
      </div>
    `).join("");
    list.querySelectorAll("button[data-unstage]").forEach((b) => {
      b.addEventListener("click", async () => {
        const idx = Number(b.dataset.unstage);
        const f = STATE.stagedFiles[idx];
        if (!f) return;
        await window.PP_PYODIDE.unstageFile(f.path);
        await refreshStagedFiles();
      });
    });
    list.querySelectorAll("button[data-copy]").forEach((b) => {
      b.addEventListener("click", () => {
        navigator.clipboard?.writeText(b.dataset.copy).catch(() => {});
        b.textContent = "Copied!";
        setTimeout(() => (b.textContent = "Copy path"), 1200);
      });
    });
  }

  function suggestUsage(f) {
    const name = f.name || "";
    if (name.endsWith(".py")) {
      const mod = name.replace(/\.py$/, "");
      return `import ${mod}`;
    }
    if (name.endsWith(".csv")) return `pd.read_csv("${f.path}")`;
    if (name.endsWith(".json")) return `json.load(open("${f.path}"))`;
    return `open("${f.path}", "rb").read()`;
  }

  // ============================================================
  // HISTORY TAB
  // ============================================================
  function pushHistory(code, result) {
    STATE.runHistory.unshift({ at: Date.now(), code, result });
    if (STATE.runHistory.length > 50) STATE.runHistory.pop();
    renderHistory();
  }

  function renderHistory() {
    const view = document.getElementById("labViewHistory");
    if (!view) return;
    if (!STATE.runHistory.length) {
      view.innerHTML = `<p class="muted small">No runs yet.</p>`;
      return;
    }
    view.innerHTML = STATE.runHistory.map((h, i) => {
      const date = new Date(h.at).toLocaleTimeString();
      const ok = !h.result.error && !h.result.timedOut;
      return `
        <div class="card" style="margin-bottom: 8px; padding: 10px;">
          <div class="row" style="justify-content: space-between;">
            <strong>${date}</strong>
            <span class="pill ${ok ? "success" : "danger"}">${ok ? "ok" : (h.result.timedOut ? "timed out" : "error")}</span>
          </div>
          <details style="margin-top: 6px;"><summary>code (${h.code.length} chars)</summary><pre class="output-pre">${escapeHtml(h.code)}</pre></details>
          ${h.result.stdout ? `<details><summary>stdout</summary><pre class="output-pre">${escapeHtml(h.result.stdout)}</pre></details>` : ""}
          ${(h.result.stderr || h.result.error) ? `<details><summary>error</summary><pre class="output-pre stderr">${escapeHtml(h.result.error || "")}${escapeHtml(h.result.stderr || "")}</pre></details>` : ""}
          <button class="ghost" data-restore="${i}" style="margin-top: 6px;">Restore to editor</button>
        </div>
      `;
    }).join("");
    view.querySelectorAll("button[data-restore]").forEach((b) => {
      b.addEventListener("click", () => {
        STATE.code = STATE.runHistory[Number(b.dataset.restore)].code;
        renderEditor();
        switchTab("editor");
      });
    });
  }

  // ============================================================
  // Helpers
  // ============================================================
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
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  window.PP_CODE_LAB = { init };
})();
