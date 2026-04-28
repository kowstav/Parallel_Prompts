#!/usr/bin/env python3
"""
Parallel Prompts — Local Helper Daemon & Native Python Executor

Features:
1. Executes Python scripts in isolated temp directories (Native Code Execution).
2. Manages the SQLite-backed background job queue.
"""

import json
import struct
import sys
import sqlite3
import tempfile
import subprocess
import os
from pathlib import Path

VERSION = "0.2.0"
CAPABILITIES = ["ping", "execute_python", "queue_status"]

# Setup persistent background SQLite queue
DB_PATH = Path.home() / ".parallel_prompts.sqlite"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute('''CREATE TABLE IF NOT EXISTS jobs
                    (id TEXT PRIMARY KEY, status TEXT, config TEXT, created_at INTEGER)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS executions
                    (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, row_idx INTEGER, status TEXT)''')
    conn.commit()
    return conn

def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    n = struct.unpack("<I", raw_len)[0]
    body = sys.stdin.buffer.read(n)
    if not body:
        return None
    return json.loads(body.decode("utf-8"))

def send_message(obj):
    body = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()

def handle(req):
    t = req.get("type")
    
    if t == "ping":
        return {"version": VERSION, "capabilities": CAPABILITIES}
        
    if t == "queue_status":
        try:
            conn = init_db()
            c = conn.cursor()
            c.execute("SELECT COUNT(*) FROM jobs")
            jobs_count = c.fetchone()[0]
            c.execute("SELECT COUNT(*) FROM executions")
            exec_count = c.fetchone()[0]
            return {"ok": True, "jobs": jobs_count, "executions": exec_count}
        except Exception as e:
            return {"ok": False, "error": str(e)}
            
    if t == "execute_python":
        code = req.get("code", "")
        timeout = req.get("timeout", 30)
        
        # Create an isolated workspace for this run
        with tempfile.TemporaryDirectory(prefix="pp_workspace_") as tmpdir:
            script_path = os.path.join(tmpdir, "main.py")
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(code)
            
            try:
                # Execute user's local python
                res = subprocess.run(
                    [sys.executable, script_path],
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                    cwd=tmpdir
                )
                return {
                    "ok": res.returncode == 0,
                    "stdout": res.stdout,
                    "stderr": res.stderr,
                    "error": None if res.returncode == 0 else f"Process exited with code {res.returncode}"
                }
            except subprocess.TimeoutExpired:
                return {"ok": False, "stdout": "", "stderr": "", "error": f"Execution exceeded {timeout}s timeout"}
            except Exception as e:
                return {"ok": False, "stdout": "", "stderr": "", "error": str(e)}

    return {"error": "unknown_request", "got": t}

def main():
    while True:
        try:
            req = read_message()
        except Exception as e:
            send_message({"error": f"read_failed: {e}"})
            return
        if req is None:
            return
        try:
            send_message(handle(req))
        except Exception as e:
            send_message({"error": str(e)})

if __name__ == "__main__":
    init_db()  # Ensure DB exists on boot
    main()