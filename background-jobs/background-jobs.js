// background-jobs/background-jobs.js
// Background Jobs tab — CLOUD-BASED (rewritten).
//
// (#6) The previous version drove a local Python "helper" daemon over Chrome's
//      Native Messaging API. That has been replaced with a cloud-backed flow:
//      the user provides a backend endpoint they control (running on GCP / AWS
//      / Azure / Oracle / their own VPS) plus an API key. The extension does a
//      "test boot" against that endpoint first; once the user confirms the
//      result, selected jobs can be moved to the background.
//
// (#7) The UI also lists currently-running, pending and previously-failed jobs
//      with checkboxes so the user can move multiple jobs to the background at
//      once.
//
// IMPORTANT: this UI does NOT spin up cloud VMs from the browser directly —
// MV3 service workers can't safely sign AWS SigV4 / GCP IAM requests. Instead,
// the user runs a small companion service themselves and gives this UI its
// URL + key. The companion does the actual VM provisioning. We document this
// limitation prominently so users aren't misled.

(function () {
  const STATE = {
    root: null,
    creds: null,           // { provider, endpoint, apiKey, region, instanceType, ... }
    testing: false,
    testResult: null,      // { ok, message, latencyMs, ... } | null
    jobs: [],              // pulled from SW via JOBS_GET
    selectedJobIds: new Set(),
    statusFilter: "all",   // 'all' | 'running' | 'pending' | 'failed'
  };

  const PROVIDERS = [
    { id: "gcp",     label: "Google Cloud (GCE)",        regionPlaceholder: "us-central1",    instancePlaceholder: "e2-small" },
    { id: "aws",     label: "Amazon Web Services (EC2)", regionPlaceholder: "us-east-1",      instancePlaceholder: "t3.micro" },
    { id: "azure",   label: "Microsoft Azure (VM)",      regionPlaceholder: "eastus",         instancePlaceholder: "Standard_B1s" },
    { id: "oracle",  label: "Oracle Cloud (OCI)",        regionPlaceholder: "us-ashburn-1",   instancePlaceholder: "VM.Standard.E2.1.Micro" },
    { id: "other",   label: "Other / self-hosted",       regionPlaceholder: "—",              instancePlaceholder: "—" },
  ];

  function init(root) {
    STATE.root = root;
    render();
    bootstrap();
  }

  async function bootstrap() {
    await Promise.all([loadCreds(), loadJobs()]);
    render();
  }

  async function loadCreds() {
    try {
      const r = await chrome.runtime.sendMessage({ type: "CLOUD_GET" });
      STATE.creds = r?.creds || null;
    } catch {
      STATE.creds = null;
    }
  }

  async function loadJobs() {
    try {
      const r = await chrome.runtime.sendMessage({ type: "GET_JOBS" });
      const jobsObj = (r && r.jobs) || {};
      // The SW returns jobs as a map by id; flatten to array.
      STATE.jobs = Array.isArray(jobsObj) ? jobsObj : Object.values(jobsObj);
    } catch {
      STATE.jobs = [];
    }
  }

  // ============================================================
  // RENDER
  // ============================================================
  function render() {
    const view = STATE.root;
    if (!view) return;

    const configured = !!(STATE.creds && STATE.creds.endpoint);

    view.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content: space-between; align-items: flex-start;">
          <div>
            <h2 style="margin: 0 0 4px;">Background Jobs (Cloud)</h2>
            <p class="muted small" style="margin: 0;">
              Hand off jobs to a cloud VM you control so they keep running while your browser is closed.
            </p>
          </div>
          ${configured
            ? `<span class="pill success">Cloud configured</span>`
            : `<span class="pill">Not configured</span>`}
        </div>
      </div>

      <div class="card" style="margin-top: 14px;">
        <h3 style="margin: 0 0 6px;">How this works</h3>
        <p class="muted small" style="margin: 0 0 6px;">
          Provide an endpoint for a small companion service you run on your own cloud account
          (GCP / AWS / Azure / Oracle / your own server). The extension calls that endpoint to:
        </p>
        <ol style="margin: 0 0 0 18px; color: var(--text-2); font-size: 13px; line-height: 1.7;">
          <li>Boot a minimal VM on your cloud provider (your companion service handles the auth + provisioning).</li>
          <li>Run a <strong>test job</strong> first so you can verify it works before paying for a real run.</li>
          <li>Once you confirm, move selected jobs into the background — they continue even if you close Chrome.</li>
        </ol>
        <details style="margin-top: 8px;">
          <summary class="muted small">Why not boot the VM straight from the extension?</summary>
          <p class="muted small" style="margin: 6px 0 0;">
            Chrome MV3 service workers can't safely hold long-lived cloud-provider credentials,
            and signing AWS SigV4 / GCP IAM / Azure AD requests from a service worker is
            error-prone. A tiny companion service on your own host (a single Python or Node
            process behind an HTTPS endpoint, gated by an API key you generate) keeps your
            credentials out of the browser entirely.
          </p>
        </details>
      </div>

      <div id="bg_credsBox"></div>
      <div id="bg_testBox"></div>
      <div id="bg_jobsBox"></div>
    `;

    renderCredsBox();
    renderTestBox();
    renderJobsBox();
  }

  // -------- Credentials form --------
  function renderCredsBox() {
    const box = document.getElementById("bg_credsBox");
    const c = STATE.creds || {};
    box.innerHTML = `
      <div class="card" style="margin-top: 14px;">
        <h3 style="margin-top: 0;">Cloud credentials</h3>

        <div class="row wrap" style="gap: 10px;">
          <label style="flex: 1; min-width: 220px;">
            <span class="label-text">Provider</span>
            <select id="cl_provider">
              ${PROVIDERS.map((p) => `<option value="${p.id}" ${c.provider === p.id ? "selected" : ""}>${escapeHtml(p.label)}</option>`).join("")}
            </select>
          </label>
          <label style="flex: 2; min-width: 280px;">
            <span class="label-text">Companion endpoint URL</span>
            <input type="url" id="cl_endpoint" placeholder="https://your-companion.example.com" value="${escapeAttr(c.endpoint || "")}" />
          </label>
        </div>

        <div class="row wrap" style="gap: 10px; margin-top: 8px;">
          <label style="flex: 2; min-width: 280px;">
            <span class="label-text">API key (sent as <code>Authorization: Bearer …</code>)</span>
            <input type="password" id="cl_apiKey" placeholder="paste the secret your companion expects" value="${escapeAttr(c.apiKey || "")}" />
          </label>
          <label style="flex: 1; min-width: 160px;">
            <span class="label-text">Region</span>
            <input type="text" id="cl_region" placeholder="us-east-1" value="${escapeAttr(c.region || "")}" />
          </label>
          <label style="flex: 1; min-width: 160px;">
            <span class="label-text">Instance type</span>
            <input type="text" id="cl_instanceType" placeholder="t3.micro" value="${escapeAttr(c.instanceType || "")}" />
          </label>
        </div>

        <div class="row" style="gap: 8px; margin-top: 12px;">
          <button class="primary" id="cl_save">Save credentials</button>
          <button class="ghost" id="cl_clear">Clear</button>
          <span class="spacer"></span>
          <button class="ghost" id="cl_test">Test boot</button>
        </div>
      </div>
    `;

    const $ = (s) => box.querySelector(s);

    function readForm() {
      return {
        provider:     $("#cl_provider").value,
        endpoint:     $("#cl_endpoint").value.trim(),
        apiKey:       $("#cl_apiKey").value.trim(),
        region:       $("#cl_region").value.trim(),
        instanceType: $("#cl_instanceType").value.trim(),
      };
    }

    function syncPlaceholders() {
      const prov = PROVIDERS.find((p) => p.id === $("#cl_provider").value) || PROVIDERS[0];
      $("#cl_region").placeholder = prov.regionPlaceholder;
      $("#cl_instanceType").placeholder = prov.instancePlaceholder;
    }
    syncPlaceholders();
    $("#cl_provider").addEventListener("change", syncPlaceholders);

    $("#cl_save").addEventListener("click", async () => {
      const data = readForm();
      if (!data.endpoint) return alert("Endpoint is required.");
      try {
        new URL(data.endpoint);
      } catch {
        return alert("Endpoint must be a valid URL.");
      }
      const r = await chrome.runtime.sendMessage({ type: "CLOUD_SET", creds: data });
      if (r?.ok) {
        STATE.creds = data;
        render();
      } else {
        alert("Save failed: " + (r?.error || "unknown"));
      }
    });

    $("#cl_clear").addEventListener("click", async () => {
      if (!confirm("Clear stored cloud credentials?")) return;
      await chrome.runtime.sendMessage({ type: "CLOUD_CLEAR" });
      STATE.creds = null;
      STATE.testResult = null;
      render();
    });

    $("#cl_test").addEventListener("click", async () => {
      const data = readForm();
      if (!data.endpoint) return alert("Fill in the endpoint first.");
      // Save first so the SW has the latest creds
      await chrome.runtime.sendMessage({ type: "CLOUD_SET", creds: data });
      STATE.creds = data;
      STATE.testing = true;
      STATE.testResult = null;
      renderTestBox();
      try {
        const r = await chrome.runtime.sendMessage({ type: "CLOUD_TEST_BOOT" });
        STATE.testResult = r || { ok: false, message: "no response" };
      } catch (e) {
        STATE.testResult = { ok: false, message: e?.message || String(e) };
      }
      STATE.testing = false;
      renderTestBox();
    });
  }

  // -------- Test boot result --------
  function renderTestBox() {
    const box = document.getElementById("bg_testBox");
    if (!box) return;

    if (STATE.testing) {
      box.innerHTML = `
        <div class="card" style="margin-top: 14px;">
          <div class="row"><span class="dot running"></span><strong style="margin-left:8px;">Probing your companion endpoint…</strong></div>
        </div>
      `;
      return;
    }

    if (!STATE.testResult) {
      box.innerHTML = "";
      return;
    }

    const r = STATE.testResult;
    const success = !!r.ok;
    box.innerHTML = `
      <div class="card" style="margin-top: 14px;">
        <div class="row" style="justify-content: space-between;">
          <strong>Test boot result</strong>
          ${success
            ? `<span class="pill success">success</span>`
            : `<span class="pill danger">failed</span>`}
        </div>
        <p class="muted small" style="margin: 8px 0 0;">${escapeHtml(r.message || (success ? "Endpoint responded OK." : "Endpoint did not respond as expected."))}</p>
        ${typeof r.latencyMs === "number" ? `<p class="muted small" style="margin: 4px 0 0;">Latency: ${r.latencyMs} ms</p>` : ""}
        ${r.body ? `<details style="margin-top:8px;"><summary>Response body</summary><pre class="output-pre">${escapeHtml(typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2))}</pre></details>` : ""}
        ${success ? `
          <p class="muted small" style="margin: 12px 0 0;">
            Looks good. You can now move jobs to the background using the panel below.
            They will be sent to your companion at <code>${escapeHtml((STATE.creds?.endpoint || "") + "/jobs")}</code>.
          </p>
        ` : ""}
      </div>
    `;
  }

  // -------- Jobs list with multi-select --------
  function renderJobsBox() {
    const box = document.getElementById("bg_jobsBox");
    if (!box) return;

    const eligible = STATE.jobs.filter(jobIsEligibleForBackground);
    const filtered = filterJobs(eligible, STATE.statusFilter);

    box.innerHTML = `
      <div class="card" style="margin-top: 14px;">
        <div class="row" style="justify-content: space-between; align-items: flex-start;">
          <div>
            <h3 style="margin: 0 0 4px;">Move jobs to background</h3>
            <p class="muted small" style="margin: 0;">
              Pick currently-running, pending, or previously-failed jobs and hand them off
              to the cloud. Backgrounded jobs will continue if you close Chrome.
            </p>
          </div>
          <button class="ghost icon" id="bg_refreshJobs" title="Refresh">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 8a6 6 0 0 1 10.5-3.96M14 8a6 6 0 0 1-10.5 3.96"/>
              <path d="M12 1.5V5h-3.5M4 14.5V11h3.5"/>
            </svg>
          </button>
        </div>

        <div class="segmented" style="margin: 10px 0;">
          <label><input type="radio" name="bgFilter" value="all"     ${STATE.statusFilter === "all" ? "checked" : ""}/><span>All (${eligible.length})</span></label>
          <label><input type="radio" name="bgFilter" value="running" ${STATE.statusFilter === "running" ? "checked" : ""}/><span>Running</span></label>
          <label><input type="radio" name="bgFilter" value="pending" ${STATE.statusFilter === "pending" ? "checked" : ""}/><span>Pending</span></label>
          <label><input type="radio" name="bgFilter" value="failed"  ${STATE.statusFilter === "failed" ? "checked" : ""}/><span>Failed / Errored</span></label>
        </div>

        <div id="bg_jobList"></div>

        <div class="row" style="gap: 8px; margin-top: 12px;">
          <button class="primary" id="bg_moveSelected" ${STATE.selectedJobIds.size && STATE.testResult?.ok ? "" : "disabled"}>
            Move ${STATE.selectedJobIds.size} job${STATE.selectedJobIds.size === 1 ? "" : "s"} to background
          </button>
          <span class="muted small" style="align-self:center;">
            ${!STATE.testResult?.ok ? "Run a successful test boot first." : ""}
          </span>
        </div>
      </div>
    `;

    const list = box.querySelector("#bg_jobList");
    if (!filtered.length) {
      list.innerHTML = `<p class="muted small" style="margin:0;">No matching jobs.</p>`;
    } else {
      list.innerHTML = filtered.map((j) => {
        const status = (j.status || "").toLowerCase();
        const checked = STATE.selectedJobIds.has(j.id);
        return `
          <label class="row" style="align-items:flex-start; gap:10px; padding:8px 0; border-bottom:1px solid var(--line-2); cursor: pointer;">
            <input type="checkbox" data-jobid="${escapeAttr(j.id)}" ${checked ? "checked" : ""} style="margin-top:3px;"/>
            <div style="flex:1; min-width:0;">
              <div class="row" style="justify-content:space-between;">
                <strong>${escapeHtml(j.name || "(untitled)")}</strong>
                <span class="pill ${pillClassFor(status)}">${escapeHtml(j.status || "unknown")}</span>
              </div>
              <div class="muted small" style="margin-top: 2px;">
                ${escapeHtml(j.llm || "?")} · ${j.rows?.length || 0} rows
                ${j.runMode === "background" ? ` · <em>already in background</em>` : ""}
              </div>
            </div>
          </label>
        `;
      }).join("");

      list.querySelectorAll('input[type="checkbox"][data-jobid]').forEach((cb) => {
        cb.addEventListener("change", (e) => {
          const id = e.target.dataset.jobid;
          if (e.target.checked) STATE.selectedJobIds.add(id);
          else STATE.selectedJobIds.delete(id);
          renderJobsBox(); // re-render to update the count on the move button
        });
      });
    }

    // Filter
    box.querySelectorAll('input[name="bgFilter"]').forEach((r) => {
      r.addEventListener("change", (e) => {
        STATE.statusFilter = e.target.value;
        renderJobsBox();
      });
    });

    // Refresh
    box.querySelector("#bg_refreshJobs")?.addEventListener("click", async () => {
      await loadJobs();
      // Drop any selected ids that no longer exist
      const ids = new Set(STATE.jobs.map((j) => j.id));
      [...STATE.selectedJobIds].forEach((id) => { if (!ids.has(id)) STATE.selectedJobIds.delete(id); });
      renderJobsBox();
    });

    // Move action
    box.querySelector("#bg_moveSelected")?.addEventListener("click", async () => {
      if (!STATE.selectedJobIds.size) return;
      if (!STATE.testResult?.ok) return alert("Run a successful test boot first.");
      const ids = [...STATE.selectedJobIds];
      const btn = box.querySelector("#bg_moveSelected");
      btn.disabled = true;
      btn.textContent = "Moving…";
      const results = [];
      for (const id of ids) {
        try {
          const r = await chrome.runtime.sendMessage({ type: "MOVE_JOB_TO_BACKGROUND", jobId: id });
          results.push({ id, ok: !!r?.ok, message: r?.message || r?.error || "" });
        } catch (e) {
          results.push({ id, ok: false, message: e?.message || String(e) });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      alert(`Moved ${okCount} job${okCount === 1 ? "" : "s"} to background.${failCount ? `\n${failCount} failed:\n` + results.filter((r) => !r.ok).map((r) => `  · ${r.id}: ${r.message}`).join("\n") : ""}`);
      STATE.selectedJobIds.clear();
      await loadJobs();
      renderJobsBox();
    });
  }

  // ============================================================
  // Helpers
  // ============================================================
  function jobIsEligibleForBackground(j) {
    const status = (j.status || "").toLowerCase();
    // Eligible: running / pending / paused / errored / partially-failed.
    // Not eligible: completed jobs.
    if (status === "completed" || status === "done") return false;
    if (j.runMode === "background") return false;  // already there
    return true;
  }

  function filterJobs(jobs, filter) {
    if (filter === "all") return jobs;
    return jobs.filter((j) => {
      const s = (j.status || "").toLowerCase();
      if (filter === "running") return s === "running" || s === "active";
      if (filter === "pending") return s === "pending" || s === "queued" || s === "scheduled" || s === "paused" || s === "idle" || s === "draft";
      if (filter === "failed")  return s === "error" || s === "errored" || s === "failed" || s.includes("error");
      return true;
    });
  }

  function pillClassFor(status) {
    if (!status) return "";
    const s = status.toLowerCase();
    if (s === "running" || s === "active") return "success";
    if (s === "completed" || s === "done") return "success";
    if (s.includes("error") || s === "failed") return "danger";
    return "";
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  window.PP_BG_JOBS = { init };
})();
