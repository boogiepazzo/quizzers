/*
 * Typed access to chrome.storage.local.
 *
 * The API key lives only in chrome.storage.local (never sync, never sent to a
 * content script). Content scripts read UI-only keys via `load(UI_KEYS)`.
 */
(() => {
  const QZ = (globalThis.QZ = globalThis.QZ || {});
  if (QZ.settings) return;

  const DEFAULTS = Object.freeze({
    apiKey: '',
    model: QZ.config.DEFAULT_MODEL,
    scanScope: 'page', // 'page' | 'viewport'
    showFloatingButton: true,
    fillTextAnswers: true, // write editable drafts into empty short-answer fields
    buttonOffset: null, // px from the bottom of the viewport; null = default
    modelCache: null, // { fetchedAt, models: [{id, name, structured}] }
  });

  const UI_KEYS = Object.freeze(['showFloatingButton', 'buttonOffset']);

  function normalize(raw) {
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (raw[key] !== undefined && raw[key] !== null) out[key] = raw[key];
    }
    out.apiKey = String(out.apiKey || '').trim();
    out.model = String(out.model || '').trim() || DEFAULTS.model;
    out.scanScope = out.scanScope === 'viewport' ? 'viewport' : 'page';
    out.showFloatingButton = out.showFloatingButton !== false;
    out.fillTextAnswers = out.fillTextAnswers !== false;
    out.buttonOffset = Number.isFinite(out.buttonOffset) ? out.buttonOffset : null;
    return out;
  }

  /** @param {string[]} [keys] subset of settings to read (defaults to all) */
  async function load(keys = Object.keys(DEFAULTS)) {
    const raw = await chrome.storage.local.get(keys);
    const all = normalize(raw);
    return Object.fromEntries(keys.map((k) => [k, all[k]]));
  }

  async function save(partial) {
    const clean = {};
    for (const [key, value] of Object.entries(partial)) {
      if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
      clean[key] = typeof value === 'string' ? value.trim() : value;
    }
    await chrome.storage.local.set(clean);
  }

  QZ.settings = Object.freeze({ DEFAULTS, UI_KEYS, load, save });
})();
