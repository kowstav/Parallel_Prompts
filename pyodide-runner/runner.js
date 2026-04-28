// pyodide-runner/runner.js
// Loaded inside a hidden iframe from the dashboard. Loads Pyodide once, then
// answers execute requests via postMessage. The single interpreter is shared
// across runs (huge speedup), but each run gets a fresh `globals` namespace
// unless the caller asks otherwise.
//
// (#4) Supports staging user-uploaded files into the Pyodide virtual filesystem
//      before execution — see PYRUN_STAGE_FILE / `inputFiles` on PYRUN_EXECUTE.
//      The script can then `import` user-supplied python modules or open data
//      files using the absolute path returned by the bridge.
//
// (#5) After execution, scans /home/pyodide/work for files that did not exist
//      before the run and returns them as base64 + name + size. The dashboard
//      surfaces these as downloadable artifacts.

(function () {
  let pyodide = null;
  let pyodideReady = null;
  let installedPackages = new Set();

  // Files staged into the FS but persisted across runs.
  // Key: "/work/<basename>" -> { size, addedAt }
  const stagedFiles = new Map();

  // Working dir inside the Pyodide FS
  const WORK_DIR = "/home/pyodide/work";

  const statusEl = document.getElementById("status");
  const setStatus = (s) => { statusEl.textContent = s; };

  async function bootstrap() {
    if (pyodideReady) return pyodideReady;
    pyodideReady = (async () => {
      setStatus("Loading Pyodide runtime…");
      pyodide = await loadPyodide({
        indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/",
      });
      await pyodide.loadPackage("micropip");
      try { pyodide.FS.mkdirTree(WORK_DIR); } catch {}
      setStatus("Ready");
      return pyodide;
    })();
    return pyodideReady;
  }

  async function ensurePackages(pkgs) {
    if (!pkgs || !pkgs.length) return { ok: true, installed: [], errors: [] };
    const installed = [];
    const errors = [];
    const micropip = pyodide.pyimport("micropip");
    for (const p of pkgs) {
      const name = String(p).trim();
      if (!name || installedPackages.has(name)) {
        if (name) installed.push(name);
        continue;
      }
      try {
        try { await pyodide.loadPackage(name); }
        catch { await micropip.install(name); }
        installedPackages.add(name);
        installed.push(name);
      } catch (e) {
        errors.push({ pkg: name, error: String(e?.message || e) });
      }
    }
    return { ok: errors.length === 0, installed, errors };
  }

  // (#4) Stage a file into the Pyodide FS at WORK_DIR/<name>. Returns the
  // absolute path inside the FS that user code can pass to open()/pandas.read_csv()
  // /import statements (when staging .py modules add WORK_DIR to sys.path).
  async function stageFile({ name, data, isText = false }) {
    if (!pyodide) await bootstrap();
    const safeName = String(name || "file").replace(/[\/\\]/g, "_").slice(0, 200);
    const path = `${WORK_DIR}/${safeName}`;
    let bytes;
    if (isText) {
      bytes = new TextEncoder().encode(data);
    } else {
      const bin = atob(data);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    }
    pyodide.FS.writeFile(path, bytes);
    stagedFiles.set(path, { size: bytes.length, addedAt: Date.now() });
    return path;
  }

  function listStagedFiles() {
    const out = [];
    for (const [path, info] of stagedFiles.entries()) {
      out.push({ path, name: path.split("/").pop(), size: info.size, addedAt: info.addedAt });
    }
    return out;
  }

  function unstageFile(path) {
    try { pyodide.FS.unlink(path); } catch {}
    return stagedFiles.delete(path);
  }

  function snapshotWorkDir() {
    const snap = new Map();
    walkDir(WORK_DIR, (path, st) => { snap.set(path, st.size); });
    return snap;
  }

  function walkDir(dir, cb) {
    let names;
    try { names = pyodide.FS.readdir(dir); } catch { return; }
    for (const name of names) {
      if (name === "." || name === "..") continue;
      const full = `${dir}/${name}`;
      let st;
      try { st = pyodide.FS.stat(full); } catch { continue; }
      const mode = st.mode;
      const isDir = pyodide.FS.isDir(mode);
      if (isDir) walkDir(full, cb);
      else cb(full, st);
    }
  }

  function readFileAsBase64(path) {
    try {
      const data = pyodide.FS.readFile(path);
      let bin = "";
      for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
      return btoa(bin);
    } catch (e) {
      return null;
    }
  }

  async function execute({ code, packages = [], timeoutMs = 30000, freshNamespace = true, inputFiles = [], maxOutputBytes = 8 * 1024 * 1024 }) {
    if (!pyodide) await bootstrap();

    const pkgResult = await ensurePackages(packages);

    const stagedNow = [];
    for (const f of (inputFiles || [])) {
      try {
        const p = await stageFile(f);
        stagedNow.push({ path: p, name: p.split("/").pop() });
      } catch (e) {}
    }

    const before = snapshotWorkDir();

    let timedOut = false;
    let timer = null;

    const runner = `
import sys, os, io, traceback, json as _json
__pp_stdout = io.StringIO()
__pp_stderr = io.StringIO()
__pp_old_stdout, __pp_old_stderr = sys.stdout, sys.stderr
__pp_prev_cwd = os.getcwd()
sys.stdout, sys.stderr = __pp_stdout, __pp_stderr
try:
    os.makedirs(${JSON.stringify(WORK_DIR)}, exist_ok=True)
    os.chdir(${JSON.stringify(WORK_DIR)})
    if ${JSON.stringify(WORK_DIR)} not in sys.path:
        sys.path.insert(0, ${JSON.stringify(WORK_DIR)})
except Exception:
    pass
__pp_error = None
try:
${indentCode(code)}
except BaseException as __pp_e:
    __pp_error = "".join(traceback.format_exception(type(__pp_e), __pp_e, __pp_e.__traceback__))
finally:
    sys.stdout, sys.stderr = __pp_old_stdout, __pp_old_stderr
    try: os.chdir(__pp_prev_cwd)
    except Exception: pass

__pp_result = {
    "stdout": __pp_stdout.getvalue(),
    "stderr": __pp_stderr.getvalue(),
    "error": __pp_error,
}
__pp_result
`;

    try {
      const ns = freshNamespace ? pyodide.toPy({}) : pyodide.globals;
      const racePromise = pyodide.runPythonAsync(runner, { globals: ns });
      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve("__TIMEOUT__"); }, timeoutMs);
      });
      const out = await Promise.race([racePromise, timeoutPromise]);
      clearTimeout(timer);

      if (timedOut) {
        return {
          ok: false, timedOut: true,
          stdout: "", stderr: "",
          error: `Execution exceeded ${Math.round(timeoutMs / 1000)}s timeout`,
          packages: pkgResult, files: [], stagedFiles: stagedNow,
        };
      }

      const obj = out.toJs ? out.toJs({ dict_converter: Object.fromEntries }) : out;
      const stdout = (obj && obj.stdout) ?? "";
      const stderr = (obj && obj.stderr) ?? "";
      const error = (obj && obj.error) ?? null;
      try { out.destroy && out.destroy(); } catch {}
      try { ns.destroy && ns !== pyodide.globals && ns.destroy(); } catch {}

      // (#5) Diff the work dir to find new/modified files
      const after = snapshotWorkDir();
      const newFiles = [];
      let totalBytes = 0;
      for (const [path, size] of after.entries()) {
        if (stagedFiles.has(path) && before.has(path) && before.get(path) === size) continue;
        if (before.has(path) && before.get(path) === size) continue;
        if (totalBytes + size > maxOutputBytes) {
          newFiles.push({ name: path.split("/").pop(), path, size, truncated: true });
          continue;
        }
        const data = readFileAsBase64(path);
        if (data === null) continue;
        newFiles.push({ name: path.split("/").pop(), path, size, data });
        totalBytes += size;
      }

      return {
        ok: !error,
        timedOut: false,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error ? String(error) : null,
        packages: pkgResult,
        files: newFiles,
        stagedFiles: stagedNow,
        workDir: WORK_DIR,
      };
    } catch (e) {
      clearTimeout(timer);
      return {
        ok: false, timedOut: false,
        stdout: "", stderr: "",
        error: String(e?.message || e),
        packages: pkgResult, files: [], stagedFiles: stagedNow,
      };
    }
  }

  async function runValidator({ validatorCode, stdout, stderr }) {
    if (!validatorCode || !validatorCode.trim()) return { ok: true, passed: true, message: "no validator" };
    if (!pyodide) await bootstrap();
    try {
      const wrapped = `
import json as _json
${validatorCode}
__pp_v_result = validate(${JSON.stringify(stdout)}, ${JSON.stringify(stderr)}, None)
__pp_v_result
`;
      const out = await pyodide.runPythonAsync(wrapped);
      let passed = false, message = "";
      if (typeof out === "boolean") {
        passed = out; message = passed ? "validator returned True" : "validator returned False";
      } else if (typeof out === "string") {
        passed = out.length === 0;
        message = out;
      } else {
        passed = !!out;
        message = String(out ?? "");
      }
      try { out.destroy && out.destroy(); } catch {}
      return { ok: true, passed, message };
    } catch (e) {
      return { ok: false, passed: false, message: "Validator error: " + (e?.message || e) };
    }
  }

  function indentCode(code) {
    return String(code).split("\n").map((l) => "    " + l).join("\n");
  }

  // ----- postMessage protocol -----
  window.addEventListener("message", async (ev) => {
    const msg = ev.data || {};
    if (!msg || typeof msg !== "object") return;
    const reply = (payload) => ev.source.postMessage(payload, "*");

    if (msg.type === "PYRUN_PING") {
      reply({ type: "PYRUN_PONG", reqId: msg.reqId, ready: !!pyodide });
      return;
    }
    if (msg.type === "PYRUN_BOOTSTRAP") {
      try { await bootstrap(); reply({ type: "PYRUN_BOOTSTRAPPED", reqId: msg.reqId, ok: true }); }
      catch (e) { reply({ type: "PYRUN_BOOTSTRAPPED", reqId: msg.reqId, ok: false, error: String(e?.message || e) }); }
      return;
    }
    if (msg.type === "PYRUN_STAGE_FILE") {
      try {
        const path = await stageFile({ name: msg.name, data: msg.data, isText: !!msg.isText });
        reply({ type: "PYRUN_STAGED", reqId: msg.reqId, ok: true, path });
      } catch (e) {
        reply({ type: "PYRUN_STAGED", reqId: msg.reqId, ok: false, error: String(e?.message || e) });
      }
      return;
    }
    if (msg.type === "PYRUN_LIST_FILES") {
      reply({ type: "PYRUN_FILES_LIST", reqId: msg.reqId, files: listStagedFiles(), workDir: WORK_DIR });
      return;
    }
    if (msg.type === "PYRUN_UNSTAGE_FILE") {
      const ok = unstageFile(msg.path);
      reply({ type: "PYRUN_UNSTAGED", reqId: msg.reqId, ok });
      return;
    }
    if (msg.type === "PYRUN_EXECUTE") {
      try {
        await bootstrap();
        const result = await execute({
          code: msg.code || "",
          packages: msg.packages || [],
          timeoutMs: msg.timeoutMs ?? 30000,
          freshNamespace: msg.freshNamespace !== false,
          inputFiles: msg.inputFiles || [],
        });
        reply({ type: "PYRUN_RESULT", reqId: msg.reqId, ...result });
      } catch (e) {
        reply({ type: "PYRUN_RESULT", reqId: msg.reqId, ok: false, stdout: "", stderr: "", error: String(e?.message || e), packages: { installed: [], errors: [] }, files: [] });
      }
      return;
    }
    if (msg.type === "PYRUN_VALIDATE") {
      try {
        await bootstrap();
        const result = await runValidator({
          validatorCode: msg.validatorCode || "",
          stdout: msg.stdout || "",
          stderr: msg.stderr || "",
        });
        reply({ type: "PYRUN_VALIDATE_RESULT", reqId: msg.reqId, ...result });
      } catch (e) {
        reply({ type: "PYRUN_VALIDATE_RESULT", reqId: msg.reqId, ok: false, passed: false, message: String(e?.message || e) });
      }
      return;
    }
  });

  bootstrap().catch((e) => setStatus("Failed to load Pyodide: " + (e?.message || e)));

  try { window.parent.postMessage({ type: "PYRUN_HELLO" }, "*"); } catch {}
})();
