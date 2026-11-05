/*
 * Shared constants.
 *
 * Loaded as a classic script in every extension context — the service worker
 * (importScripts), the popup (<script>) and the content scripts (manifest) —
 * so it attaches to a single `QZ` namespace on globalThis instead of using
 * ES module exports.
 */
(() => {
  const QZ = (globalThis.QZ = globalThis.QZ || {});
  if (QZ.config) return;

  QZ.config = Object.freeze({
    API_URL: 'https://openrouter.ai/api/v1/chat/completions',
    MODELS_URL: 'https://openrouter.ai/api/v1/models',
    KEY_URL: 'https://openrouter.ai/api/v1/key',
    APP_TITLE: 'Quizzers MCQ Highlighter',
    APP_REFERER: 'https://github.com/boogiepazzo/quizzers',

    DEFAULT_MODEL: 'google/gemini-2.5-flash',

    // Model IDs verified against OpenRouter's live /models list. The popup can
    // also load the full list on demand, so these are only starting points.
    MODEL_PRESETS: Object.freeze([
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (fast, low cost)' },
      { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5 (fast, low cost)' },
      { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 (strongest reasoning)' },
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
      { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini' },
      { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite (cheapest)' },
      { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2' },
    ]),

    MSG: Object.freeze({
      SCAN_TAB: 'qz:scan-tab',
      CLEAR_TAB: 'qz:clear-tab',
      FOCUS_QUESTION: 'qz:focus-question',
      STATE: 'qz:state',
      TEST_KEY: 'qz:test-key',
      LIST_MODELS: 'qz:list-models',
      OPEN_SETTINGS: 'qz:open-settings',
    }),

    LIMITS: Object.freeze({
      MAX_QUESTIONS: 60, // per scan, across all frames
      BATCH_SIZE: 12, // questions per API request
      STEM_CHARS: 1500,
      CONTEXT_CHARS: 1200,
      OPTION_CHARS: 400,
      MAX_OPTIONS: 12,
      REQUEST_TIMEOUT_MS: 90_000,
      MAX_RETRIES: 2,
    }),
  });
})();
