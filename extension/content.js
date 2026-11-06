/*
 * Content-script entry point (runs in every matching frame).
 *
 * Exposes `QZ.app` — collect / highlight / focus / clear — which the service
 * worker calls per frame via chrome.scripting.executeScript, so questions in
 * iframes (e.g. edX units) are gathered into a single API request. The top
 * frame additionally mounts the floating UI and renders scan progress.
 */
(() => {
  const QZ = globalThis.QZ;
  if (!QZ || QZ.app) return; // already initialised (e.g. injected twice)

  const { MSG } = QZ.config;
  const isTop = window.top === window;
  const inCaptchaFrame = QZ.guards.isCaptchaUrl(location.href);

  let lastScan = null; // { token, entries }
  let scanSeq = 0;

  const app = {
    /** Parses this frame. Returns serializable data only. */
    async collect(opts = {}) {
      QZ.highlighter.clear();
      const token = `${Date.now().toString(36)}-${++scanSeq}`;
      if (inCaptchaFrame) {
        lastScan = { token, entries: [] };
        return { token, isTop, blocked: 'captcha-frame', skipped: { captcha: 1 }, questions: [], title: '' };
      }
      // Let still-rendering content settle so the scan sees the whole page.
      const settle = opts.waitForStable === false ? { stable: true, waitedMs: 0 } : await QZ.completeness.waitForStable(opts.stability);
      const result = QZ.parser.findQuestions(opts);
      lastScan = { token, entries: result.entries };
      return {
        token,
        isTop,
        blocked: result.blocked,
        skipped: result.skipped,
        questions: result.questions,
        completeness: { ...QZ.completeness.assess(result.questions), stable: settle.stable, waitedMs: settle.waitedMs },
        title: isTop ? document.title : '',
      };
    },

    /**
     * @param {string} token from the matching collect() call
     * @param {Array<{localId:number, indices:number[], confidence:number|null, reasoning:string}>} items
     */
    highlight(token, items) {
      if (!lastScan || lastScan.token !== token) {
        return items.map((item) => ({ localId: item.localId, applied: false, reason: 'stale' }));
      }
      return items.map((item) => {
        const entry = lastScan.entries[item.localId];
        if (!entry) return { localId: item.localId, applied: false, reason: 'stale' };
        if (entry.type === 'text') {
          if (!item.text) return { localId: item.localId, applied: false, reason: 'empty' };
          if (!item.fillText) {
            QZ.highlighter.markOption({ row: entry.field }, { confidence: item.confidence, reasoning: `Suggested answer: ${item.text}` });
            return { localId: item.localId, applied: true, outcome: 'suggested' };
          }
          const outcome = QZ.highlighter.fillText(entry.field, item.text, { reasoning: item.reasoning });
          return { localId: item.localId, applied: outcome !== 'gone', outcome, reason: outcome === 'gone' ? 'stale' : null };
        }
        let applied = false;
        for (const index of item.indices) {
          const option = entry.options[index];
          const connected = option && (option.row ? option.row.isConnected : option.range?.startContainer.isConnected);
          if (!connected) continue;
          applied =
            QZ.highlighter.markOption(option, {
              confidence: item.confidence,
              reasoning: item.reasoning,
              optionText: item.optionTexts?.[index],
              uncertain: item.uncertain?.includes(index),
            }) || applied;
        }
        return { localId: item.localId, applied, reason: applied ? null : 'stale' };
      });
    },

    focus(token, localId) {
      const entry = lastScan && lastScan.token === token ? lastScan.entries[localId] : null;
      return entry ? QZ.highlighter.focus(entry) : false;
    },

    clear() {
      QZ.highlighter.clear();
      return true;
    },
  };
  QZ.app = app;

  if (!isTop || inCaptchaFrame) return;

  /* ---------- top frame: floating UI ---------- */

  async function send(message) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response && !response.ok && response.error) QZ.ui.render({ phase: 'error', error: response.error });
      return response;
    } catch (err) {
      QZ.ui.render({ phase: 'error', error: QZ.errors.toPlain(err) });
      return null;
    }
  }

  QZ.ui.mount({
    onScan: () => {
      QZ.ui.render({ phase: 'scanning' });
      send({ type: MSG.SCAN_TAB });
    },
    onClear: () => send({ type: MSG.CLEAR_TAB }),
    onOpenSettings: () => send({ type: MSG.OPEN_SETTINGS }),
    onFocus: (result) => {
      if (result.frameId === 0) app.focus(result.token, result.localId);
      else send({ type: MSG.FOCUS_QUESTION, frameId: result.frameId, documentId: result.documentId, token: result.token, localId: result.localId });
    },
    onMove: (offset) => {
      QZ.settings.save({ buttonOffset: offset }).catch(() => {});
    },
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === MSG.STATE) QZ.ui.render(msg.state);
    return false;
  });

  QZ.settings
    .load(QZ.settings.UI_KEYS)
    .then((prefs) => QZ.ui.configure(prefs))
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const prefs = {};
    if (changes.showFloatingButton) prefs.showFloatingButton = changes.showFloatingButton.newValue !== false;
    if (changes.buttonOffset && Number.isFinite(changes.buttonOffset.newValue)) prefs.buttonOffset = changes.buttonOffset.newValue;
    if (Object.keys(prefs).length) QZ.ui.configure(prefs);
  });

  // Single-page apps (Coursera, the edX MFE) change routes without reloading:
  // drop stale results and highlights when the URL changes.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    lastScan = null;
    QZ.highlighter.clear();
    QZ.ui.reset();
  }, 1000);
})();
