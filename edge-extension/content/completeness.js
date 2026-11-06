/*
 * Scan completeness.
 *
 *  - waitForStable(): before parsing, wait until the DOM stops changing and
 *    no loading indicator is visible, so questions that are still rendering
 *    (SPA routes, lazy quiz parts) aren't missed.
 *  - assess(): compares what the parser found with what the page implies —
 *    "Question 3 of 10" counters and gaps in question numbering — and counts
 *    embedded frames, so the service worker can report what's missing.
 */
(() => {
  const QZ = (globalThis.QZ = globalThis.QZ || {});
  if (QZ.completeness) return;

  const BUSY_SELECTOR = [
    '[aria-busy="true"]',
    '[role="progressbar"]:not([aria-valuenow])',
    '.spinner',
    '.loading',
    '.loader',
    '.skeleton',
    '[class*="spinner" i]',
    '[class*="skeleton" i]',
    '[data-testid*="loading" i]',
  ].join(',');

  function visibleBusyIndicator() {
    for (const el of document.querySelectorAll(BUSY_SELECTOR)) {
      if (el.closest('quizzers-ui')) continue;
      if (QZ.guards.isRendered(el)) return true;
    }
    return false;
  }

  /**
   * Resolves once the page has been quiet for `quietMs` with no visible busy
   * indicator, or after `timeoutMs` at the latest.
   * @returns {Promise<{stable: boolean, waitedMs: number}>}
   */
  function waitForStable({ quietMs = 400, timeoutMs = 4000 } = {}) {
    const started = performance.now();
    return new Promise((resolve) => {
      let quietTimer = null;
      let done = false;
      const finish = (stable) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        resolve({ stable, waitedMs: Math.round(performance.now() - started) });
      };
      const arm = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          if (document.readyState === 'complete' && !visibleBusyIndicator()) finish(true);
          else arm();
        }, quietMs);
      };
      const observer = new MutationObserver((records) => {
        // Ignore our own UI and highlight attributes.
        if (records.every((r) => r.target.nodeType === 1 && (r.target.closest?.('quizzers-ui') || r.attributeName?.startsWith('data-qz')))) return;
        arm();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-busy'] });
      const hardTimer = setTimeout(() => finish(false), timeoutMs);
      arm();
    });
  }

  const COUNTER_RE = /\bquestion\s+(\d{1,3})\s*(?:of|\/)\s*(\d{1,3})\b/gi;
  const LEADING_NUMBER_RE = /^\s*(?:q(?:uestion)?\s*)?(\d{1,3})\s*[.):]/i;

  /** Number printed at the start of a question ("3. …", "Question 3:"), if any. */
  function questionNumber(q) {
    for (const s of [q.stem, q.context]) {
      const m = String(s || '').match(LEADING_NUMBER_RE);
      if (m) return Number(m[1]);
    }
    return null;
  }

  function visibleFrameCount() {
    let n = 0;
    for (const frame of document.querySelectorAll('iframe, frame')) {
      if (frame.matches(QZ.guards.CAPTCHA_WIDGET_SELECTOR)) continue;
      if (QZ.guards.isCaptchaUrl(frame.src || '')) continue;
      if (!frame.src || frame.src.startsWith('about:') || frame.src.startsWith('javascript:')) continue;
      if (QZ.guards.isRendered(frame)) n++;
    }
    return n;
  }

  /**
   * @param {Array<{stem: string, context?: string}>} questions found in this frame
   * @returns {{numbers: number[], declaredTotal: number|null, childFrames: number}}
   */
  function assess(questions) {
    let declaredTotal = null;
    const body = document.body ? document.body.innerText.slice(0, 200_000) : '';
    for (const m of body.matchAll(COUNTER_RE)) {
      const total = Number(m[2]);
      if (total >= Number(m[1]) && total <= 500) declaredTotal = Math.max(declaredTotal || 0, total);
    }
    const numbers = questions.map(questionNumber).filter((n) => Number.isInteger(n) && n > 0);
    return { numbers, declaredTotal, childFrames: visibleFrameCount() };
  }

  QZ.completeness = Object.freeze({ waitForStable, assess, questionNumber });
})();
