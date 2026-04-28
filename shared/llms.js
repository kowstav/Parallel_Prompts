// shared/llms.js
// Central registry of supported LLMs, their model versions, and rate-limit signatures.
// Loaded as a classic script in popup / dashboard, AND via importScripts in the SW.

(function (root) {
  const LLMS = {
    chatgpt: {
      label: "ChatGPT",
      url: "https://chatgpt.com/",
      newChatUrl: "https://chatgpt.com/?model={model}",
      models: [
        { id: "auto", label: "Auto (default)", tier: "free" },
        { id: "gpt-5", label: "GPT-5", tier: "paid" },
        { id: "gpt-5-thinking", label: "GPT-5 Thinking", tier: "paid" },
        { id: "gpt-4o", label: "GPT-4o", tier: "free" },
        { id: "gpt-4-1", label: "GPT-4.1", tier: "paid" },
        { id: "o3", label: "o3", tier: "paid" },
        { id: "o4-mini", label: "o4-mini", tier: "paid" },
      ],
    },
    claude: {
      label: "Claude",
      url: "https://claude.ai/new",
      newChatUrl: "https://claude.ai/new",
      models: [
        { id: "default", label: "Default (account model)", tier: "free" },
        { id: "claude-opus-4-7", label: "Claude Opus 4.7", tier: "paid" },
        { id: "claude-opus-4-6", label: "Claude Opus 4.6", tier: "paid" },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "free" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", tier: "free" },
      ],
    },
    gemini: {
      label: "Gemini",
      url: "https://gemini.google.com/app",
      // Gemini supports user accounts via /u/{n}/
      newChatUrl: "https://gemini.google.com{userPath}/app",
      supportsUserNumber: true,
      models: [
        { id: "default", label: "Default (account model)", tier: "free" },
        { id: "2.5-flash", label: "2.5 Flash", tier: "free" },
        { id: "2.5-pro", label: "2.5 Pro", tier: "paid" },
        { id: "3.0-pro", label: "3.0 Pro", tier: "paid" },
        { id: "deep-research", label: "Deep Research", tier: "paid" },
      ],
    },
    aistudio: {
      label: "AI Studio (Gemini)",
      url: "https://aistudio.google.com/",
      // AI Studio uses URL params for model selection. Account number lives in the path: /u/{n}/
      // Model is appended via ?model=…  These three are the public preview models in this fixed order:
      //   1. gemini-3-flash-preview
      //   2. gemini-3.1-pro-preview
      //   3. gemini-3.1-flash-lite-preview
      newChatUrl: "https://aistudio.google.com/u/{userNumber}/prompts/new_chat?model={modelSlug}",
      supportsUserNumber: true,
      // The order of this array matters — index 1 = first model and so on.
      models: [
        { id: "default", label: "Default (last used)", tier: "free", slug: null },
        { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", tier: "free", slug: "gemini-3-flash-preview" },
        { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", tier: "free", slug: "gemini-3.1-pro-preview" },
        { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite (preview)", tier: "free", slug: "gemini-3.1-flash-lite-preview" },
      ],
    },
    deepseek: {
      label: "DeepSeek",
      url: "https://chat.deepseek.com/",
      newChatUrl: "https://chat.deepseek.com/",
      models: [
        { id: "default", label: "Default (V3)", tier: "free" },
        { id: "deepthink", label: "DeepThink (R1)", tier: "free" },
        { id: "search", label: "Search", tier: "free" },
      ],
    },
    qwen: {
      label: "Qwen",
      url: "https://chat.qwen.ai/",
      newChatUrl: "https://chat.qwen.ai/",
      models: [
        { id: "default", label: "Default", tier: "free" },
        { id: "qwen3-max", label: "Qwen3-Max", tier: "free" },
        { id: "qwen3-coder", label: "Qwen3-Coder", tier: "free" },
        { id: "qwen3-thinking", label: "Qwen3-Thinking", tier: "free" },
      ],
    },
    perplexity: {
      label: "Perplexity",
      url: "https://www.perplexity.ai/",
      newChatUrl: "https://www.perplexity.ai/",
      models: [
        { id: "default", label: "Auto", tier: "free" },
        { id: "sonar", label: "Sonar", tier: "free" },
        { id: "sonar-pro", label: "Sonar Pro", tier: "paid" },
        { id: "claude-sonnet", label: "Claude Sonnet", tier: "paid" },
        { id: "gpt-5", label: "GPT-5", tier: "paid" },
      ],
    },
    copilot: {
      label: "Copilot",
      url: "https://copilot.microsoft.com/",
      newChatUrl: "https://copilot.microsoft.com/",
      models: [
        { id: "default", label: "Default", tier: "free" },
        { id: "think-deeper", label: "Think Deeper", tier: "free" },
        { id: "smart-gpt-5", label: "Smart (GPT-5)", tier: "paid" },
      ],
    },
    grok: {
      label: "Grok",
      url: "https://grok.com/",
      newChatUrl: "https://grok.com/",
      models: [
        { id: "default", label: "Default", tier: "free" },
        { id: "grok-4", label: "Grok 4", tier: "free" },
        { id: "grok-4-heavy", label: "Grok 4 Heavy", tier: "paid" },
        { id: "grok-4-expert", label: "Grok 4 Expert", tier: "paid" },
      ],
    },
  };

  // Rate-limit / model-switch signatures.
  // Each entry: {pattern: RegExp, kind: "rate_limit"|"model_switch"|"login", message: string}
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
      { pattern: /you've reached your (limit|usage|conversation length)/i, kind: "rate_limit", message: "Claude limit hit." },
      { pattern: /reached the (maximum length|conversation length)/i, kind: "rate_limit", message: "Claude conversation length limit." },
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
      { pattern: /(model|the model) is not available/i, kind: "model_switch", message: "AI Studio: this model isn't available right now." },
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

  const CONTINUE_TRIGGERS = {
    claude: [
      /response was (cut off|truncated|stopped because)/i,
      /reached the maximum response length/i,
      /click continue/i,
      /\[continue\]/i,
    ],
    chatgpt: [
      /continue generating/i,
      /response was (cut off|truncated)/i,
    ],
  };

  const exported = { LLMS, RATE_LIMIT_SIGNATURES, CONTINUE_TRIGGERS };

  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (root) root.PP_LLMS = exported;
})(typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : globalThis));
