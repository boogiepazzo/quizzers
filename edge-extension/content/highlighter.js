/*
 * Highlight rendering.
 *
 * Visual only: it sets a data attribute (styled by content.css), a tooltip,
 * and — for options that are bare text runs — a CSS Custom Highlight range.
 * It never clicks, focuses, checks, selects or dispatches events on page
 * elements, so the user always makes the final choice themselves.
 *
 * A data attribute is used instead of a class because frameworks such as
 * React overwrite `className` on re-render but leave unknown attributes alone.
 */
(() => {
  const QZ = (globalThis.QZ = globalThis.QZ || {});
  if (QZ.highlighter) return;

  const ATTR = 'data-qz-highlight';
  const FLASH_ATTR = 'data-qz-flash';
  const RANGE_NAMES = { high: 'qz-correct', low: 'qz-correct-low' };

  const marked = new Set();
  const originalTitles = new Map(); // element -> original title (null = none)
  let flashTimer = null;
  let flashed = null;

  const supportsRangeHighlights = () =>
    typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  function markElement(el, level, tooltip) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    marked.add(el);
    el.setAttribute(ATTR, level);
    if (tooltip) {
      if (!originalTitles.has(el)) originalTitles.set(el, el.getAttribute('title'));
      el.setAttribute('title', tooltip);
    }
    return true;
  }

  function addRange(range, level) {
    if (!supportsRangeHighlights()) return false;
    const name = RANGE_NAMES[level];
    let highlight = CSS.highlights.get(name);
    if (!highlight) {
      highlight = new Highlight();
      CSS.highlights.set(name, highlight);
    }
    highlight.add(range);
    return true;
  }

  function tooltipFor({ confidence, reasoning, optionText }, isSelect) {
    const pct = typeof confidence === 'number' ? ` · ${Math.round(confidence * 100)}% confident` : '';
    const head = isSelect ? `Quizzers suggests: ${optionText}` : 'Quizzers suggestion';
    return `${head}${pct}${reasoning ? `\n${reasoning}` : ''}`;
  }

  /**
   * Highlights one option.
   * @param {{row?: Element, range?: Range, input?: Element, optionEl?: HTMLOptionElement}} option
   * @param {{confidence: number|null, reasoning?: string, optionText?: string}} info
   * @returns {boolean} whether anything visible was marked
   */
  function markOption(option, info) {
    const level = typeof info.confidence === 'number' && info.confidence < 0.5 ? 'low' : 'high';
    if (option.optionEl) {
      // <select>: style the control and the <option> inside its popup.
      markElement(option.optionEl, level);
      return markElement(option.row, level, tooltipFor(info, true));
    }
    let ok = false;
    if (option.row) ok = markElement(option.row, level, tooltipFor(info, false)) || ok;
    if (option.range) {
      ok = addRange(option.range, level) || ok;
      if (option.input) ok = markElement(option.input, level, tooltipFor(info, false)) || ok;
    }
    return ok;
  }

  function clearFlash() {
    clearTimeout(flashTimer);
    if (flashed) flashed.removeAttribute(FLASH_ATTR);
    flashed = null;
  }

  function clear() {
    clearFlash();
    for (const el of marked) {
      el.removeAttribute(ATTR);
      if (originalTitles.has(el)) {
        const original = originalTitles.get(el);
        if (original === null) el.removeAttribute('title');
        else el.setAttribute('title', original);
      }
    }
    marked.clear();
    originalTitles.clear();
    if (supportsRangeHighlights()) {
      CSS.highlights.delete(RANGE_NAMES.high);
      CSS.highlights.delete(RANGE_NAMES.low);
    }
  }

  /** Scrolls a question into view and briefly pulses it. Does not focus it. */
  function focus(entry) {
    const target = entry.anchor?.isConnected ? entry.anchor : entry.container;
    if (!target?.isConnected) return false;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    clearFlash();
    flashed = entry.container?.isConnected ? entry.container : target;
    flashed.setAttribute(FLASH_ATTR, '');
    flashTimer = setTimeout(clearFlash, 1800);
    return true;
  }

  QZ.highlighter = Object.freeze({ markOption, clear, focus, ATTR });
})();
