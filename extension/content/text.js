/*
 * Visible-text extraction.
 *
 * Walks the DOM instead of using innerText so that it can (a) skip content a
 * person cannot see — hidden, clipped, zero-size or same-colour-as-background
 * text, a common honeypot/trap technique — and (b) recover TeX from rendered
 * math (MathJax v2/v3, KaTeX, MathML) instead of glyph soup.
 */
(() => {
  const QZ = (globalThis.QZ = globalThis.QZ || {});
  if (QZ.text) return;

  const SKIP_TAGS = new Set([
    'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED',
    'CANVAS', 'VIDEO', 'AUDIO', 'SVG', 'BUTTON', 'INPUT', 'TEXTAREA', 'OPTION', 'DATALIST', 'QUIZZERS-UI',
  ]);

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
    'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LEGEND', 'LI', 'MAIN', 'OL', 'P', 'PRE',
    'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
  ]);

  const MATHJAX2_VISUAL = ['MathJax', 'MathJax_SVG', 'MathJax_CHTML', 'MathJax_Display', 'MathJax_SVG_Display', 'MJXc-display', 'MathJax_Preview'];

  function texAnnotation(el) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
    return ann ? ann.textContent.trim() : '';
  }

  /**
   * Returns replacement text for math elements, '' to drop an element whose
   * content is duplicated elsewhere, or null for non-math elements.
   */
  function mathText(el) {
    const tag = el.tagName.toUpperCase(); // SVG/MathML tag names keep their case
    if (tag === 'MJX-CONTAINER') {
      const tex = texAnnotation(el);
      if (tex) return `$${tex}$`;
      const mml = el.querySelector('mjx-assistive-mml math');
      const alt = mml?.getAttribute('alttext');
      if (alt) return `$${alt}$`;
      return (mml?.textContent || el.getAttribute('aria-label') || el.textContent || '').trim();
    }
    if (tag === 'MATH') {
      const tex = texAnnotation(el) || el.getAttribute('alttext');
      return tex ? `$${tex}$` : el.textContent.trim();
    }
    const cls = el.classList;
    if (cls.contains('katex')) {
      const tex = texAnnotation(el);
      return tex ? `$${tex}$` : null;
    }
    // MathJax v2 keeps the TeX source in a sibling <script type="math/tex">,
    // which the walker reads; drop the rendered duplicate.
    if (MATHJAX2_VISUAL.some((c) => cls.contains(c)) || /^MathJax-Element-\d+-Frame$/.test(el.id)) return '';
    if (cls.contains('MJX_Assistive_MathML')) return '';
    return null;
  }

  function clean(s) {
    return String(s || '')
      .replace(/ /g, ' ')
      .replace(/[ \t\f\v\r]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function truncate(s, max) {
    if (!max || s.length <= max) return s;
    return `${s.slice(0, max - 1).trimEnd()}…`;
  }

  /**
   * @param {Node} root
   * @param {{exclude?: Set<Node>, visibleOnly?: boolean, maxLength?: number}} [opts]
   */
  function extract(root, opts = {}) {
    if (!root) return '';
    const exclude = opts.exclude || null;
    const visibleOnly = opts.visibleOnly !== false;
    const maxLength = opts.maxLength || 6000;
    const guards = QZ.guards;
    const out = [];
    let length = 0;

    const push = (s) => {
      if (s) {
        out.push(s);
        length += s.length;
      }
    };

    // Source-code whitespace collapses to a single space (as browsers render
    // it) unless the element preserves it (white-space: pre*).
    const walkChildren = (parent, textHidden, preserve) => {
      for (let child = parent.firstChild; child && length <= maxLength * 1.5; child = child.nextSibling) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (!textHidden) push(preserve ? child.nodeValue : child.nodeValue.replace(/[ \t\n\r\f]+/g, ' '));
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child);
        }
      }
    };

    const preservesWhitespace = (el) => {
      if (el.tagName === 'PRE') return true;
      const ws = getComputedStyle(el).whiteSpace;
      return ws.startsWith('pre') || ws === 'break-spaces';
    };

    const walk = (el) => {
      if (exclude && exclude.has(el)) return;
      const tag = el.tagName.toUpperCase(); // SVG/MathML tag names keep their case
      if (tag === 'SCRIPT') {
        if (/math\/tex/i.test(el.type)) push(` $${el.textContent.trim()}$ `);
        return;
      }
      if (tag === 'SELECT') {
        push(' ____ ');
        return;
      }
      if (SKIP_TAGS.has(tag)) return;
      if (tag === 'BR') {
        push('\n');
        return;
      }
      if (visibleOnly && guards.isSubtreeHidden(el)) return;
      if (tag === 'IMG') {
        const alt = (el.getAttribute('alt') || '').trim();
        if (alt) push(` [image: ${alt}] `);
        return;
      }
      const math = mathText(el);
      if (math !== null) {
        if (math) push(` ${math} `);
        return;
      }
      const block = BLOCK_TAGS.has(tag);
      if (block) push('\n');
      const textHidden = visibleOnly && guards.isOwnTextHidden(el);
      const preserve = preservesWhitespace(el);
      if (el.shadowRoot) walkChildren(el.shadowRoot, textHidden, preserve);
      else walkChildren(el, textHidden, preserve);
      if (block) push('\n');
    };

    if (root.nodeType === Node.TEXT_NODE) push(root.nodeValue.replace(/[ \t\n\r\f]+/g, ' '));
    else if (root.nodeType === Node.ELEMENT_NODE) walk(root);
    else if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) walkChildren(root, false, false);

    return truncate(clean(out.join('')), maxLength);
  }

  /** Text of a Range, honouring visibility of the elements it spans. */
  function extractRange(range, opts = {}) {
    const fragmentText = [];
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(
      root.nodeType === Node.ELEMENT_NODE ? root : root.parentNode,
      NodeFilter.SHOW_TEXT
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!range.intersectsNode(node)) continue;
      const parent = node.parentElement;
      if (opts.visibleOnly !== false && parent && (QZ.guards.isSubtreeHidden(parent) || QZ.guards.isOwnTextHidden(parent))) continue;
      let value = node.nodeValue;
      if (node === range.endContainer) value = value.slice(0, range.endOffset);
      if (node === range.startContainer) value = value.slice(range.startOffset);
      fragmentText.push(value);
    }
    return truncate(clean(fragmentText.join('')), opts.maxLength || 6000);
  }

  QZ.text = Object.freeze({ extract, extractRange, clean, truncate });
})();
