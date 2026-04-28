// shared/pyodide-bridge.js
// A small bridge that lives in the dashboard page. It injects a hidden iframe
// pointing at pyodide-runner/runner.html and exposes a Promise-based API for
// executing python and running validators. Reuses one Pyodide instance for
// the whole dashboard session.
//
// (#4) Adds file staging API: stageFile / listFiles / unstageFile so users can
//      upload local .py modules / .csv data files into the Pyodide FS.
// (#5) Execute now returns any files the run produced under WORK_DIR so the
//      caller can save them to the user's filesystem.
// (#11) applyCodeTemplate splices LLM code at [llm_response] / [llm_code].
// (#12) extractPythonCode uses a multi-strategy cascade; extractAnswer supports
//       special tokens (<bbox>, <json>, <number>, <final>) and arbitrary regex.

(function () {
  const BRIDGE = {
    iframe: null,
    iframeReady: false,
    waitingPosts: [],
    ready: false,
    bootstrapping: null,
    pending: new Map(),
  };

  let nextReqId = 1;

  function ensureIframe() {
    if (BRIDGE.iframe) return BRIDGE.iframe;
    const f = document.createElement("iframe");
    f.id = "pp-pyodide-runner";
    f.src = chrome.runtime.getURL("pyodide-runner/runner.html");
    f.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;";
    document.body.appendChild(f);
    BRIDGE.iframe = f;

    window.addEventListener("message", (ev) => {
      if (!ev.data || typeof ev.data !== "object") return;
      const m = ev.data;
      if (m.type === "PYRUN_HELLO") {
        BRIDGE.iframeReady = true;
        const q = BRIDGE.waitingPosts.slice();
        BRIDGE.waitingPosts.length = 0;
        for (const fn of q) try { fn(); } catch (e) { console.error(e); }
        return;
      }
      const slot = m.reqId ? BRIDGE.pending.get(m.reqId) : null;
      if (slot) {
        clearTimeout(slot.timer);
        BRIDGE.pending.delete(m.reqId);
        slot.resolve(m);
      }
    });
    return f;
  }

  function send(message, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const reqId = nextReqId++;
      const f = ensureIframe();
      const timer = setTimeout(() => {
        BRIDGE.pending.delete(reqId);
        reject(new Error("pyodide bridge timeout (" + Math.round(timeoutMs / 1000) + "s)"));
      }, timeoutMs);
      BRIDGE.pending.set(reqId, { resolve, reject, timer });

      const post = () => {
        try { f.contentWindow.postMessage({ ...message, reqId }, "*"); }
        catch (e) {
          BRIDGE.pending.delete(reqId);
          clearTimeout(timer);
          reject(e);
        }
      };
      if (BRIDGE.iframeReady) post();
      else BRIDGE.waitingPosts.push(post);
    });
  }

  async function bootstrap() {
    if (BRIDGE.ready) return true;
    if (BRIDGE.bootstrapping) return BRIDGE.bootstrapping;
    BRIDGE.bootstrapping = (async () => {
      const r = await send({ type: "PYRUN_BOOTSTRAP" }, 5 * 60 * 1000);
      if (!r.ok) throw new Error("Pyodide failed to load: " + (r.error || "unknown"));
      BRIDGE.ready = true;
      return true;
    })();
    return BRIDGE.bootstrapping;
  }

  async function execute({ code, packages, timeoutMs, freshNamespace, inputFiles } = {}) {
    await bootstrap();
    const totalTimeout = (timeoutMs || 30000) + 10000;
    const r = await send({
      type: "PYRUN_EXECUTE",
      code: code || "",
      packages: packages || [],
      timeoutMs: timeoutMs || 30000,
      freshNamespace: freshNamespace !== false,
      inputFiles: inputFiles || [],
    }, totalTimeout);
    return r;
  }

  async function validate({ validatorCode, stdout, stderr }) {
    await bootstrap();
    const r = await send({
      type: "PYRUN_VALIDATE",
      validatorCode: validatorCode || "",
      stdout: stdout || "",
      stderr: stderr || "",
    }, 30000);
    return r;
  }

  // ---- (#4) File staging ----
  async function stageFile(file) {
    await bootstrap();
    let payload;
    if (file && typeof file === "object" && "base64" in file) {
      payload = { name: String(file.name), base64: String(file.base64), mime: file.mime || "" };
    } else if (file && typeof file.arrayBuffer === "function") {
      const buf = await file.arrayBuffer();
      payload = { name: file.name, base64: arrayBufferToBase64(buf), mime: file.type || "" };
    } else {
      throw new Error("stageFile expects a File/Blob or {name, base64}");
    }
    return send({ type: "PYRUN_STAGE_FILE", file: payload }, 60000);
  }

  async function listStagedFiles() {
    await bootstrap();
    return send({ type: "PYRUN_LIST_FILES" }, 10000);
  }

  async function unstageFile(path) {
    await bootstrap();
    return send({ type: "PYRUN_UNSTAGE_FILE", path }, 10000);
  }

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // ---- (#12) Robust python extraction ----
  function extractPythonCode(text) {
    if (!text) return "";
    const s = String(text);

    // 1. ```python / ```py / ```py3 fenced blocks
    const pyFenceAll = [...s.matchAll(/```(?:python|py3?|ipython)\s*\n?([\s\S]*?)```/gi)].map((m) => m[1]);
    if (pyFenceAll.length) {
      pyFenceAll.sort((a, b) => b.length - a.length);
      return pyFenceAll[0].trim();
    }

    // 2. Generic ``` … ``` fences — pick longest pythonish one
    const anyFenceAll = [...s.matchAll(/```[\w-]*\s*\n?([\s\S]*?)```/g)]
      .map((m) => m[1])
      .filter((b) => looksLikePython(b));
    if (anyFenceAll.length) {
      anyFenceAll.sort((a, b) => b.length - a.length);
      return anyFenceAll[0].trim();
    }

    // 3. <code>…</code>
    const codeTagAll = [...s.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/gi)]
      .map((m) => decodeHtml(m[1]))
      .filter((b) => looksLikePython(b));
    if (codeTagAll.length) {
      codeTagAll.sort((a, b) => b.length - a.length);
      return codeTagAll[0].trim();
    }

    // 4. <pre>…</pre>
    const preAll = [...s.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)]
      .map((m) => decodeHtml(m[1].replace(/<[^>]+>/g, "")))
      .filter((b) => looksLikePython(b));
    if (preAll.length) {
      preAll.sort((a, b) => b.length - a.length);
      return preAll[0].trim();
    }

    // 5. Heuristic contiguous lines
    const lines = s.split(/\r?\n/);
    let runs = []; let cur = [];
    for (const ln of lines) {
      if (/^(\s{0,8})(import |from |def |class |if |for |while |try:|with |@|print\(|#|[a-zA-Z_][\w\.]*\s*=)/.test(ln) || /^\s+\S/.test(ln)) {
        cur.push(ln);
      } else if (ln.trim() === "" && cur.length) {
        cur.push(ln);
      } else {
        if (cur.length >= 3) runs.push(cur.join("\n"));
        cur = [];
      }
    }
    if (cur.length >= 3) runs.push(cur.join("\n"));
    runs = runs.filter(looksLikePython);
    if (runs.length) {
      runs.sort((a, b) => b.length - a.length);
      return runs[0].trim();
    }

    // 6. Fallback — whole text if it reads as python
    if (looksLikePython(s)) return s.trim();
    return "";
  }

  function looksLikePython(t) {
    if (!t) return false;
    return /\b(def |import |from |print\(|for |while |class |return |if |with |try:|except |@\w)/.test(t);
  }

  function decodeHtml(s) {
    return String(s)
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");
  }

  // (#11) Splice LLM code/answer into a user-defined template at [llm_response]
  function applyCodeTemplate(template, llmCode) {
    if (!template) return llmCode || "";
    const t = String(template);
    if (t.includes("[llm_response]")) return t.split("[llm_response]").join(llmCode || "");
    if (t.includes("[llm_code]"))     return t.split("[llm_code]").join(llmCode || "");
    return llmCode || "";
  }

  // (#12) Extract a user-defined "answer". Special tokens or regex.
  function extractAnswer(text, pattern) {
    if (!text) return "";
    const s = String(text);
    const p = String(pattern || "").trim();
    if (!p) return s.trim();

    if (p === "<bbox>") {
      const m = s.match(/\[\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\]/);
      return m ? m[0] : "";
    }
    if (p === "<json>") {
      const obj = matchBalanced(s, "{", "}");
      const arr = matchBalanced(s, "[", "]");
      if (obj && arr) return obj.start < arr.start ? obj.text : arr.text;
      return (obj || arr || { text: "" }).text;
    }
    if (p === "<number>") {
      const m = s.match(/-?\d+(?:\.\d+)?/);
      return m ? m[0] : "";
    }
    if (p === "<final>") {
      const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return lines.length ? lines[lines.length - 1] : "";
    }
    try {
      const re = new RegExp(p, "m");
      const m = s.match(re);
      if (!m) return "";
      return (m[1] !== undefined ? m[1] : m[0]).trim();
    } catch {
      return "";
    }
  }

  function matchBalanced(s, open, close) {
    const start = s.indexOf(open);
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === open) depth++;
      else if (s[i] === close) {
        depth--;
        if (depth === 0) return { start, text: s.slice(start, i + 1) };
      }
    }
    return null;
  }

  window.PP_PYODIDE = {
    bootstrap,
    execute,
    validate,
    stageFile,
    listStagedFiles,
    unstageFile,
    extractPythonCode,
    applyCodeTemplate,
    extractAnswer,
  };
})();
