// content/content.js
// Per-LLM page driver. Sends prompts, reads responses, detects rate limits / model
// switches / login walls. Uses NUMERIC model picking (1-6) instead of named models.
//
// IMPORTANT — background-tab handling (#3):
//   Chrome aggressively throttles setTimeout/setInterval in background tabs (the
//   minimum interval is clamped to ~1s after a few seconds, and after ~5 min the
//   tab can be parked entirely). To keep prompting fast even when the user
//   switches to another tab, this content script:
//
//     1. Keeps a hidden silent <audio> element looping — this prevents the page
//        from being downgraded to the deepest "frozen" state because Chrome
//        considers audio-playing tabs active.
//
//     2. Opens a long-lived port to the service worker (`PP_KEEPALIVE`). The
//        service worker pumps a tick every ~250 ms while a prompt is running.
//        Receiving a chrome.runtime port message wakes the content-script's
//        event loop, so our pollers (`waitFor`, `waitForStable`) keep firing
//        even when the tab isn't visible.

(() => {
  if (window.__parallelPromptsInjected) {
    console.log("[PP] Already injected, skipping");
    return;
  }
  window.__parallelPromptsInjected = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[PP]", ...a);

  // ---------- Background-tab keepalive ----------
  // (1) Silent audio element — keeps the tab in the "playing audio" state, which
  //     Chrome will not aggressively freeze.
  let __ppAudio = null;
  function ensureSilentAudio() {
    if (__ppAudio) return;
    try {
      // Tiny 1-frame WAV blob, base64 encoded, on infinite loop.
      // 44.1k mono, 1 sample, near silent.
      const silentWav =
        "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAESsAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==";
      __ppAudio = new Audio(silentWav);
      __ppAudio.loop = true;
      __ppAudio.volume = 0;
      __ppAudio.muted = true;
      // Some sites block autoplay until interaction; we still try because Chrome
      // permits silent audio in background tabs in MV3 extensions when the page
      // had earlier interaction. If it fails, the port-based keepalive below
      // still works.
      const p = __ppAudio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      // ignore — port-based keepalive is the primary mechanism
    }
  }

  // (2) Long-lived port to the service worker. The SW pumps "tick" messages
  // while jobs are active, which keeps our event loop responsive in the
  // background. We open the port lazily right when a RUN_PROMPT begins.
  let __ppPort = null;
  let __ppLastTickAt = 0;
  function ensureKeepalivePort() {
    if (__ppPort) return __ppPort;
    try {
      __ppPort = chrome.runtime.connect({ name: "PP_KEEPALIVE" });
      __ppPort.onMessage.addListener(() => { __ppLastTickAt = Date.now(); });
      __ppPort.onDisconnect.addListener(() => { __ppPort = null; });
    } catch (e) {
      __ppPort = null;
    }
    return __ppPort;
  }
  function closeKeepalivePort() {
    try { __ppPort && __ppPort.disconnect(); } catch {}
    __ppPort = null;
  }

  // ---------- Rate-limit / model-switch / login signatures ----------
  const RATE_LIMIT_SIGNATURES = {
    chatgpt: [
      { pattern: /you've reached our limit of messages/i, kind: "rate_limit", message: "ChatGPT message limit reached." },
      { pattern: /you've hit the (free|plus) plan limit/i, kind: "rate_limit", message: "ChatGPT plan limit reached." },
      { pattern: /please wait a (moment|few minutes)/i, kind: "rate_limit", message: "ChatGPT asked to wait." },
      { pattern: /you've reached the current usage cap/i, kind: "rate_limit", message: "ChatGPT usage cap." },
      { pattern: /upgrade to (chatgpt )?plus/i, kind: "model_switch", message: "ChatGPT downgraded — upgrade prompt visible." },
      { pattern: /switched to (gpt-?[0-9.]+|a (different|smaller) model)/i, kind: "model_switch", message: "ChatGPT switched models." },
      { pattern: /log ?in to (continue|chatgpt)/i, kind: "login", message: "ChatGPT requires login." },
    ],
    claude: [
      { pattern: /you are out of free messages until/i, kind: "rate_limit", message: "Claude free messages exhausted." },
      { pattern: /message limit reached/i, kind: "rate_limit", message: "Claude message limit reached." },
      { pattern: /you've reached your (limit|usage)/i, kind: "rate_limit", message: "Claude limit hit." },
      { pattern: /upgrade to claude (pro|max)/i, kind: "model_switch", message: "Claude paid-tier upgrade prompt." },
      { pattern: /due to (high|unexpected) (capacity|demand|load)/i, kind: "model_switch", message: "Claude capacity issue." },
      { pattern: /please log in/i, kind: "login", message: "Claude requires login." },
    ],
    gemini: [
      { pattern: /you've reached your (daily|monthly) (limit|quota)/i, kind: "rate_limit", message: "Gemini quota reached." },
      { pattern: /you've hit your (limit|cap)/i, kind: "rate_limit", message: "Gemini cap reached." },
      { pattern: /try again (later|in a)/i, kind: "rate_limit", message: "Gemini asked to wait." },
      { pattern: /upgrade to (gemini )?(advanced|pro)/i, kind: "model_switch", message: "Gemini upgrade prompt visible." },
      { pattern: /sign ?in to (continue|google)/i, kind: "login", message: "Gemini requires Google login." },
    ],
    aistudio: [
      { pattern: /you have run out of (free )?quota/i, kind: "rate_limit", message: "AI Studio quota exhausted." },
      { pattern: /resource[_ ]exhausted|quota exceeded/i, kind: "rate_limit", message: "AI Studio quota exceeded." },
      { pattern: /rate ?limit (exceeded|hit)/i, kind: "rate_limit", message: "AI Studio rate limited." },
      { pattern: /(model|the model) is not available/i, kind: "model_switch", message: "AI Studio: model unavailable." },
      { pattern: /sign ?in to (continue|google)/i, kind: "login", message: "AI Studio requires Google login." },
    ],
    deepseek: [
      { pattern: /server is busy/i, kind: "rate_limit", message: "DeepSeek server busy." },
      { pattern: /(rate|usage) limit/i, kind: "rate_limit", message: "DeepSeek rate limit." },
      { pattern: /please log ?in/i, kind: "login", message: "DeepSeek requires login." },
    ],
    qwen: [
      { pattern: /(rate|usage) limit/i, kind: "rate_limit", message: "Qwen rate limit." },
      { pattern: /please log ?in/i, kind: "login", message: "Qwen requires login." },
    ],
    perplexity: [
      { pattern: /you've used all your (pro|free) (searches|threads)/i, kind: "rate_limit", message: "Perplexity searches exhausted." },
      { pattern: /upgrade to perplexity pro/i, kind: "model_switch", message: "Perplexity upgrade prompt visible." },
    ],
    copilot: [
      { pattern: /you've hit your (daily|message) limit/i, kind: "rate_limit", message: "Copilot daily limit reached." },
      { pattern: /sign ?in to (continue|copilot)/i, kind: "login", message: "Copilot requires login." },
    ],
    grok: [
      { pattern: /you've reached your (grok|message) limit/i, kind: "rate_limit", message: "Grok message limit reached." },
      { pattern: /upgrade to (premium|x premium)/i, kind: "model_switch", message: "Grok upgrade prompt visible." },
    ],
  };

  // ---------- Reset-time scrapers (#8) ----------
  // Each LLM displays a "your messages reset at HH:MM" or "in 4 hours" string
  // when the user is rate-limited or about to be. We try to extract a future
  // unix timestamp (ms) the job scheduler can wait until.
  function scrapeResetTime() {
    const txt = (document.body?.innerText || "").slice(-8000);
    if (!txt) return null;
    const now = Date.now();

    // Pattern A — explicit clock time, e.g. "until 4 PM" / "at 16:00 UTC"
    const clockRe = /(?:until|reset(?:s| at)?|tomorrow at|today at|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
    const m1 = txt.match(clockRe);
    if (m1) {
      let hh = Number(m1[1] || 0);
      const mm = Number(m1[2] || 0);
      const ampm = (m1[3] || "").toLowerCase();
      if (ampm === "pm" && hh < 12) hh += 12;
      if (ampm === "am" && hh === 12) hh = 0;
      const d = new Date();
      d.setHours(hh, mm, 0, 0);
      // If that time is in the past, it must mean tomorrow.
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }

    // Pattern B — relative duration: "in 4 hours", "in 35 minutes"
    const relRe = /in\s+(\d+)\s+(second|minute|hour|day)s?/i;
    const m2 = txt.match(relRe);
    if (m2) {
      const n = Number(m2[1]);
      const unit = m2[2].toLowerCase();
      const mult = unit === "second" ? 1000
                 : unit === "minute" ? 60_000
                 : unit === "hour"   ? 3_600_000
                 :                     86_400_000;
      return now + n * mult;
    }

    // Pattern C — "available again at <ISO timestamp>"
    const isoRe = /available\s+(?:again\s+)?(?:at|on)\s+([0-9T:\-+\sZ]+)/i;
    const m3 = txt.match(isoRe);
    if (m3) {
      const d = new Date(m3[1]);
      if (!isNaN(d.getTime()) && d.getTime() > now) return d.getTime();
    }

    return null;
  }

  function detectLLM() {
    const h = location.hostname;
    if (h.includes("chatgpt.com") || h.includes("chat.openai.com")) return "chatgpt";
    if (h.includes("claude.ai")) return "claude";
    if (h.includes("aistudio.google.com")) return "aistudio";
    if (h.includes("gemini.google.com")) return "gemini";
    if (h.includes("deepseek.com")) return "deepseek";
    if (h.includes("qwen.ai") || h.includes("qwenlm.ai")) return "qwen";
    if (h.includes("perplexity.ai")) return "perplexity";
    if (h.includes("copilot.microsoft.com")) return "copilot";
    if (h.includes("grok.com")) return "grok";
    return null;
  }

  function detectInterruption(llm) {
    const sigs = RATE_LIMIT_SIGNATURES[llm] || [];
    const bodyText = document.body?.innerText || "";
    const tail = bodyText.slice(-6000);
    for (const s of sigs) if (s.pattern.test(tail)) {
      const resetAt = scrapeResetTime();
      return { kind: s.kind, message: s.message, resetAt };
    }
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
    if (dialog) {
      const t = (dialog.innerText || "").trim();
      for (const s of sigs) if (s.pattern.test(t)) {
        const resetAt = scrapeResetTime();
        return { kind: s.kind, message: s.message + " (modal)", resetAt };
      }
    }
    return null;
  }

  async function waitFor(predicate, { timeout = 30000, interval = 300 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const r = predicate();
        if (r) return r;
      } catch {}
      await sleep(interval);
    }
    return null;
  }

  async function waitForStable(getValue, {
    stableMs = 2500, timeout = 240000, interval = 600, minLength = 1,
    onProgress = null, abortIf = null, isGenerating = null,
  } = {}) {
    const start = Date.now();
    let lastValue = "";
    let lastChangeAt = Date.now();
    let lastProgress = 0;

    while (Date.now() - start < timeout) {
      if (abortIf) {
        const interruption = abortIf();
        if (interruption) return { interruption, value: lastValue };
      }

      let value = "";
      try { value = (getValue() || ""); } catch {}

      if (value !== lastValue) {
        lastValue = value;
        lastChangeAt = Date.now();
        if (onProgress && Date.now() - lastProgress > 800) {
          lastProgress = Date.now();
          try { onProgress(value); } catch {}
        }
      } else if (value.length >= minLength) {
        const generating = isGenerating ? isGenerating() : null;

        if (generating === true) {
          // The LLM's "Stop" button is still visible. Do NOT exit, keep waiting!
        } else if (generating === false) {
          // The "Stop" button disappeared. Wait 800ms for the DOM to fully settle.
          if (Date.now() - lastChangeAt >= 800) return { value, interruption: null };
        } else {
          // Unknown state (fallback). Only exit if text hasn't changed for 2.5s.
          if (Date.now() - lastChangeAt >= stableMs) return { value, interruption: null };
        }
      }

      await sleep(interval);
    }
    return { value: lastValue, interruption: null, timedOut: true };
  }

  // ---------- Robust input setter ----------
  async function setTextInEditor(el, text) {
    el.focus();
    el.scrollIntoView({ block: "center" });
    await sleep(80);

    text = String(text).replace(/\r\n/g, "\n");

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(120);
      return;
    }

    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("delete", false, null);
    } catch (e) { log("Clear failed", e); }

    let pasted = false;
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const htmlText = text.split('\n').map(line => line ? `<p>${line}</p>` : '<br>').join('');
      dt.setData("text/html", htmlText);

      const pasteEv = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
      el.dispatchEvent(pasteEv);

      await sleep(120);
      const got = (el.innerText || el.textContent || "");
      if (got.length >= Math.min(text.length, 20) && got.includes(text.slice(0, Math.min(20, text.length)))) {
        pasted = true;
      }
    } catch (e) { log("Paste dispatch failed", e); }

    if (!pasted) {
      try {
        document.execCommand("insertText", false, text);
        await sleep(120);
      } catch (e) { log("insertText fallback failed", e); }
    }

    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(150);
  }

  function pressEnter(el) {
    el.focus();
    log("Dispatching robust Enter key events");
    const events = [
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }),
      new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }),
      new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })
    ];
    for (const ev of events) el.dispatchEvent(ev);
  }

  // ---------- Numeric model picker ----------
  async function pickNthModel(llm, n) {
    if (!n || n < 1) return false;
    const opener = MODEL_PICKER_OPENERS[llm];
    if (!opener) return false;
    const button = opener();
    if (!button) return false;
    button.click();
    await sleep(450);

    const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
      .filter((el) => {
        const t = (el.innerText || "").trim();
        if (!t) return false;
        if (/^(close|cancel|sign|account|settings)$/i.test(t)) return false;
        if (el.getAttribute("aria-disabled") === "true") return false;
        return true;
      });

    if (items.length === 0) {
      document.body.click();
      return false;
    }
    const target = items[Math.min(n - 1, items.length - 1)];
    if (target) {
      target.click();
      await sleep(300);
      return true;
    }
    return false;
  }

  const MODEL_PICKER_OPENERS = {
    chatgpt: () =>
      document.querySelector('[data-testid="model-switcher-dropdown-button"]') ||
      document.querySelector('button[aria-label*="Model" i]') ||
      Array.from(document.querySelectorAll("button")).find((b) => /^GPT-?[0-9]/i.test((b.innerText || "").trim())),
    claude: () =>
      document.querySelector('[data-testid="model-selector-dropdown"]') ||
      Array.from(document.querySelectorAll("button")).find((b) =>
        /(opus|sonnet|haiku)/i.test((b.innerText || "").slice(0, 40))
      ),
    gemini: () =>
      document.querySelector('bard-mode-switcher button') ||
      document.querySelector('button[aria-label*="model" i]') ||
      Array.from(document.querySelectorAll("button")).find((b) =>
        /^[0-9.]+ ?(flash|pro|deep)/i.test((b.innerText || "").trim())
      ),
    deepseek: () =>
      Array.from(document.querySelectorAll("button, div[role='button']")).find((b) =>
        /(deepseek|model)/i.test((b.innerText || "").slice(0, 50))
      ),
    qwen: () =>
      document.querySelector('[class*="model-selector"]') ||
      Array.from(document.querySelectorAll("button")).find((b) => /qwen/i.test((b.innerText || "").trim())),
    perplexity: () =>
      Array.from(document.querySelectorAll("button")).find((b) => /(model|sonar|gpt|claude)/i.test((b.innerText || "").slice(0, 40))),
    copilot: () =>
      Array.from(document.querySelectorAll("button")).find((b) => /think|deeper|smart/i.test((b.innerText || "").slice(0, 40))),
    grok: () =>
      Array.from(document.querySelectorAll("button")).find((b) => /grok/i.test((b.innerText || "").slice(0, 40)) && b.querySelector("svg")),
  };

  // ---------- Thinking toggle ----------
  async function toggleThinking(llm, on) {
    const finder = THINKING_TOGGLES[llm];
    if (!finder) return false;
    const btn = finder();
    if (!btn) return false;

    const isOn = btn.getAttribute("aria-pressed") === "true" ||
                 btn.getAttribute("data-state") === "on" ||
                 btn.classList.toString().match(/active|enabled|on(\b|$)/);
    if (!!on !== !!isOn) {
      btn.click();
      await sleep(200);
      return true;
    }
    return false;
  }

  const THINKING_TOGGLES = {
    chatgpt: () =>
      Array.from(document.querySelectorAll("button"))
        .find((b) => /(think|reason)/i.test((b.innerText || b.getAttribute("aria-label") || "").trim())),
    claude: () =>
      Array.from(document.querySelectorAll("button"))
        .find((b) => /extended thinking|think harder|reasoning/i.test((b.innerText || b.getAttribute("aria-label") || "").trim())),
    gemini: () =>
      Array.from(document.querySelectorAll("button"))
        .find((b) => /(deep ?think|deep ?research)/i.test((b.innerText || b.getAttribute("aria-label") || "").trim())),
    deepseek: () =>
      Array.from(document.querySelectorAll("button, div[role='button']"))
        .find((b) => /(deepthink|r1|reason)/i.test((b.innerText || "").trim())),
    qwen: () =>
      Array.from(document.querySelectorAll("button"))
        .find((b) => /(thinking|reason)/i.test((b.innerText || "").trim())),
    perplexity: () =>
      Array.from(document.querySelectorAll("button"))
        .find((b) => /pro search|reason/i.test((b.innerText || "").trim())),
    copilot: () =>
      Array.from(document.querySelectorAll("button"))
        .find((b) => /think deeper/i.test((b.innerText || "").trim())),
    grok: () =>
      Array.from(document.querySelectorAll("button"))
        .find((b) => /(think|reason)/i.test((b.innerText || "").trim())),
  };

  // ---------- Adapters ----------
  const adapters = {
    chatgpt: {
      getInput: () =>
        document.querySelector("#prompt-textarea") ||
        document.querySelector('div[contenteditable="true"]#prompt-textarea') ||
        document.querySelector('div[contenteditable="true"]') ||
        document.querySelector("textarea"),
      getSendButton: () =>
        document.querySelector('button[data-testid="send-button"]') ||
        document.querySelector('button[aria-label*="Send" i]:not([aria-label*="Stop" i])'),
      isGenerating: () =>
        !!document.querySelector('button[data-testid="stop-button"]') ||
        !!document.querySelector('button[aria-label*="Stop" i]'),
      getLastResponseText: () => {
        const m = document.querySelectorAll('[data-message-author-role="assistant"]');
        const last = m[m.length - 1];
        return last ? (last.innerText || "").trim() : "";
      },
      newChatUrl: () => "https://chatgpt.com/",
    },
    claude: {
      getInput: () =>
        document.querySelector('div[contenteditable="true"].ProseMirror') ||
        document.querySelector('div[contenteditable="true"]') ||
        document.querySelector("textarea"),
      getSendButton: () =>
        document.querySelector('button[aria-label="Send message"]') ||
        document.querySelector('button[aria-label="Send Message"]') ||
        document.querySelector('button[aria-label*="Send" i]'),
      isGenerating: () =>
        !!document.querySelector('button[aria-label="Stop response"]') ||
        !!document.querySelector('button[aria-label*="Stop" i]'),
      getLastResponseText: () => {
        const all = document.querySelectorAll('.font-claude-message, [data-test-render-count]');
        const last = all[all.length - 1];
        return last ? (last.innerText || "").trim() : "";
      },
      newChatUrl: () => "https://claude.ai/new",
      isClaudeContinueAvailable: () => {
        const t = (document.body.innerText || "").slice(-3000);
        if (/response was (cut off|truncated|stopped)/i.test(t)) return true;
        const btn = Array.from(document.querySelectorAll("button"))
          .find((b) => (b.innerText || "").trim().toLowerCase() === "continue");
        return !!btn;
      },
      clickContinueOrType: async () => {
        const btn = Array.from(document.querySelectorAll("button"))
          .find((b) => (b.innerText || "").trim().toLowerCase() === "continue");
        if (btn) { btn.click(); return true; }
        const input = adapters.claude.getInput();
        if (!input) return false;
        await setTextInEditor(input, "Continue");
        await sleep(200);
        const send = adapters.claude.getSendButton();
        if (send && !send.disabled) send.click();
        else pressEnter(input);
        return true;
      },
    },
    gemini: {
      getInput: () =>
        document.querySelector('rich-textarea div[contenteditable="true"]') ||
        document.querySelector('.ql-editor') ||
        document.querySelector('div[contenteditable="true"]') ||
        document.querySelector("textarea"),
      getSendButton: () =>
        document.querySelector('button[aria-label*="Send message" i]') ||
        document.querySelector('button.send-button') ||
        document.querySelector('button[aria-label*="Send" i]'),
      isGenerating: () => !!document.querySelector('button[aria-label*="Stop" i]'),
      getLastResponseText: () => {
        const m = document.querySelectorAll('message-content, .model-response-text, [data-response-id]');
        const last = m[m.length - 1];
        return last ? (last.innerText || "").trim() : "";
      },
      newChatUrl: () => "https://gemini.google.com/app",
    },
    aistudio: {
      getInput: () =>
        document.querySelector('ms-prompt-input textarea') ||
        document.querySelector('.input-area textarea') ||
        document.querySelector("textarea"),
      getSendButton: () =>
        document.querySelector('run-button button') ||
        document.querySelector('button[aria-label*="Run" i]:not([aria-label*="Stop" i])'),
      isGenerating: () =>
        !!document.querySelector('button[aria-label="Stop"]') ||
        !!document.querySelector('stop-button button'),
      getLastResponseText: () => {
        const turns = document.querySelectorAll('ms-chat-turn[data-turn-role="model"], ms-chat-turn .model-prompt-container, ms-chat-turn .turn-content');
        if (turns.length) return (turns[turns.length - 1].innerText || "").trim();
        const md = document.querySelectorAll('ms-chat-turn ms-text-chunk, ms-chat-turn .markdown');
        if (md.length) return Array.from(md).slice(-10).map((n) => n.innerText || "").join("").trim();
        const allTurns = document.querySelectorAll('ms-chat-turn');
        const last = allTurns[allTurns.length - 1];
        return last ? (last.innerText || "").trim() : "";
      },
      newChatUrl: () => "https://aistudio.google.com/u/1/prompts/new_chat",
    },
    deepseek: {
      getInput: () =>
        document.querySelector('textarea#chat-input') ||
        document.querySelector('textarea[placeholder*="Message" i]') ||
        document.querySelector("textarea"),
      getSendButton: () => {
        const ta = document.querySelector('textarea#chat-input') || document.querySelector("textarea");
        if (!ta) return null;
        const wrap = ta.closest("div");
        const btns = wrap ? wrap.querySelectorAll('button, div[role="button"]') : [];
        if (btns.length) return btns[btns.length - 1];
        return document.querySelector('button[type="submit"]');
      },
      isGenerating: () =>
        Array.from(document.querySelectorAll("button, div[role='button']"))
          .some((b) => /stop/i.test((b.textContent || ""))),
      getLastResponseText: () => {
        const m = document.querySelectorAll('.ds-markdown, [class*="markdown"]');
        const last = m[m.length - 1];
        return last ? (last.innerText || "").trim() : "";
      },
      newChatUrl: () => "https://chat.deepseek.com/",
    },
    qwen: {
      getInput: () => document.querySelector('textarea#chat-input') || document.querySelector('textarea'),
      getSendButton: () => document.querySelector('button#send-message-button') || document.querySelector('button[type="submit"]'),
      isGenerating: () => Array.from(document.querySelectorAll("button")).some((b) => /stop/i.test((b.getAttribute("aria-label") || b.textContent || ""))),
      getLastResponseText: () => {
        const m = document.querySelectorAll('[class*="markdown"], .response-content-container');
        return m[m.length - 1] ? (m[m.length - 1].innerText || "").trim() : "";
      },
      newChatUrl: () => "https://chat.qwen.ai/",
    },
    perplexity: {
      getInput: () => document.querySelector('textarea[placeholder*="Ask" i]') || document.querySelector('textarea'),
      getSendButton: () => document.querySelector('button[aria-label*="Submit" i]') || document.querySelector('button[type="submit"]'),
      isGenerating: () => !!document.querySelector('button[aria-label*="Stop" i]'),
      getLastResponseText: () => {
        const m = document.querySelectorAll('.prose, [class*="answer"]');
        return m[m.length - 1] ? (m[m.length - 1].innerText || "").trim() : "";
      },
      newChatUrl: () => "https://www.perplexity.ai/",
    },
    copilot: {
      getInput: () => document.querySelector('textarea#userInput') || document.querySelector('textarea'),
      getSendButton: () => document.querySelector('button[data-testid="submit-button"]') || document.querySelector('button[aria-label*="Submit" i]'),
      isGenerating: () => !!document.querySelector('button[aria-label*="Stop" i]'),
      getLastResponseText: () => {
        const m = document.querySelectorAll('[data-content="ai-message"], .ac-textBlock');
        return m[m.length - 1] ? (m[m.length - 1].innerText || "").trim() : "";
      },
      newChatUrl: () => "https://copilot.microsoft.com/",
    },
    grok: {
      getInput: () => document.querySelector('textarea[placeholder*="Grok" i]') || document.querySelector('textarea'),
      getSendButton: () => document.querySelector('button[aria-label*="Submit" i]') || document.querySelector('button[type="submit"]'),
      isGenerating: () => !!document.querySelector('button[aria-label*="Stop" i]'),
      getLastResponseText: () => {
        const m = document.querySelectorAll('[class*="message-bubble"], [class*="response"]');
        return m[m.length - 1] ? (m[m.length - 1].innerText || "").trim() : "";
      },
      newChatUrl: () => "https://grok.com/",
    },
  };

  // ---------- Runner ----------
  // (#1) Sequential prompts: this content script is single-flighted at the
  // chrome.tabs.sendMessage layer — the SW awaits each RUN_PROMPT response
  // before it sends the next. Inside a single runPrompt() call we also wait
  // for any *previous* generation to finish (`isGenerating` poll) before
  // pasting the new prompt.
  async function runPrompt({ prompt, llm, modelIndex, thinking, autoContinue, maxContinues = 5, navigateNewChat = false }) {
    const detected = detectLLM();
    const llmKey = llm || detected;
    const adapter = adapters[llmKey];
    if (!adapter) throw new Error("No adapter for this site (detected: " + detected + ")");

    // Background-tab keepalive (#3): pin the tab as "active" for Chrome.
    ensureSilentAudio();
    ensureKeepalivePort();

    log(`runPrompt llm=${llmKey} modelIndex=${modelIndex}`);

    if (modelIndex && modelIndex > 0) {
      try { await pickNthModel(llmKey, modelIndex); }
      catch (e) { log("pickNthModel failed:", e); }
    }

    if (thinking !== undefined && thinking !== null) {
      try { await toggleThinking(llmKey, thinking); }
      catch (e) { log("toggleThinking failed:", e); }
    }

    // Wait for input field
    const input = await waitFor(() => adapter.getInput(), { timeout: 30000, interval: 400 });
    if (!input) throw new Error("Input field not found after 30s.");

    // --- LOCK (#1): wait for ongoing generation to completely finish before
    // sending the next prompt. This is what guarantees we don't pile on a
    // second prompt while the first is still streaming.
    if (adapter.isGenerating && adapter.isGenerating()) {
      log("LLM is currently generating a previous response. Waiting...");
      await waitFor(() => !adapter.isGenerating(), { timeout: 120000, interval: 500 });
      await sleep(1500); // safety buffer
    }

    // Pre-flight rate-limit check
    const preflight = detectInterruption(llmKey);
    if (preflight) {
      log("Preflight interruption:", preflight);
      return { kind: preflight.kind, message: preflight.message, partialText: "", text: "", resetAt: preflight.resetAt || null };
    }

    const beforeText = (adapter.getLastResponseText() || "").trim();

    await setTextInEditor(input, prompt);
    log("Inserted prompt");
    await sleep(500); // Give the framework time to re-render

    // Try to click send button
    let sendBtn = null;
    let clicked = false;
    for (let i = 0; i < 15; i++) {
      sendBtn = adapter.getSendButton();
      const isDisabled = sendBtn && (sendBtn.disabled || sendBtn.getAttribute("aria-disabled") === "true" || sendBtn.style.pointerEvents === "none");

      if (sendBtn && !isDisabled) {
        sendBtn.scrollIntoView({ block: "center" });
        sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        sendBtn.click();
        log("Clicked send button natively");
        clicked = true;
        break;
      }
      await sleep(300);
    }

    if (!clicked) {
      log("Send button unavailable, falling back to Enter key dispatch.");
      pressEnter(input);
    }

    // Wait for generation to start (increased to 90 seconds for heavy reasoning models)
    const started = await waitFor(() => {
      const interruption = detectInterruption(llmKey);
      if (interruption) return interruption;
      if (adapter.isGenerating?.()) return true;
      const now = (adapter.getLastResponseText() || "").trim();
      return now && now !== beforeText;
    }, { timeout: 90000, interval: 400 });

    if (!started) {
      log("Prompt failed to submit after 90 seconds.");
      return { kind: "error", message: "Prompt didn't submit (no response started in 90s).", text: "", partialText: "" };
    }

    const earlyCheck = detectInterruption(llmKey);
    if (earlyCheck) return { kind: earlyCheck.kind, message: earlyCheck.message, partialText: "", text: "", resetAt: earlyCheck.resetAt || null };

    // Wait for response to stabilise
    const result = await waitForStable(
      () => {
        const t = (adapter.getLastResponseText() || "").trim();
        return t && t !== beforeText ? t : "";
      },
      {
        stableMs: 2500, timeout: 5 * 60 * 1000, interval: 600, minLength: 1,
        onProgress: (text) => { try { chrome.runtime.sendMessage({ type: "PROMPT_PROGRESS", text }); } catch {} },
        abortIf: () => detectInterruption(llmKey),
        isGenerating: () => adapter.isGenerating?.() ?? null,
      }
    );

    if (result.interruption) {
      const partial = (adapter.getLastResponseText() || "").trim();
      return {
        kind: result.interruption.kind, message: result.interruption.message,
        partialText: partial && partial !== beforeText ? partial : "", text: "",
        resetAt: result.interruption.resetAt || null,
      };
    }

    let finalText = result.value || (adapter.getLastResponseText() || "").trim();

    if (autoContinue && llmKey === "claude") {
      let continues = 0;
      while (continues < maxContinues && adapters.claude.isClaudeContinueAvailable()) {
        const ok = await adapters.claude.clickContinueOrType();
        if (!ok) break;
        continues++;
        await sleep(800);
        const cont = await waitForStable(
          () => (adapter.getLastResponseText() || "").trim(),
          {
            stableMs: 2500, timeout: 4 * 60 * 1000, interval: 600, minLength: 1,
            onProgress: (text) => { try { chrome.runtime.sendMessage({ type: "PROMPT_PROGRESS", text }); } catch {} },
            abortIf: () => detectInterruption(llmKey),
            isGenerating: () => adapter.isGenerating?.() ?? null,
          }
        );
        if (cont.interruption) {
          return { kind: cont.interruption.kind, message: cont.interruption.message, partialText: cont.value || finalText, text: "", resetAt: cont.interruption.resetAt || null };
        }
        finalText = cont.value || finalText;
      }
    }

    return { kind: "ok", text: finalText, partialText: "", message: "" };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "PING") {
      sendResponse({ ok: true, llm: detectLLM(), url: location.href });
      return false;
    }
    if (msg.type === "GET_RESET_TIME") {
      // Used by the SW / scheduler to ask "when does this LLM say its limit resets?"
      sendResponse({ ok: true, resetAt: scrapeResetTime(), llm: detectLLM() });
      return false;
    }
    if (msg.type !== "RUN_PROMPT") return false;
    (async () => {
      try {
        const result = await runPrompt(msg);
        try { chrome.runtime.sendMessage({ type: "PROMPT_RESPONSE", ...result }); } catch {}
        sendResponse({ ok: true, ...result });
      } catch (e) {
        const errResult = { kind: "error", message: e.message || String(e), text: "", partialText: "" };
        try { chrome.runtime.sendMessage({ type: "PROMPT_RESPONSE", ...errResult }); } catch {}
        sendResponse({ ok: false, ...errResult });
      } finally {
        // Don't tear down keepalive — the next prompt will re-use it. The SW
        // closes the port from its side when the job ends.
      }
    })();
    return true;
  });

  log("content ready on", detectLLM(), location.href);
})();
