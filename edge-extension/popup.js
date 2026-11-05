/*
 * Popup / options page: API key, model selection, scan preferences, and a
 * "Scan this tab" button (which also works on sites outside the default list,
 * via the activeTab permission granted by opening the popup).
 */
(() => {
  const { MSG, MODEL_PRESETS } = QZ.config;
  const CUSTOM = '__custom__';
  const MODEL_ID_RE = /^[a-z0-9][\w.-]*\/[\w.:~@+-]+$/i;

  const $ = (id) => document.getElementById(id);
  const els = {
    scanCard: $('scan-card'),
    scanBtn: $('scan-btn'),
    scanStatus: $('scan-status'),
    form: $('settings-form'),
    apiKey: $('api-key'),
    toggleKey: $('toggle-key'),
    model: $('model'),
    customModel: $('custom-model'),
    loadModels: $('load-models'),
    modelsStatus: $('models-status'),
    showButton: $('show-button'),
    testKey: $('test-key'),
    settingsStatus: $('settings-status'),
    shortcut: $('shortcut'),
  };

  let cachedModels = [];

  function setStatus(el, message, kind) {
    el.textContent = message || '';
    if (kind) el.dataset.kind = kind;
    else delete el.dataset.kind;
  }

  async function send(message) {
    const res = await chrome.runtime.sendMessage(message);
    if (!res) throw new Error('No response from the extension background. Try reopening the popup.');
    if (!res.ok) {
      const err = new Error(res.error?.message || 'Request failed.');
      err.code = res.error?.code;
      throw err;
    }
    return res.data;
  }

  /* ---------- model picker ---------- */

  function group(label, options) {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...options);
    return g;
  }

  function populateModels(selected) {
    const presetIds = new Set(MODEL_PRESETS.map((m) => m.id));
    const select = els.model;
    select.replaceChildren(
      group(
        'Recommended',
        MODEL_PRESETS.map((m) => {
          const o = new Option(m.label, m.id);
          o.title = m.id;
          return o;
        })
      )
    );
    const extra = cachedModels.filter((m) => !presetIds.has(m.id));
    if (extra.length) {
      select.append(
        group(
          'All OpenRouter models',
          extra.map((m) => {
            const o = new Option(m.structured ? m.id : `${m.id} (no JSON mode)`, m.id);
            o.title = m.name;
            return o;
          })
        )
      );
    }
    select.append(group('Other', [new Option('Custom model ID…', CUSTOM)]));

    const known = Array.from(select.options).some((o) => o.value === selected && o.value !== CUSTOM);
    if (known) {
      select.value = selected;
      els.customModel.hidden = true;
    } else {
      select.value = CUSTOM;
      els.customModel.hidden = false;
      els.customModel.value = selected || '';
    }
  }

  function currentModel() {
    return els.model.value === CUSTOM ? els.customModel.value.trim() : els.model.value;
  }

  /* ---------- form ---------- */

  function readForm() {
    return {
      apiKey: els.apiKey.value.trim(),
      model: currentModel(),
      scanScope: els.form.querySelector('input[name="scope"]:checked')?.value === 'viewport' ? 'viewport' : 'page',
      showFloatingButton: els.showButton.checked,
    };
  }

  async function save({ quiet = false } = {}) {
    const values = readForm();
    if (!MODEL_ID_RE.test(values.model)) {
      setStatus(els.settingsStatus, 'Enter a model ID like “vendor/model-name”.', 'error');
      els.customModel.hidden = false;
      els.customModel.focus();
      return null;
    }
    await QZ.settings.save(values);
    if (!quiet) {
      const warn = values.apiKey && !values.apiKey.startsWith('sk-or-') ? ' (Note: OpenRouter keys usually start with “sk-or-”.)' : '';
      setStatus(els.settingsStatus, values.apiKey ? `Saved.${warn}` : 'Saved. Add an API key to start scanning.', values.apiKey ? 'ok' : undefined);
    }
    return values;
  }

  async function init() {
    const inTab = Boolean(await chrome.tabs.getCurrent());
    if (inTab) {
      // Opened as the options page: there is no "current tab" to scan.
      document.body.classList.add('tab');
      els.scanCard.hidden = true;
    }

    const s = await QZ.settings.load();
    els.apiKey.value = s.apiKey;
    cachedModels = s.modelCache?.models || [];
    populateModels(s.model);
    const scope = els.form.querySelector(`input[name="scope"][value="${s.scanScope}"]`);
    if (scope) scope.checked = true;
    els.showButton.checked = s.showFloatingButton;

    const commands = await chrome.commands.getAll().catch(() => []);
    const shortcut = commands.find((c) => c.name === 'scan-page')?.shortcut;
    els.shortcut.replaceChildren();
    if (shortcut) {
      const kbd = document.createElement('kbd');
      kbd.textContent = shortcut;
      els.shortcut.append(' Shortcut: ', kbd, '.');
    } else {
      els.shortcut.append(' Set a keyboard shortcut at edge://extensions/shortcuts.');
    }

    if (!s.apiKey) {
      setStatus(els.settingsStatus, 'Add your OpenRouter API key to get started.');
      els.apiKey.focus();
    }
  }

  /* ---------- events ---------- */

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    save().catch((err) => setStatus(els.settingsStatus, err.message, 'error'));
  });

  // Preferences apply immediately (the floating button updates live).
  els.showButton.addEventListener('change', () => QZ.settings.save({ showFloatingButton: els.showButton.checked }));
  els.form.querySelectorAll('input[name="scope"]').forEach((radio) =>
    radio.addEventListener('change', () => QZ.settings.save({ scanScope: readForm().scanScope }))
  );

  els.model.addEventListener('change', () => {
    const custom = els.model.value === CUSTOM;
    els.customModel.hidden = !custom;
    if (custom) els.customModel.focus();
  });

  els.toggleKey.addEventListener('click', () => {
    const show = els.apiKey.type === 'password';
    els.apiKey.type = show ? 'text' : 'password';
    els.toggleKey.textContent = show ? 'Hide' : 'Show';
    els.toggleKey.setAttribute('aria-pressed', String(show));
  });

  els.testKey.addEventListener('click', async () => {
    const apiKey = els.apiKey.value.trim();
    if (!apiKey) {
      setStatus(els.settingsStatus, 'Enter an API key first.', 'error');
      els.apiKey.focus();
      return;
    }
    els.testKey.disabled = true;
    setStatus(els.settingsStatus, 'Checking key…');
    try {
      const info = await send({ type: MSG.TEST_KEY, apiKey });
      const parts = ['Key works'];
      if (info.label) parts.push(`(“${info.label}”)`);
      if (typeof info.usage === 'number') parts.push(`· $${info.usage.toFixed(2)} used`);
      if (typeof info.limitRemaining === 'number') parts.push(`· $${info.limitRemaining.toFixed(2)} remaining`);
      else if (info.limit === null) parts.push('· no spending limit');
      setStatus(els.settingsStatus, `${parts.join(' ')}.`, 'ok');
    } catch (err) {
      setStatus(els.settingsStatus, err.message, 'error');
    } finally {
      els.testKey.disabled = false;
    }
  });

  els.loadModels.addEventListener('click', async () => {
    els.loadModels.disabled = true;
    setStatus(els.modelsStatus, ' Loading…');
    try {
      const models = await send({ type: MSG.LIST_MODELS });
      cachedModels = models.map(({ id, name, structured }) => ({ id, name, structured }));
      await QZ.settings.save({ modelCache: { fetchedAt: Date.now(), models: cachedModels } });
      populateModels(currentModel());
      setStatus(els.modelsStatus, ` ${models.length} models loaded.`, 'ok');
    } catch (err) {
      setStatus(els.modelsStatus, ` ${err.message}`, 'error');
    } finally {
      els.loadModels.disabled = false;
    }
  });

  els.scanBtn.addEventListener('click', async () => {
    const values = await save({ quiet: true }).catch(() => null);
    if (!values) return;
    if (!values.apiKey) {
      setStatus(els.scanStatus, 'Add your OpenRouter API key below first.', 'error');
      els.apiKey.focus();
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus(els.scanStatus, 'No active tab to scan.', 'error');
      return;
    }
    els.scanBtn.disabled = true;
    setStatus(els.scanStatus, 'Scanning… results appear on the page.');
    try {
      const r = await send({ type: MSG.SCAN_TAB, tabId: tab.id });
      if (r.found) setStatus(els.scanStatus, `Highlighted ${r.highlighted} of ${r.found} question${r.found === 1 ? '' : 's'}.`, 'ok');
      else setStatus(els.scanStatus, 'No visible multiple-choice questions found on this page.');
    } catch (err) {
      setStatus(els.scanStatus, err.message, 'error');
    } finally {
      els.scanBtn.disabled = false;
    }
  });

  init().catch((err) => setStatus(els.settingsStatus, `Could not load settings: ${err.message}`, 'error'));
})();
