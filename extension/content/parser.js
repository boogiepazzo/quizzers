/*
 * MCQ detection.
 *
 * Strategies run in priority order; each one "claims" the nodes it uses so
 * later, looser strategies don't double-count them:
 *   1. native   — <input type=radio|checkbox> grouped by name / structure
 *   2. aria     — role=radio|checkbox|option custom widgets
 *   3. select   — <select> dropdown questions
 *   4. custom   — class-named containers (.question > .choice, .option, …)
 *   5. lettered — "A) … B) …" lists, paragraphs or <br>-separated lines
 *
 * Every candidate then passes the guards: hidden / honeypot options are
 * dropped, CAPTCHA-related and verification-prompt questions are skipped.
 */
(() => {
  const QZ = (globalThis.QZ = globalThis.QZ || {});
  if (QZ.parser) return;

  const { guards, text } = QZ;
  const { LIMITS } = QZ.config;

  const PLATFORM_CONTAINERS = [
    {
      host: /(^|\.)(edx\.org|mitxonline\.mit\.edu|openlearninglibrary\.mit\.edu)$/i,
      selector: '.problem, .wrapper-problem-response, .xblock-student_view-problem',
    },
    {
      host: /(^|\.)coursera\.org$/i,
      selector: '[data-testid^="part-Submission_"], .rc-FormPartsQuestion, [data-testid*="question" i]',
    },
    { host: /(^|\.)ocw\.mit\.edu$/i, selector: '.problem, .question, .quiz-question, .multiple-choice' },
  ];
  const GENERIC_CONTAINERS = '[data-question-id], [data-question], .question, .quiz-question, .mcq';
  const HARD_STOP_TAGS = new Set(['BODY', 'HTML', 'MAIN']);
  const GROUP_SELECTOR = '[role="radiogroup"], [role="group"], [role="listbox"]';
  const GENERIC_LABEL_RE = /^\s*((question|q)\s*\d+|options|choices|answers?|answer choices|select (one|all that apply)|choose (one|all that apply))\s*:?\s*$/i;
  const QUESTION_LIKE_RE =
    /\?\s*$|:\s*$|\b(which|what|who|whom|whose|when|where|why|how|select|choose|identify|true or false|correct|best|following|statement)\b|^\s*(q(uestion)?\s*)?\d+[).:]/im;
  const MARKER_RE = /^\s*(?:\(([a-z])\)|([a-z])[).:])\s+/i;
  const NAV_SELECT_RE =
    /(lang|locale|sort|order[-_]?by|filter|per[-_]?page|page[-_]?size|country|currency|time[-_]?zone|region|theme|font|speed|playback|quality|caption|subtitle|transcript|jump|navigation|menu)/i;
  const BLOCKISH_TAGS = new Set(['P', 'DIV', 'LI', 'TD', 'TH', 'DD', 'DT', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'LABEL', 'FIELDSET', 'FORM']);

  /* ---------- small DOM helpers ---------- */

  const asElement = (n) => (n && n.nodeType === Node.ELEMENT_NODE ? n : n?.parentElement || null);

  function commonAncestor(nodes) {
    const els = nodes.map(asElement).filter(Boolean);
    if (!els.length) return null;
    let anc = els[0];
    for (let i = 1; i < els.length && anc; i++) {
      while (anc && !anc.contains(els[i])) anc = anc.parentElement;
    }
    return anc;
  }

  function docOrder(a, b) {
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function isClaimed(el, claimed) {
    for (let a = el; a; a = a.parentElement) if (claimed.has(a)) return true;
    return false;
  }

  function containsOtherInput(el, input, groupSet) {
    for (const other of groupSet) if (other !== input && el.contains(other)) return true;
    return false;
  }

  function labelElementsFor(el) {
    const out = [];
    if (el.labels) out.push(...el.labels);
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const l = el.ownerDocument.getElementById(id);
      if (l && !out.includes(l)) out.push(l);
    }
    if (!out.length) {
      const wrap = el.closest('label');
      if (wrap) out.push(wrap);
    }
    return out;
  }

  function markerOf(str) {
    const m = String(str || '').match(MARKER_RE);
    if (!m) return null;
    const ch = (m[1] || m[2]).toLowerCase();
    return { index: ch.charCodeAt(0) - 97 };
  }

  function isBlockish(el) {
    if (BLOCKISH_TAGS.has(el.tagName)) return true;
    const d = getComputedStyle(el).display;
    return d !== 'inline' && d !== 'contents' && !d.startsWith('inline');
  }

  /* ---------- strategy 1: native radios & checkboxes ---------- */

  /** Inline layout without labels: "<input> text <br> <input> text". */
  function rangeAfterInput(input, groupSet) {
    let last = input;
    for (let node = input.nextSibling; node; node = node.nextSibling) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'BR' || groupSet.has(node) || node.querySelector('input') || BLOCKISH_TAGS.has(node.tagName)) break;
      }
      last = node;
    }
    if (last === input) return null;
    const range = document.createRange();
    range.setStartAfter(input);
    range.setEndAfter(last);
    return range;
  }

  function nativeOption(input, groupSet) {
    const label = labelElementsFor(input).find((l) => !containsOtherInput(l, input, groupSet)) || null;
    let row = null;
    if (label) {
      if (label.contains(input)) row = label;
      else {
        const lca = commonAncestor([input, label]);
        row = lca && !HARD_STOP_TAGS.has(lca.tagName) && !containsOtherInput(lca, input, groupSet) ? lca : label;
      }
      return { row, input, textEl: label };
    }
    const parent = input.parentElement;
    if (parent && !HARD_STOP_TAGS.has(parent.tagName) && !containsOtherInput(parent, input, groupSet)) {
      return { row: parent, input, textEl: parent };
    }
    const range = rangeAfterInput(input, groupSet);
    return range ? { row: null, range, input } : { row: input, input, textEl: null };
  }

  function collectNative(root) {
    const inputs = Array.from(root.querySelectorAll('input[type="radio" i], input[type="checkbox" i]'));
    const named = new Map(); // scope -> Map(key -> inputs)
    const loose = [];
    for (const input of inputs) {
      if (!input.name) {
        loose.push(input);
        continue;
      }
      const scope = input.form || input.getRootNode();
      if (!named.has(scope)) named.set(scope, new Map());
      const key = `${input.type.toLowerCase()}\u0000${input.name}`;
      const byKey = named.get(scope);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(input);
    }

    const groups = [];
    for (const byKey of named.values()) {
      for (const list of byKey.values()) {
        if (list.length >= 2) groups.push(list);
        else loose.push(list[0]);
      }
    }

    // Unnamed / uniquely named inputs (common for checkboxes): group by an
    // explicit group container, else by the nearest shared ancestor of their
    // rows, widening one level at a time so unrelated widgets stay separate.
    let pending = [];
    const explicit = new Map();
    for (const input of loose) {
      const box = input.closest(`fieldset, ${GROUP_SELECTOR}`);
      if (box) {
        const key = `${input.type.toLowerCase()}`;
        if (!explicit.has(box)) explicit.set(box, new Map());
        const byType = explicit.get(box);
        if (!byType.has(key)) byType.set(key, []);
        byType.get(key).push(input);
      } else {
        pending.push({ input, node: input.closest('label') || input.parentElement || input });
      }
    }
    for (const byType of explicit.values()) {
      for (const list of byType.values()) {
        if (list.length >= 2) groups.push(list);
        else pending.push({ input: list[0], node: list[0].closest('label') || list[0].parentElement || list[0] });
      }
    }
    for (let level = 1; level <= 3 && pending.length > 1; level++) {
      const byBox = new Map();
      for (const p of pending) {
        let box = p.node;
        for (let i = 0; i < level && box; i++) box = box.parentElement;
        if (!box || HARD_STOP_TAGS.has(box.tagName)) continue;
        const key = `${p.input.type.toLowerCase()}`;
        if (!byBox.has(box)) byBox.set(box, new Map());
        const byType = byBox.get(box);
        if (!byType.has(key)) byType.set(key, []);
        byType.get(key).push(p);
      }
      const grouped = new Set();
      for (const byType of byBox.values()) {
        for (const list of byType.values()) {
          if (list.length < 2) continue;
          groups.push(list.map((p) => p.input));
          list.forEach((p) => grouped.add(p));
        }
      }
      pending = pending.filter((p) => !grouped.has(p));
    }

    return groups.map((list) => {
      list.sort(docOrder);
      const set = new Set(list);
      const lca = commonAncestor(list);
      return {
        source: 'native',
        type: list[0].type.toLowerCase() === 'radio' ? 'single' : 'multiple',
        group: lca?.closest(`fieldset, ${GROUP_SELECTOR}`) || null,
        options: list.map((input) => nativeOption(input, set)),
      };
    });
  }

  /* ---------- strategy 2: ARIA widgets ---------- */

  function isComboboxPopup(listbox) {
    if (listbox.closest('[role="combobox"]')) return true;
    if (!listbox.id) return false;
    const id = CSS.escape(listbox.id);
    return Boolean(document.querySelector(`[aria-controls~="${id}"][role="combobox"], [aria-owns~="${id}"][role="combobox"], input[aria-controls~="${id}"]`));
  }

  function collectAria(root, claimed) {
    const groups = new Map();
    for (const el of root.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"]')) {
      if (el.matches('input, select, option') || isClaimed(el, claimed)) continue;
      if (el.querySelector('input[type="radio" i], input[type="checkbox" i]')) continue; // handled natively
      const role = el.getAttribute('role');
      if (role === 'option') {
        const lb = el.closest('[role="listbox"]');
        if (!lb || isComboboxPopup(lb)) continue;
      }
      const group = el.closest(GROUP_SELECTOR) || el.parentElement;
      if (!group) continue;
      const key = role === 'option' ? 'option' : role;
      if (!groups.has(group)) groups.set(group, new Map());
      const byRole = groups.get(group);
      if (!byRole.has(key)) byRole.set(key, []);
      byRole.get(key).push(el);
    }

    const out = [];
    for (const [group, byRole] of groups) {
      for (const [role, els] of byRole) {
        if (els.length < 2) continue;
        const multi = role === 'checkbox' || (role === 'option' && group.getAttribute('aria-multiselectable') === 'true');
        out.push({
          source: 'aria',
          type: multi ? 'multiple' : 'single',
          group,
          options: els.map((el) => ({ row: el, textEl: el, input: null })),
        });
      }
    }
    return out;
  }

  /* ---------- strategy 3: dropdowns ---------- */

  function isPlaceholderOption(o, index) {
    const t = (o.text || '').trim();
    if (!t) return true;
    if (o.value === '' && index === 0) return true;
    return index === 0 && (o.disabled || /^(-+|—+|select|choose|pick|please)\b/i.test(t) || /^-.*-$/.test(t));
  }

  function collectSelects(root, claimed) {
    const out = [];
    for (const select of root.querySelectorAll('select')) {
      if (isClaimed(select, claimed)) continue;
      const desc = [select.name, select.id, select.getAttribute('aria-label'), select.getAttribute('class')].join(' ');
      if (NAV_SELECT_RE.test(desc)) continue;
      const real = Array.from(select.options).filter((o, i) => !isPlaceholderOption(o, i));
      if (real.length < 2 || real.length > LIMITS.MAX_OPTIONS + 3) continue;
      out.push({
        source: 'select',
        type: select.multiple ? 'multiple' : 'single',
        group: select,
        select,
        options: real.map((o) => ({ row: select, optionEl: o, text: text.clean(o.label || o.text) })),
      });
    }
    return out;
  }

  /* ---------- strategy 4: class-named custom containers ---------- */

  const CUSTOM_OPTION_SELECTOR =
    '[class*="option" i], [class*="choice" i], [class*="answer" i], [class*="alternative" i], [data-option], [data-choice]';
  const CUSTOM_QUESTION_SELECTOR =
    '[class*="question" i], [class*="mcq" i], [class*="quiz" i], [data-question], [data-question-id], [data-testid*="question" i]';
  const OPTION_TOKEN_RE = /(option|choice|answer|alternative)/i;
  const OPTION_TOKEN_EXCLUDE_RE =
    /(feedback|explan|hint|menu|dropdown|count|header|title|input|field|box|area|list|group|container|section|key|submit|button|btn|icon|panel|toolbar|correct|incorrect|result|status|reveal|show|toggle)/i;

  function optionToken(el) {
    if (el.hasAttribute('data-option') || el.hasAttribute('data-choice')) return 'data';
    const classes = (el.getAttribute('class') || '').split(/\s+/);
    return classes.find((c) => OPTION_TOKEN_RE.test(c) && !OPTION_TOKEN_EXCLUDE_RE.test(c)) || null;
  }

  function collectCustom(root, claimed) {
    const qualifying = Array.from(root.querySelectorAll(CUSTOM_OPTION_SELECTOR)).filter(
      (el) =>
        optionToken(el) &&
        !isClaimed(el, claimed) &&
        !el.querySelector('input, select, textarea, [role="radio"], [role="checkbox"]') &&
        el.closest(CUSTOM_QUESTION_SELECTOR)
    );
    // Keep the innermost matches (".choice-wrapper > .choice-text" → the text).
    const hasQualifyingDescendant = new Set();
    const set = new Set(qualifying);
    for (const el of qualifying) {
      for (let a = el.parentElement; a; a = a.parentElement) {
        if (set.has(a)) hasQualifyingDescendant.add(a);
      }
    }
    const groups = new Map();
    for (const el of qualifying) {
      if (hasQualifyingDescendant.has(el)) continue;
      const len = (el.textContent || '').trim().length;
      if (len === 0 || len > 500) continue;
      const parent = el.parentElement;
      const key = `${el.tagName}\u0000${optionToken(el)}`;
      if (!groups.has(parent)) groups.set(parent, new Map());
      const byKey = groups.get(parent);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(el);
    }
    const out = [];
    for (const [parent, byKey] of groups) {
      for (const els of byKey.values()) {
        if (els.length < 2 || els.length > LIMITS.MAX_OPTIONS) continue;
        out.push({ source: 'custom', type: 'unknown', group: parent, options: els.map((el) => ({ row: el, textEl: el })) });
      }
    }
    return out;
  }

  /* ---------- strategy 5: lettered options ---------- */

  /** Splits a block into lines at <br> and block-level children. */
  function splitLines(block) {
    const lines = [];
    let current = [];
    const flush = () => {
      if (current.length) lines.push(current);
      current = [];
    };
    for (let node = block.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'BR') {
          flush();
          continue;
        }
        if (isBlockish(node)) {
          flush();
          lines.push([node]);
          continue;
        }
      }
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) current.push(node);
    }
    flush();
    return lines.map((nodes) => ({ nodes, text: nodes.map((n) => n.textContent).join('') }));
  }

  function sequentialRun(texts) {
    for (let start = 0; start < texts.length; start++) {
      const first = markerOf(texts[start]);
      if (!first || first.index !== 0) continue;
      let length = 1;
      while (start + length < texts.length && markerOf(texts[start + length])?.index === length) length++;
      if (length >= 2) return { start, length };
    }
    return null;
  }

  function rangeOverNodes(nodes) {
    const range = document.createRange();
    range.setStartBefore(nodes[0]);
    range.setEndAfter(nodes[nodes.length - 1]);
    return range;
  }

  function collectLettered(root, claimed) {
    const out = [];
    const used = new Set();

    // Lists: <ol type="A">, list-style alpha, or items that start with "A)".
    for (const list of root.querySelectorAll('ol, ul')) {
      if (isClaimed(list, claimed)) continue;
      const items = Array.from(list.children).filter((c) => c.tagName === 'LI');
      if (items.length < 2 || items.length > LIMITS.MAX_OPTIONS) continue;
      if (items.some((li) => li.querySelector('input, select, textarea, [role="radio"], [role="checkbox"], ol, ul') || li.textContent.length > 500)) {
        continue;
      }
      const alphaStyle = /alpha|latin/.test(getComputedStyle(list).listStyleType) || /^[aA]$/.test(list.getAttribute('type') || '');
      const sequential = items.every((li, i) => markerOf(li.textContent)?.index === i);
      if (!alphaStyle && !sequential) continue;
      items.forEach((li) => used.add(li));
      out.push({
        source: 'lettered-list',
        type: 'unknown',
        group: list,
        requireQuestion: true,
        options: items.map((li) => ({ row: li, textEl: li, stripMarker: sequential })),
      });
    }

    // Paragraph runs and <br>-separated lines, found via text nodes starting with "A)".
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (markerOf(n.nodeValue)?.index === 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const seenBlocks = new Set();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let block = node.parentElement;
      while (block && !isBlockish(block)) block = block.parentElement;
      if (!block || HARD_STOP_TAGS.has(block.tagName) || seenBlocks.has(block) || used.has(block) || isClaimed(block, claimed)) continue;
      seenBlocks.add(block);

      const lines = splitLines(block);
      const run = sequentialRun(lines.map((l) => l.text));
      if (run && lines.slice(run.start, run.start + run.length).every((l) => !(l.nodes.length === 1 && l.nodes[0].nodeType === 1 && isBlockish(l.nodes[0])))) {
        out.push({
          source: 'lettered-lines',
          type: 'unknown',
          group: block,
          requireQuestion: true,
          stemHint: text.clean(lines.slice(0, run.start).map((l) => l.text).join('\n')),
          options: lines.slice(run.start, run.start + run.length).map((l) => ({ row: null, range: rangeOverNodes(l.nodes), stripMarker: true })),
        });
        continue;
      }
      if (markerOf(block.textContent)?.index !== 0) continue;
      const rows = [block];
      for (let sib = block.nextElementSibling; sib && rows.length < LIMITS.MAX_OPTIONS; sib = sib.nextElementSibling) {
        if (markerOf(sib.textContent)?.index !== rows.length) break;
        rows.push(sib);
      }
      if (rows.length < 2) continue;
      rows.forEach((r) => seenBlocks.add(r));
      out.push({
        source: 'lettered-blocks',
        type: 'unknown',
        group: block.parentElement,
        requireQuestion: true,
        options: rows.map((r) => ({ row: r, textEl: r, stripMarker: true })),
      });
    }
    return out;
  }

  /* ---------- building a question from a candidate ---------- */

  function optionAnchor(opt) {
    return opt.row || asElement(opt.range.startContainer.childNodes?.[opt.range.startOffset] || opt.range.startContainer);
  }

  function optionRect(opt) {
    return opt.range ? opt.range.getBoundingClientRect() : opt.row.getBoundingClientRect();
  }

  function optionVisible(opt) {
    if (opt.range) {
      const rect = opt.range.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      return guards.isRendered(asElement(opt.range.commonAncestorContainer)) && text.extractRange(opt.range).length > 0;
    }
    return guards.isRendered(opt.row);
  }

  function optionText(opt) {
    let t;
    if (typeof opt.text === 'string') t = opt.text;
    else if (opt.range) t = text.extractRange(opt.range, { maxLength: LIMITS.OPTION_CHARS * 2 });
    else {
      t = text.extract(opt.textEl || opt.row, { maxLength: LIMITS.OPTION_CHARS * 2 });
      if (!t && opt.textEl && opt.textEl !== opt.row) t = text.extract(opt.row, { maxLength: LIMITS.OPTION_CHARS * 2 });
      if (!t && opt.input) t = (opt.input.getAttribute('aria-label') || opt.input.getAttribute('title') || '').trim();
    }
    if (opt.stripMarker) t = t.replace(MARKER_RE, '');
    return text.truncate(text.clean(t), LIMITS.OPTION_CHARS);
  }

  /** Does `el` contain option nodes that belong to a different candidate? */
  function containsOther(el, owner, ctx) {
    for (const { node, index } of ctx.boundaries) {
      if (index !== owner && el.contains(node)) return true;
    }
    return false;
  }

  /** Grows the container from the options' common ancestor up to the question boundary. */
  function climb(start, owner, ctx) {
    let node = start;
    for (let depth = 0; depth < 6; depth++) {
      if (node.matches(ctx.containerSelector)) break;
      const parent = node.parentElement;
      if (!parent || HARD_STOP_TAGS.has(parent.tagName) || parent.getAttribute('role') === 'main') break;
      if (containsOther(parent, owner, ctx)) break;
      if ((parent.textContent || '').length > 6000) break;
      node = parent;
    }
    return node;
  }

  /** legend / aria-labelledby / aria-label / <label for=select>. */
  function explicitStem(cand, lca, owner, ctx) {
    const els = [];
    let label = '';
    const groups = [cand.group, lca.closest(GROUP_SELECTOR)].filter(
      (g, i, arr) => g && arr.indexOf(g) === i && g.nodeType === 1 && !containsOther(g, owner, ctx)
    );
    for (const g of groups) {
      for (const id of (g.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
        const el = document.getElementById(id);
        if (el && !els.includes(el)) els.push(el);
      }
      if (els.length) break;
      const aria = (g.getAttribute('aria-label') || '').trim();
      if (aria && !GENERIC_LABEL_RE.test(aria)) {
        label = aria;
        break;
      }
    }
    if (!els.length && !label) {
      const fieldset = lca.closest('fieldset');
      const legend = fieldset && !containsOther(fieldset, owner, ctx) ? fieldset.querySelector(':scope > legend') : null;
      if (legend) els.push(legend);
    }
    if (!els.length && !label && cand.select) {
      els.push(...Array.from(cand.select.labels || []));
    }
    const fromEls = els.map((el) => text.extract(el, { maxLength: LIMITS.STEM_CHARS })).filter(Boolean).join('\n');
    return { text: fromEls || label, els };
  }

  /** Text immediately before the container (flat layouts: <p>stem</p><ul>options</ul>). */
  function previousText(container, owner, ctx) {
    const parts = [];
    let node = container;
    outer: for (let level = 0; level < 3 && node; level++) {
      let taken = 0;
      for (let sib = node.previousElementSibling; sib && taken < 3; sib = sib.previousElementSibling) {
        if (containsOther(sib, owner, ctx)) break outer;
        const t = text.extract(sib, { maxLength: 800 });
        if (!t) continue;
        parts.unshift(t);
        taken++;
        if (/[?:]\s*$/.test(t) || /^H[1-6]$/.test(sib.tagName) || parts.join(' ').length > 600) break outer;
      }
      if (parts.length) break;
      node = node.parentElement;
      if (!node || HARD_STOP_TAGS.has(node.tagName) || containsOther(node, owner, ctx)) break;
    }
    return parts.join('\n');
  }

  function meaningfulLength(s) {
    return (s.match(/[\p{L}\p{N}]/gu) || []).length;
  }

  function buildQuestion(cand, owner, ctx) {
    // 1. Drop honeypot inputs and options a person can't see.
    let honeypots = 0;
    let hidden = 0;
    const visible = [];
    for (const opt of cand.options) {
      if (opt.input && guards.looksLikeHoneypotInput(opt.input)) honeypots++;
      else if (!optionVisible(opt)) hidden++;
      else visible.push(opt);
    }
    if (visible.length < 2) {
      if (honeypots || hidden) ctx.skipped[honeypots ? 'honeypot' : 'hidden']++;
      return null;
    }

    const lca = commonAncestor(visible.map((o) => o.row || o.range.commonAncestorContainer));
    if (!lca || guards.isExcludedRegion(lca)) return null;
    if (guards.isCaptchaRelated(lca)) {
      ctx.skipped.captcha++;
      return null;
    }
    // A CAPTCHA elsewhere in the same form (e.g. beside the submit button) is
    // fine; only options inside or wrapping a widget are skipped (above).
    const container = climb(lca, owner, ctx);

    // 2. Stem and context.
    const explicit = explicitStem(cand, lca, owner, ctx);
    let stem = explicit.text;
    let context = '';
    if (typeof cand.stemHint === 'string') {
      stem = [cand.stemHint, stem].filter(Boolean).join('\n');
    } else {
      const exclude = new Set([...cand.options.map((o) => o.row).filter(Boolean), ...explicit.els]);
      context = text.extract(container, { exclude, maxLength: LIMITS.CONTEXT_CHARS * 2 });
    }
    if (!stem) {
      stem = context;
      context = '';
    }
    if (meaningfulLength(stem) < 12 || (cand.requireQuestion && !QUESTION_LIKE_RE.test(stem))) {
      const prev = previousText(container, owner, ctx);
      if (prev) stem = [prev, stem].filter(Boolean).join('\n');
    }
    stem = text.truncate(text.clean(stem), LIMITS.STEM_CHARS);
    if (context && (stem.includes(context) || context === stem)) context = '';
    if (meaningfulLength(stem) < 3) return null;
    if (cand.requireQuestion && !QUESTION_LIKE_RE.test(stem)) return null;

    // 3. Option texts.
    const kept = visible.slice(0, LIMITS.MAX_OPTIONS);
    const optionTexts = kept.map(optionText);
    if (optionTexts.filter((t) => meaningfulLength(t) > 0).length < 2) return null;

    // 4. Verification / honeypot prompts.
    const reason = guards.classifyText(stem, optionTexts);
    if (reason) {
      ctx.skipped[reason]++;
      return null;
    }

    // 5. Scope.
    if (ctx.scope === 'viewport' && !kept.some((o) => guards.intersectsViewport(optionRect(o)))) {
      ctx.skipped.outsideViewport++;
      return null;
    }

    return {
      anchor: optionAnchor(kept[0]) || container,
      container,
      type: cand.type,
      source: cand.source,
      stem,
      context: text.truncate(context, LIMITS.CONTEXT_CHARS),
      options: kept,
      optionTexts: optionTexts.map((t) => t || '[no visible text]'),
    };
  }

  /* ---------- strategy 6: short free-text answers ---------- */

  // Fields that collect personal/account data or navigation, never quiz answers.
  const NON_ANSWER_FIELD_RE =
    /(^|[-_\s])(name|first|last|full[-_]?name|e-?mail|phone|tel|user(name)?|login|pass(word)?|search|query|q|address|street|city|zip|postal|country|coupon|promo|card|cvv|captcha|otp|code[-_]?verify|url|website|comment[-_]?author|subject)([-_\s]|$)/i;
  const NON_ANSWER_AUTOCOMPLETE_RE = /^(name|given-name|family-name|email|tel|username|current-password|new-password|street-address|address-line\d|postal-code|country|cc-|one-time-code|organization|url)/i;

  function isAnswerField(field) {
    if (field.disabled || field.readOnly) return false;
    if (field.tagName === 'INPUT') {
      const type = (field.getAttribute('type') || 'text').toLowerCase();
      if (!['text', 'number', ''].includes(type)) return false;
    }
    const desc = [field.name, field.id, field.getAttribute('aria-label'), field.getAttribute('placeholder')].filter(Boolean).join(' ');
    if (NON_ANSWER_FIELD_RE.test(desc)) return false;
    if (NON_ANSWER_AUTOCOMPLETE_RE.test(field.getAttribute('autocomplete') || '')) return false;
    if (field.closest('[role="combobox"], [role="search"]') || field.getAttribute('role') === 'combobox') return false;
    return true;
  }

  function collectTextFields(root, claimed) {
    const out = [];
    for (const field of root.querySelectorAll('input:not([type]), input[type="text" i], input[type="number" i], textarea')) {
      if (isClaimed(field, claimed) || !isAnswerField(field)) continue;
      const max = Number(field.getAttribute('maxlength'));
      out.push({
        source: 'text',
        type: 'text',
        field,
        group: null,
        options: [{ row: field, input: field }],
        constraints: {
          numeric: field.getAttribute('type') === 'number' || field.getAttribute('inputmode') === 'numeric' || field.getAttribute('inputmode') === 'decimal',
          maxLength: Number.isFinite(max) && max > 0 ? max : null,
          multiline: field.tagName === 'TEXTAREA',
          placeholder: (field.getAttribute('placeholder') || '').slice(0, 120) || null,
        },
      });
    }
    return out;
  }

  /** A short-answer field: its label (or nearby text) is the question. */
  function buildTextQuestion(cand, owner, ctx) {
    const field = cand.field;
    if (guards.looksLikeHoneypotInput(field)) {
      ctx.skipped.honeypot++;
      return null;
    }
    if (!guards.isRendered(field)) {
      ctx.skipped.hidden++;
      return null;
    }
    if (guards.isExcludedRegion(field)) return null;
    if (guards.isCaptchaRelated(field)) {
      ctx.skipped.captcha++;
      return null;
    }

    const labels = labelElementsFor(field).filter((l) => !l.contains(field) || l.textContent.trim());
    let stem = labels.map((l) => text.extract(l, { maxLength: LIMITS.STEM_CHARS })).filter(Boolean).join('\n');
    if (!stem) stem = (field.getAttribute('aria-label') || '').trim();
    const container = climb(field, owner, ctx);
    const inQuestionContainer = Boolean(field.closest(ctx.containerSelector));
    let context = container === field ? '' : text.extract(container, { exclude: new Set(labels), maxLength: LIMITS.CONTEXT_CHARS * 2 });
    if (!stem) {
      stem = context;
      context = '';
    }
    if (meaningfulLength(stem) < 12 || !QUESTION_LIKE_RE.test(stem)) {
      const prev = previousText(container, owner, ctx);
      if (prev) stem = [prev, stem].filter(Boolean).join('\n');
    }
    stem = text.truncate(text.clean(stem), LIMITS.STEM_CHARS);
    if (context && stem.includes(context)) context = '';
    // Text boxes are everywhere (comments, feedback…): only keep ones that read as questions.
    if (meaningfulLength(stem) < 8 || !(QUESTION_LIKE_RE.test(stem) || inQuestionContainer)) return null;

    const reason = guards.classifyText(stem, []);
    if (reason) {
      ctx.skipped[reason]++;
      return null;
    }
    if (ctx.scope === 'viewport' && !guards.intersectsViewport(field.getBoundingClientRect())) {
      ctx.skipped.outsideViewport++;
      return null;
    }
    return {
      anchor: field,
      container,
      type: 'text',
      source: 'text',
      stem,
      context: text.truncate(context, LIMITS.CONTEXT_CHARS),
      options: cand.options,
      optionTexts: [],
      field,
      constraints: cand.constraints,
    };
  }

  function containerSelectorFor(host) {
    const platform = PLATFORM_CONTAINERS.find((p) => p.host.test(host));
    return platform ? `${platform.selector}, ${GENERIC_CONTAINERS}` : GENERIC_CONTAINERS;
  }

  /**
   * Finds the visible MCQs and short-answer questions in this document.
   * @param {{scope?: 'page'|'viewport', includeText?: boolean}} [opts]
   * @returns {{blocked: string|null, skipped: Record<string, number>, questions: object[], entries: object[]}}
   */
  function findQuestions(opts = {}) {
    guards.resetCaches();
    const skipped = { hidden: 0, honeypot: 0, captcha: 0, verification: 0, outsideViewport: 0 };
    const blocked = guards.detectBlockingChallenge(document);
    if (blocked) return { blocked, skipped, questions: [], entries: [] };

    const root = document.body || document.documentElement;
    const claimed = new Set();
    const candidates = [];
    const add = (list) => {
      for (const c of list) {
        candidates.push(c);
        for (const o of c.options) {
          if (o.row) claimed.add(o.row);
          if (o.input) claimed.add(o.input);
        }
        if (c.source !== 'native' && c.group) claimed.add(c.group);
      }
    };
    add(collectNative(root));
    add(collectAria(root, claimed));
    add(collectSelects(root, claimed));
    add(collectCustom(root, claimed));
    add(collectLettered(root, claimed));
    if (opts.includeText !== false) add(collectTextFields(root, claimed));

    const ctx = {
      scope: opts.scope === 'viewport' ? 'viewport' : 'page',
      skipped,
      containerSelector: containerSelectorFor(location.hostname),
      boundaries: candidates.flatMap((c, index) =>
        c.options.map((o) => ({ node: o.row || asElement(o.range.commonAncestorContainer), index })).filter((b) => b.node)
      ),
    };

    const built = [];
    candidates.forEach((cand, index) => {
      try {
        const q = cand.source === 'text' ? buildTextQuestion(cand, index, ctx) : buildQuestion(cand, index, ctx);
        if (q) built.push(q);
      } catch (err) {
        console.debug('[Quizzers] skipped a candidate:', err);
      }
    });

    built.sort((a, b) => docOrder(a.anchor, b.anchor));
    const seenRows = new Set();
    const unique = built.filter((q) => {
      const rows = q.options.map((o) => o.row || o.range);
      if (rows.some((r) => seenRows.has(r) && !(r instanceof HTMLSelectElement))) return false;
      rows.forEach((r) => seenRows.add(r));
      return true;
    });

    return {
      blocked: null,
      skipped,
      questions: unique.map((q, localId) => ({
        localId,
        type: q.type,
        source: q.source,
        stem: q.stem,
        context: q.context,
        options: q.optionTexts,
        constraints: q.constraints || undefined,
      })),
      entries: unique.map((q) => ({ container: q.container, anchor: q.anchor, type: q.type, options: q.options, field: q.field || null })),
    };
  }

  QZ.parser = Object.freeze({ findQuestions });
})();
