# Parallel Prompts — Features & Usage

A Chrome extension (Manifest V3) that drives web LLM chat sites (ChatGPT, Claude,
Gemini, Google AI Studio, DeepSeek, Qwen, Perplexity, Copilot, Grok) row-by-row
from a CSV — or from prompts you type directly — capturing each response back to
a CSV column. Supports parallel chats, per-row LLM selection, rate-limit
detection, automatic Claude "Continue", and more.

---

## Table of contents

1. [Install](#install)
2. [Two ways to interact: popup + dashboard](#two-ways-to-interact-popup--dashboard)
3. [Two ways to provide prompts: CSV upload + Prompt Stacker](#two-ways-to-provide-prompts-csv-upload--prompt-stacker)
4. [Distribution modes](#distribution-modes)
5. [Model & version selection (numeric, 1–6)](#model--version-selection-numeric-1-6)
6. [Thinking / reasoning toggle](#thinking--reasoning-toggle)
7. [Per-row LLM column format](#per-row-llm-column-format)
8. [Existing tabs vs new tabs](#existing-tabs-vs-new-tabs)
9. [Open a new chat per row](#open-a-new-chat-per-row)
10. [Optional system prompt](#optional-system-prompt)
11. [Row range (start at / end at)](#row-range-start-at--end-at)
12. [Edit, insert, and delete rows](#edit-insert-and-delete-rows)
13. [Gemini account number](#gemini-account-number)
14. [AI Studio (Google)](#ai-studio-google)
15. [Rate-limit / model-switch / login detection](#rate-limit--model-switch--login-detection)
16. [Mid-generation interruption recovery](#mid-generation-interruption-recovery)
17. [Claude auto-Continue](#claude-auto-continue)
18. [Free vs paid tier awareness](#free-vs-paid-tier-awareness)
19. [Job lifecycle: pause / resume / restart / delete](#job-lifecycle-pause--resume--restart--delete)
20. [Live progress & details modal](#live-progress--details-modal)
21. [CSV export](#csv-export)
22. [Advanced settings](#advanced-settings)
23. [Supported LLMs](#supported-llms)
24. [Architecture overview](#architecture-overview)
25. [Caveats & troubleshooting](#caveats--troubleshooting)

---

## Install

1. Unzip `parallel-prompts.zip`.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked**, pick the `parallel-prompts/` folder.
5. The toolbar gets a violet "PP" icon.

After loading: log into each LLM you plan to use in normal Chrome tabs first.

---

## Two ways to interact: popup + dashboard

Click the toolbar icon → a compact **popup** opens (400×600). It has the same UI
as the full dashboard but laid out densely. For longer-running work, click the
diagonal-arrow expand button in the popup's top right — this opens the
**dashboard** in a full Chrome tab and closes the popup. You can use either at
any time; jobs are shared.

---

## Two ways to provide prompts: CSV upload + Prompt Stacker

In the **+ New job** tab there's a "Prompt source" segmented control:

- **Upload CSV** — pick a `.csv` file. The first row is treated as headers. The
  extension auto-detects which column is your prompt column (looks for
  `prompt`, `question`, `input`, `text`, or `query` in the header) and which is
  a model column (looks for `model`, `llm`, or `version`).

- **Stack prompts manually** ("Prompt Stacker") — no file needed. You get a
  starter table with a `prompt` column (and a `model` column if distribution is
  per-row). Click into any cell to type. Hit Enter to jump to the same column
  in the next row. Use:
  - **+** at the end of a row to insert an empty row below it
  - **× ** at the end of a row to delete it
  - **+ Add row** above the table to append at the end
  - **+col** in the header row to add a new column
  - Click any column header to **rename it** (Enter to commit)

Whichever method you pick, all the same downstream features apply.

---

## Distribution modes

A segmented control with three options:

### Single chat
One tab. Rows run sequentially in the same conversation, so the LLM sees prior
prompts/answers as context.

### Parallel chats (same LLM)
A slider sets how many tabs of the chosen LLM to open (2–8). Rows are split
between them, so several prompts run at once.

### Per-row LLM column
A column in your CSV says which LLM (and which model) handles each row. The
extension opens one tab per unique LLM/model combination and routes rows to
matching tabs. See [Per-row LLM column format](#per-row-llm-column-format).

---

## Model & version selection (numeric, 1–6)

LLM sites rename their models constantly (e.g. "Gemini 3 Pro" → "Gemini 3.1
Pro Preview"). Hardcoding model names breaks. So instead of a dropdown of
specific models, you specify a **numeric index 1–6**:

- **0** = whatever model is currently selected on the site (ideal for free
  users who can't change models anyway — recommended default)
- **1** = first item in the site's model dropdown
- **2** = second item
- … up to **6**

The extension opens the LLM's actual model picker at runtime and clicks the
N-th item. If the picker isn't visible (e.g. because the site no longer
exposes one for free users), the extension logs the issue and continues with
whatever's currently selected — it never fails the prompt.

---

## Thinking / reasoning toggle

A separate checkbox (single mode) or `thinking` keyword (per-row mode) toggles
the LLM's reasoning mode where it exists:

| LLM | What gets toggled |
|---|---|
| ChatGPT | "Think" / reasoning button |
| Claude | "Extended thinking" |
| Gemini | "Deep Research" / Deep Think |
| DeepSeek | DeepThink (R1) |
| Qwen | "Thinking" |
| Perplexity | Pro Search / Reason |
| Copilot | Think Deeper |
| Grok | Think |

If the site doesn't expose a thinking toggle, the option is silently a no-op.

---

## Per-row LLM column format

In per-row distribution, each row's `model` column tells the extension which
LLM and model to use. Format: `llm number [thinking]`.

Examples:

```
claude 1
chatgpt 2 thinking
gemini 3
aistudio 1
deepseek 1 reason
qwen 2
perplexity 0
grok 4 think
```

- **llm**: one of `chatgpt`, `claude`, `gemini`, `aistudio`, `deepseek`,
  `qwen`, `perplexity`, `copilot`, `grok` (case-insensitive). Separators
  between fields can be space, colon, slash, hyphen, or underscore — all of
  these work: `claude 1`, `claude:1`, `claude/1`, `claude_1`, `claude-1`.
- **number**: 1–6, or 0 / blank for "use whatever's selected".
- **thinking** (optional): the word `thinking`, `think`, `reason`,
  `reasoning`, `deepthink`, or `extended` enables reasoning mode for that row.

If the cell only contains an LLM name (e.g. `claude`), the extension uses
model index 0 (default selection) and thinking off.

---

## Existing tabs vs new tabs

For single and parallel modes, a "Tab source" segmented control lets you pick:

- **Open new tabs** (default) — the extension opens one or more new tabs and
  navigates them to the LLM's new-chat URL.
- **Use already-open tabs** — a dropdown lists every open tab matching the
  selected LLM. Pick one (single mode) or one per slot (parallel mode). Click
  the ↻ refresh button if you've just opened a new LLM tab and want it to
  appear.

This is useful when:
- You already have a logged-in tab with custom instructions configured.
- You want to reuse an in-progress conversation.
- You're testing locally and don't want a new tab spawned every time.

Per-row mode always opens new tabs (it can need many).

---

## Open a new chat per row

By default, all rows assigned to one tab run inside the same conversation. If
you want each row to start fresh (no shared context), enable "Open a new chat
for every row":

- **Single mode**: one option, "Open a new chat for every row". The single tab
  navigates to the LLM's `/new` URL between every prompt. Past chats remain in
  the LLM's sidebar — you only get a fresh empty thread for each row.
- **Parallel mode**: each of the N tabs navigates to a fresh chat URL between
  rows.
- **Per-row mode**: with this enabled, the extension creates one tab per
  unique **LLM** (instead of one per unique LLM/model combo) and navigates
  that tab between rows, switching the model index in the URL where supported
  (e.g. AI Studio).

Bear in mind that opening a new chat per row is slower (a navigation + content
script reload between every prompt).

---

## Optional system prompt

A "Optional prompt" textarea with a 4-way segmented control:

- **None** — no system prompt; CSV prompts go through verbatim.
- **Send first** — the optional prompt is sent as the *first* message in the
  conversation; subsequent CSV rows follow as new messages. Useful for
  setting up persona/instructions you want the LLM to remember.
- **Prefix every prompt** — prepended (with two newlines as separator) to
  every CSV prompt sent.
- **Suffix every prompt** — appended to every CSV prompt.

The textarea handles multiline content correctly — newlines are preserved and
sent as-is to the LLM (this was a fix; older versions truncated at the first
newline).

---

## Row range (start at / end at)

Above the row preview:

- **Start at row** — rows before this number are excluded from the run.
- **End at row** — rows after this number are excluded. Leave blank for "no
  end limit".

Excluded rows show with strikethrough and disabled checkboxes. They behave
like skipped rows internally.

---

## Edit, insert, and delete rows

- **Edit any cell**: click into it. The cell becomes a text editor. Tab moves
  to the next cell; Enter commits and moves to the same column in the next
  row. Editing works for both uploaded CSVs and stacker mode.
- **Insert row below**: the **+** button on the right of any row. Indices
  shift correctly (skipped rows, end-row pointer all stay consistent).
- **Delete row**: the **×** button on the right.
- **Append row**: "+ Add row" button above the table.
- **Add column** (stacker only): the "+col" button in the header row.
- **Rename column** (stacker only): click any column header.

---

## Gemini account number

Gemini lives under per-account paths like `https://gemini.google.com/u/1/app`
when you're signed into multiple Google accounts. There's an optional
"Gemini account number" input — when set, the extension navigates to
`/u/{number}/app` instead of `/app`. Useful if your work and personal Google
accounts both have Gemini access.

This applies equally to AI Studio, which always uses `/u/{N}/` paths.

---

## AI Studio (Google)

`https://aistudio.google.com/` is supported as a separate LLM — its quota is
distinct from gemini.google.com, so you can mix both in a per-row job.

AI Studio's models are URL-driven (the model is in `?model=…`), so the
extension encodes them in the URL it opens:

| Model number | Slug | Label |
|---|---|---|
| 1 | `gemini-3-flash-preview` | Gemini 3 Flash (preview) |
| 2 | `gemini-3.1-pro-preview` | Gemini 3.1 Pro (preview) |
| 3 | `gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite (preview) |

Examples:

- Single mode, AI Studio + model 2 → opens
  `https://aistudio.google.com/u/{user}/prompts/new_chat?model=gemini-3.1-pro-preview`
- Per-row cell `aistudio 3` → opens
  `https://aistudio.google.com/u/{user}/prompts/new_chat?model=gemini-3.1-flash-lite-preview`

The Gemini account number applies here too (default is 1).

---

## Rate-limit / model-switch / login detection

The content script scans the page text after each generation for known
patterns per LLM. Three categories:

- **rate_limit** — the site says you've hit a usage cap (e.g. ChatGPT "you've
  reached our limit of messages", Gemini "you've reached your daily quota",
  Claude "message limit reached", AI Studio "resource exhausted", etc.)
- **model_switch** — the site silently downgraded you (e.g. "switched to
  GPT-4o-mini", "upgrade to Gemini Advanced") or your selected model is
  unavailable.
- **login** — the site shows a login wall.

When any of these is detected, the job is **paused** with a clear error
message naming the LLM and the issue. You decide what to do (wait, switch
account, upgrade, etc.) and click Resume.

---

## Mid-generation interruption recovery

If a rate-limit banner appears *during* generation, the partial response so
far is captured and saved into the CSV with an `[INTERRUPTED]` prefix. When
you resume the job, the row is in `interrupted` state and the
"On interrupt resume" advanced setting controls what happens:

- **Resume that row** (default) — re-asks the same prompt, overwriting the
  partial.
- **Skip to next row** — keeps the partial response, marks the row done, and
  moves on.

---

## Claude auto-Continue

Claude often stops mid-response with "Continue" buttons when it hits length
limits. With **autoContinueClaude** enabled (default ON, only visible when
Claude is part of the configuration):

- The content script detects the Continue button or "response was cut off"
  text.
- It clicks Continue automatically, or types `Continue` and hits send if
  there's no button.
- The full response is concatenated into one cell.
- A configurable cap (`Max Claude continues per row`, default 5) prevents
  infinite loops.

---

## Free vs paid tier awareness

Each model in the registry has a `tier: "free" | "paid"` field. The model
dropdown labels paid models with " · paid". Rate-limit signatures distinguish
"free messages exhausted" (a true rate limit) from "downgraded to a smaller
model" (a model_switch). When paused, the error message tells you which
happened so you can react appropriately.

---

## Job lifecycle: pause / resume / restart / delete

Each job card shows the current status (idle / running / paused / done /
error) and exposes:

- **▶ Start / Resume** — begin or continue from where it stopped.
- **⏸ Pause** — stop after the current in-flight prompt completes.
- **↻ Run again** — appears when a job is "done"; resets all rows to pending
  and starts over (preserves the CSV in case you want to overwrite previous
  responses).
- **⬇ Download CSV** — save the current state as a CSV at any time.
- **⋯ Details** — opens a modal with worker info and per-row status.
- **Delete** — removes the job entirely (confirmation prompt).

Jobs persist across browser sessions. If you close Chrome mid-run, when you
re-open it the job will be in `paused` state — click Resume.

---

## Live progress & details modal

Each job card shows:

- An **animated progress bar** (with a moving shine when running)
- Counts: done, in_progress, failed, interrupted, skipped
- **Worker chips** showing each tab: status dot (idle/running/paused/error),
  LLM name, model number, thinking flag, currently-processing row
- An error banner if the job is in error/paused state

The details modal (⋯ button) shows:

- Per-worker breakdown with tab IDs and last error
- The first 100 rows with their status, prompt snippet, and response snippet

The dashboard polls every 4 seconds, and pushes live updates from the SW
whenever progress events fire.

---

## CSV export

The "⬇ Download CSV" button is available at any time — even mid-run. It uses
PapaParse's `unparse` to serialize the current `headers` + `rows` to standard
CSV, including:

- The original columns
- The added response column (with `[INTERRUPTED]` or `[ERROR]` prefixes
  where applicable)
- Any inserted/edited rows

---

## Advanced settings

Collapsed by default. Inside:

- **Delay between prompts** (0–20 s slider, default 3 s) — wait time after
  each prompt completes before sending the next. Lower invites rate limits.
- **Per-response timeout** (0–600 s slider, default 240 s) — how long to wait
  for a single response before treating it as failed. (Set to 0 to disable
  the timeout.)
- **On error, write [ERROR] and continue** (default ON) — if false, an error
  pauses the job instead of moving on.
- **Claude: auto-press Continue if response is cut off** (only when Claude
  is selected) — see [Claude auto-Continue](#claude-auto-continue).
- **Max Claude continues per row** (default 5)
- **On interrupt, when resuming** (segmented: Resume / Skip)

---

## Supported LLMs

| ID | Label | URL |
|---|---|---|
| `chatgpt` | ChatGPT | https://chatgpt.com/ |
| `claude` | Claude | https://claude.ai/new |
| `gemini` | Gemini | https://gemini.google.com/app |
| `aistudio` | AI Studio (Gemini) | https://aistudio.google.com/ |
| `deepseek` | DeepSeek | https://chat.deepseek.com/ |
| `qwen` | Qwen | https://chat.qwen.ai/ |
| `perplexity` | Perplexity | https://www.perplexity.ai/ |
| `copilot` | Copilot | https://copilot.microsoft.com/ |
| `grok` | Grok | https://grok.com/ |

---

## Architecture overview

```
┌────────────────────┐
│ popup / dashboard  │  shared/app.js — UI, job CRUD, CSV preview, edits
└─────────┬──────────┘
          │ chrome.runtime.sendMessage
          ▼
┌────────────────────┐
│ service worker     │  background/service-worker.js
│  - job state       │  - persistence (chrome.storage.local)
│  - workers         │  - tab opening / navigation
│  - rate-limit      │  - content-script injection
│    handling        │
└─────────┬──────────┘
          │ chrome.tabs.sendMessage(tabId, RUN_PROMPT, …)
          ▼
┌────────────────────┐
│ content script     │  content/content.js
│  - per-LLM         │  - text insertion (paste-event-first)
│    adapters        │  - send button / Enter
│  - rate-limit      │  - response polling
│    detection       │  - Claude continue
└────────────────────┘
```

**Files:**

- `manifest.json` — MV3 config; permissions, host permissions, content
  scripts, popup, web-accessible resources
- `background/service-worker.js` — orchestration: jobs, workers, persistence,
  tab management, message routing
- `content/content.js` — per-LLM page driver: input setting, send, response
  polling, rate-limit detection, Claude continue
- `shared/llms.js` — central registry of supported LLMs, their models, and
  rate-limit signatures (loaded by SW + dashboard, not content script)
- `shared/app.js` — UI for both popup + dashboard (single source of truth,
  CSS class on body controls layout)
- `shared/app.css` — modern dark theme, gradient accents, animated progress,
  segmented controls, sliders, custom scrollbars, etc.
- `popup/popup.html` + `popup.css` + `popup.js` — popup-mode boot
- `dashboard/dashboard.html` + `dashboard.css` + `dashboard.js` —
  dashboard-mode boot
- `lib/papaparse.min.js` — CSV parser/serializer
- `icons/` — 16/48/128 px logo

**Job state shape:**

```javascript
{
  id, name, status, error, createdAt,
  csv: { headers, rows, promptColumn, modelColumn },
  responseColumn, rowFromIndex, rowToIndex, skipped,
  distribution, parallelCount,
  primaryLlm, primaryModelIndex, primaryThinking,
  perRowNewChat, parallelNewChat, singleNewChat,
  geminiUserNumber, optionalPrompt: { mode, text },
  existingTabIds,
  settings: {
    delayBetweenPromptsMs, perResponseTimeoutMs, retryOnError,
    overwrite, autoContinueClaude, maxContinues, onInterruptResume
  },
  workers: { workerId: { llm, modelIndex, thinking, tabId, status, ... } },
  rowState: { rowIdx: { status, partialText, attempts, ... } }
}
```

---

## Caveats & troubleshooting

- **Selectors break when LLM sites redesign their UI.** Adapter selectors in
  `content/content.js` are best-effort. If a particular LLM stops working,
  open DevTools on its tab during a job — `[PP]` log lines tell you which
  step is failing (input not found, send button disabled, etc.) — and update
  that adapter's selectors.

- **Always log in to each LLM first** in a regular Chrome tab before running
  jobs. The extension can't drive a login flow.

- **Use a modest delay**. The default 3-second pause between prompts is
  conservative; lower it carefully. Below 1 second you'll quickly hit rate
  limits.

- **Model picker selectors are best-effort.** If `pickNthModel` fails (the
  site's dropdown selector changed), the prompt still runs with whatever
  model is currently selected on the site — set the model manually in the
  tab once if you need a specific one.

- **AI Studio adapter is preview-grade.** AI Studio's UI uses many custom
  elements (`<ms-prompt-input>`, `<ms-chat-turn>`, `<run-button>`); the
  selectors target their current DOM but may need adjustment as the site
  evolves.

- **The popup is 400 px wide.** Long content like CSV preview tables
  scrolls horizontally; for serious work, click the expand button to
  switch to the dashboard.

- **DevTools is your friend.** All adapters log their actions under the
  `[PP]` prefix: `Found input element`, `Inserted prompt, length: N`,
  `Send button: <button…>`, `Generation started: true`, `Got final response,
  length: N`. Open the LLM tab's DevTools console during a job to see
  exactly what's happening.

- **CSP / inline scripts.** Manifest V3 forbids inline `<script>` blocks in
  extension pages. All boot code lives in separate `.js` files
  (`popup/popup.js`, `dashboard/dashboard.js`).

---

# Local Code Execution & Agent Loop (Phase 1)

The extension can now **execute Python locally** on the user's machine, with
zero install required for the basic mode. Three new capabilities sit on top
of the existing prompt-runner:

1. **Code Lab** — a notebook-style tab for writing and running Python ad-hoc.
2. **Agent loop in jobs** — for any prompt job, automatically extract Python
   from each LLM response, execute it locally, validate the result, and
   (optionally) feed errors back to the LLM until the code works.
3. **Background Jobs** — UI scaffolding for an optional native helper that
   runs jobs while Chrome is closed. The helper itself ships separately
   under `helper/` and is documented in `helper/README.md`.

Everything stays on the user's machine. The Pyodide runtime lives in a hidden
iframe inside the dashboard; nothing is uploaded anywhere.

---

## The Pyodide engine

[Pyodide](https://pyodide.org/) is CPython compiled to WebAssembly. It runs
inside the browser, sandboxed by Chrome's process isolation. The extension
loads Pyodide v0.26.4 from the official CDN
(`https://cdn.jsdelivr.net/pyodide/`) into a hidden iframe. After the first
load, the runtime is cached for the rest of the dashboard session — re-runs
are fast.

Architecture:

```
┌───────────────┐     postMessage      ┌────────────────────┐
│   dashboard   │ ───────────────────► │  hidden iframe     │
│  (app.js,     │ ◄─────────────────── │  pyodide-runner    │
│   code-lab.js)│                      │  (Python + micropip)│
└───────┬───────┘                      └────────────────────┘
        │ chrome.runtime.sendMessage
        ▼
┌───────────────┐
│ service worker│  finds dashboard tab and proxies execute requests
└───────────────┘  (so the agent loop works during prompt jobs)
```

The dashboard exposes a small bridge object `window.PP_PYODIDE` with two
public methods:

- `execute({code, packages, timeoutMs, freshNamespace})` →
  `{ok, stdout, stderr, error, timedOut, packages}`
- `validate({validatorCode, stdout, stderr})` → `{ok, passed, message}`

Both are Promise-based. The bridge auto-bootstraps Pyodide on first use and
loads `micropip` so user code can `pip install` packages on demand. Packages
that ship in Pyodide's pre-built set load from CDN; others get pulled from
PyPI via micropip. Installations persist until the dashboard is reloaded.

## Code Lab tab

A dedicated tab in the dashboard with four sub-views:

### Editor
A monospace `<textarea>` for Python code, with:
- **Pip packages** input (comma-separated)
- **Timeout** in seconds
- **Fresh namespace** toggle (default on — each run starts empty)
- **Run** button (Ctrl/Cmd+Enter shortcut)
- **stdout / stderr panels** rendered side by side
- **Save snippet** to download as a `.py` file

Each successful run appends to a session history (last 50 runs).

### Run + Repair
A higher-level workflow: type a prompt, pick an open LLM tab, hit Run+Repair.
The extension:

1. Sends your prompt to the LLM.
2. Extracts the first ```python``` (or fenced) code block from the response.
3. Runs the code locally via Pyodide.
4. Applies the validator (if any).
5. If it failed, builds a feedback prompt — including the previous code,
   stdout, and the actual traceback — and sends it back to the LLM.
6. Repeats until success, max-loops reached, or the LLM stops returning code.

Each step appears as a colored bar in a live log: blue (info), green (ok),
amber (failed attempt), red (terminal error). All payloads are
expandable — code, stdout, stderr, full LLM responses.

### Packages
A simple "type a name, hit Install" UI for adding pip packages outside of a
run. Useful when you know your job needs `pandas` and want to warm it up.

### History
A list of recent runs with restore-to-editor.

## Agent loop in regular jobs

The New Job form has a new collapsible section: **Execute generated code
(agent loop)**. Toggle it on and the prompt pipeline becomes:

```
For each row:
    LLM generates code
    Extract Python from response
    Run locally via Pyodide
    Validate
    If passed: continue
    Else if auto-repair: feed traceback back to LLM, repeat (max N loops)
    Write code, stdout, stderr, exec_status to CSV
```

Form options:

| Option | Default | Notes |
|---|---|---|
| Execute generated Python code locally | off | Master toggle for the entire panel |
| Auto-repair via LLM if execution fails | off | Without this, failed code is recorded but the LLM isn't re-asked |
| Max repair loops | 5 | Cap to prevent runaway feedback cycles |
| Code timeout (s) | 30 | Per-execution wall-clock cap |
| Pip packages | (empty) | Comma-separated; loaded into Pyodide before the run |
| Validation mode | none | none / expected output / custom |
| Code column, stdout column, stderr column, exec status column | "code", "stdout", "stderr", "exec_status" | Names for artifact columns appended to the CSV. Leave blank to skip writing that artifact |

**Important caveat:** the agent loop needs the dashboard tab open while
the job runs, because that's where Pyodide lives. If you start a job with
code execution enabled and the dashboard tab is closed, the SW writes
`bridge_error` to the row's exec status and continues. Open Code Lab once
to bootstrap Pyodide; after that any open dashboard tab works as the
execution host.

## Validators

Three modes:

### None
Code passes if it didn't raise and didn't time out.

### Expected output
Compare `stdout` (trimmed) to a user-provided expected string (also trimmed).
Equality wins. Useful for deterministic tasks like "print the first 20
primes".

### Custom validator
A snippet of Python that defines:

```python
def validate(stdout, stderr, value):
    return True   # or False, or '' (pass), or 'fail message' (fail)
```

The validator runs in the same Pyodide instance after the user code, with
the captured `stdout` and `stderr` strings as arguments. Returning a string
is interpreted as: empty = pass, anything else = a fail message that
becomes part of the next repair-loop prompt.

## Per-row execution graph (in the details modal)

When a row has been through the agent loop, the row's strip in the job's
details modal gets an expandable "execution graph" view:

```
Inline:   ●  →  ●  →  ●  →  ●  →  ●  →  ●        (4 attempts, finally passed)
Expanded:
  1. Prompt sent to LLM
  2. LLM returned code (attempt 1)        [▶ code]
  ↳ Execution failed                       [▶ error]
  ↳ Repair feedback sent to LLM
  3. LLM returned code (attempt 2)        [▶ code]
  ↳ Execution failed                       [▶ error]
  ↳ Repair feedback sent to LLM
  4. Final code                            [▶ code]
  ↳ passed                                 [▶ stdout]
```

Each step is colored by kind (info / fail / ok / error) and the code/stdout
/stderr blocks are collapsible.

## Background Jobs (Phase 2/3, optional helper)

A new tab probes for the optional native helper via Chrome's Native Messaging
API. The helper is a tiny Python daemon (`helper/daemon.py`, ~80 lines for
now) that the dashboard talks to over stdio JSON.

When the helper is **not installed**, the tab shows install instructions
including:
- The auto-detected extension ID
- Per-OS native messaging manifest paths (Linux, macOS, Windows registry)
- A one-liner: `python helper/install.py`
- A copy-extension-ID button and a recheck button

When the helper **is installed**, the tab shows the helper version and
(eventually) its job queue. Right now the connected state is a placeholder
because Phase 2 — actually running queued jobs through the daemon — is
implemented as a stub. The protocol skeleton is documented in `helper/README.md`
and the SQLite schema is sketched there too.

The helper's purpose is to enable:
- Persistent SQLite-backed queues that survive browser restarts and OS reboots
- Background workers that execute Python rows even with Chrome closed
- (Phase 3) Optional Playwright-headless LLM driving so prompt jobs continue
  without a browser tab

The dashboard's existing pipeline doesn't need the helper at all — the
helper is purely an optional upgrade for users who want jobs to survive
Chrome being closed.

## Why a hidden iframe and not a Web Worker?

Web Workers in Chrome extension pages have stricter cross-origin and
file-loading constraints than top-level pages. Pyodide's WASM, JS shim, and
package files all need to load from the CDN, which means setting both
`script-src` and `connect-src` CSP allowances; doing it from an iframe with
its own document is simpler and more reliable than threading those rules
through a Worker.

The iframe is hidden (off-screen positioning + 1×1 px) and only one is
created per dashboard tab. It speaks a small `postMessage` protocol:

```
PYRUN_BOOTSTRAP        →  PYRUN_BOOTSTRAPPED  {ok, error?}
PYRUN_EXECUTE  {code, packages, timeoutMs, freshNamespace}
                       →  PYRUN_RESULT        {ok, stdout, stderr, error, timedOut, packages}
PYRUN_VALIDATE {validatorCode, stdout, stderr}
                       →  PYRUN_VALIDATE_RESULT {ok, passed, message}
PYRUN_PING             →  PYRUN_PONG          {ready}
```

Each message carries a `reqId`; the bridge's response is matched to the
caller's promise by that ID.

## Roadmap

- **Phase 1 (this release)** — Pyodide-based browser Python, Code Lab tab,
  agent loop integration in prompt jobs, validators, execution-graph view in
  details modal, helper-detection scaffolding.
- **Phase 2** — full helper daemon: SQLite-backed queue, background Python
  workers, optional native interpreter mode that uses the user's local Python
  install for heavy/scientific stacks (numpy, torch, etc.) that don't fit in
  Pyodide.
- **Phase 3** — Playwright-headless LLM driving so prompt jobs continue when
  Chrome is closed; system-tray-style auto-resume on reboot.
