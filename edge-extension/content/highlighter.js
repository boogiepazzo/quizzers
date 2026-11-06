/*
 * Highlight rendering.
 *
 * For choice questions it is visual only: a data attribute (styled by
 * content.css), a tooltip and — for bare text runs — a CSS Custom Highlight
 * range. It never clicks, focuses, checks or selects options.
 *
 * For short free-text questions it writes an editable draft into the field
 * (only if the field is empty) and fires input/change so the page registers
 * it. It never submits; the user reviews and edits the draft.
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
  const filled = new Map(); // field -> { value we wrote, original placeholder state }
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
    const level = info.uncertain ? 'maybe' : typeof info.confidence === 'number' && info.confidence < 0.5 ? 'low' : 'high';
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

  /** Writes through the native setter so frameworks (React, Vue) see the change. */
  function setFieldValue(field, value) {
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Fills a short-answer field with a draft the user can edit. Only empty
   * fields are filled (never overwrites what the user typed); nothing is
   * submitted or focused.
   * @returns {'filled'|'not-empty'|'gone'}
   */
  function fillText(field, value, info = {}) {
    if (!field?.isConnected) return 'gone';
    if (field.value.trim()) {
      // Show the suggestion without touching what the user wrote.
      markElement(field, 'suggested', `Quizzers suggests: ${value}${info.reasoning ? `\n${info.reasoning}` : ''}`);
      return 'not-empty';
    }
    setFieldValue(field, value);
    filled.set(field, value);
    markElement(field, 'filled', `Draft answer filled by Quizzers — edit it as you like.${info.reasoning ? `\n${info.reasoning}` : ''}`);
    return 'filled';
  }

  /** Removes drafts that the user hasn't edited. */
  function clearFilled() {
    for (const [field, value] of filled) {
      if (field.isConnected && field.value === value) setFieldValue(field, '');
    }
    filled.clear();
  }

  function clearFlash() {
    clearTimeout(flashTimer);
    if (flashed) flashed.removeAttribute(FLASH_ATTR);
    flashed = null;
  }

  function clear({ keepDrafts = false } = {}) {
    clearFlash();
    if (!keepDrafts) clearFilled();
    else filled.clear();
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

  QZ.highlighter = Object.freeze({ markOption, fillText, clear, focus, ATTR });
})();
