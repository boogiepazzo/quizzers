/*
 * Floating trigger button + results panel.
 *
 * Rendered inside a closed shadow root so page CSS can't restyle it and page
 * scripts can't read it. All dynamic content (page text, model output) is
 * inserted with textContent — never innerHTML.
 */
(() => {
  const QZ = (globalThis.QZ = globalThis.QZ || {});
  if (QZ.ui) return;

  const DEFAULT_BOTTOM = 24;
  const SETTINGS_CODES = new Set(['NO_API_KEY', 'INVALID_API_KEY', 'MODEL_NOT_FOUND', 'INSUFFICIENT_CREDITS']);
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root {
      --qz-green: #2f855a; --qz-green-2: #38a169; --qz-mint: #e6fffa;
      --qz-bg: #ffffff; --qz-fg: #1a202c; --qz-muted: #4a5568; --qz-line: #e2e8f0; --qz-soft: #f7fafc;
      --qz-warn-bg: #fffaf0; --qz-warn-fg: #9c4221; --qz-err-bg: #fff5f5; --qz-err-fg: #c53030;
      --qz-bottom: ${DEFAULT_BOTTOM}px;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: var(--qz-fg);
    }
    @media (prefers-color-scheme: dark) {
      .root {
        --qz-bg: #1a202c; --qz-fg: #f7fafc; --qz-muted: #a0aec0; --qz-line: #2d3748; --qz-soft: #232b3a;
        --qz-mint: #123c33; --qz-warn-bg: #3b2a12; --qz-warn-fg: #fbd38d; --qz-err-bg: #3b1a1a; --qz-err-fg: #feb2b2;
      }
    }
    @media print { .root { display: none !important; } }

    .fab {
      position: fixed; right: 16px; bottom: var(--qz-bottom); z-index: 2147483646;
      width: 44px; height: 44px; border-radius: 50%; border: 0; padding: 0;
      display: grid; place-items: center; cursor: pointer; touch-action: none;
      background: var(--qz-green); color: #fff;
      box-shadow: 0 2px 10px rgba(0,0,0,.22);
      opacity: .62; transition: opacity .15s ease, transform .15s ease, box-shadow .15s ease;
    }
    .fab:hover, .fab:focus-visible, .fab[data-busy="true"], .fab[aria-expanded="true"] { opacity: 1; }
    .fab:hover { transform: scale(1.06); }
    .fab:focus-visible { outline: 3px solid #9ae6b4; outline-offset: 2px; }
    .fab[hidden] { display: none; }
    .fab svg { width: 22px; height: 22px; }
    .fab[data-busy="true"] svg { opacity: .35; }
    .spinner {
      position: absolute; inset: 5px; border-radius: 50%;
      border: 3px solid rgba(255,255,255,.35); border-top-color: #fff;
      animation: qz-spin .8s linear infinite; display: none;
    }
    .fab[data-busy="true"] .spinner { display: block; }
    .badge {
      position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px;
      border-radius: 9px; background: #fff; color: var(--qz-green); font-weight: 700; font-size: 11px;
      line-height: 18px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.25);
    }
    .badge[data-kind="error"] { color: #c53030; }
    .badge[hidden] { display: none; }

    .panel {
      position: fixed; right: 16px; bottom: calc(var(--qz-bottom) + 54px); z-index: 2147483646;
      width: min(360px, calc(100vw - 32px));
      max-height: min(70vh, calc(100vh - var(--qz-bottom) - 80px));
      display: flex; flex-direction: column; overflow: hidden;
      background: var(--qz-bg); border: 1px solid var(--qz-line); border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0,0,0,.18);
    }
    .panel[hidden] { display: none; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--qz-line); }
    .title { flex: 1; min-width: 0; }
    .title strong { display: block; font-size: 14px; }
    .model { display: block; color: var(--qz-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .icon-btn {
      border: 0; background: transparent; color: var(--qz-muted); cursor: pointer;
      width: 28px; height: 28px; border-radius: 6px; font-size: 18px; line-height: 1;
    }
    .icon-btn:hover { background: var(--qz-soft); color: var(--qz-fg); }
    .icon-btn:focus-visible, .btn:focus-visible, .q:focus-visible { outline: 2px solid var(--qz-green-2); outline-offset: 1px; }

    .status { padding: 10px 14px; color: var(--qz-muted); }
    .status:empty { display: none; }
    .status[data-kind="error"] { background: var(--qz-err-bg); color: var(--qz-err-fg); }
    .status[data-kind="warn"] { background: var(--qz-warn-bg); color: var(--qz-warn-fg); }
    .status .row { display: flex; gap: 8px; align-items: flex-start; }
    .status .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex: none; background: var(--qz-green-2); animation: qz-pulse 1s ease-in-out infinite alternate; }
    .status .note { margin-top: 4px; font-size: 12px; }
    .status .action { margin-top: 8px; }

    .list { list-style: none; margin: 0; padding: 4px 0; overflow-y: auto; flex: 1; }
    .list:empty { display: none; }
    .item { padding: 8px 14px; border-top: 1px solid var(--qz-line); }
    .item:first-child { border-top: 0; }
    .q {
      all: unset; box-sizing: border-box; display: flex; gap: 6px; width: 100%; cursor: pointer;
      border-radius: 4px; color: var(--qz-fg);
    }
    .q:hover .stem { text-decoration: underline; }
    .num { flex: none; font-weight: 700; color: var(--qz-muted); }
    .stem { flex: 1; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .answer {
      display: flex; gap: 6px; align-items: baseline; margin-top: 6px; padding: 5px 8px;
      background: var(--qz-mint); border: 1px solid var(--qz-green-2); border-radius: 6px;
    }
    .answer[data-level="low"] { border-style: dashed; }
    .letter { flex: none; font-weight: 700; color: var(--qz-green); }
    .answer-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .conf { flex: none; font-size: 11px; color: var(--qz-muted); }
    .reason { margin: 5px 0 0; color: var(--qz-muted); font-size: 12px; overflow-wrap: anywhere; }
    .warn { margin-top: 6px; padding: 5px 8px; border-radius: 6px; background: var(--qz-warn-bg); color: var(--qz-warn-fg); font-size: 12px; }

    .foot { display: flex; gap: 6px; align-items: center; padding: 8px 10px; border-top: 1px solid var(--qz-line); }
    .foot .spacer { flex: 1; }
    .btn {
      border: 1px solid var(--qz-line); background: var(--qz-bg); color: var(--qz-fg);
      border-radius: 6px; padding: 5px 10px; font: inherit; cursor: pointer;
    }
    .btn:hover { background: var(--qz-soft); }
    .btn[disabled] { opacity: .5; cursor: default; }
    .btn.primary { background: var(--qz-green); border-color: var(--qz-green); color: #fff; }
    .btn.primary:hover { background: #276749; }
    .disclaimer { padding: 0 14px 8px; color: var(--qz-muted); font-size: 11px; }

    @keyframes qz-spin { to { transform: rotate(360deg); } }
    @keyframes qz-pulse { from { opacity: .35; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      .fab, .spinner, .status .dot { transition: none; animation: none; }
    }
  `;

  const TEMPLATE = `
    <div class="root">
      <section class="panel" role="dialog" aria-label="Quizzers answer suggestions" hidden>
        <header class="head">
          <div class="title"><strong>Quizzers</strong><span class="model"></span></div>
          <button class="icon-btn settings" type="button" aria-label="Open Quizzers settings" title="Settings">⚙</button>
          <button class="icon-btn close" type="button" aria-label="Close panel" title="Close (Esc)">×</button>
        </header>
        <div class="status" role="status" aria-live="polite"></div>
        <ol class="list"></ol>
        <p class="disclaimer">AI suggestions can be wrong. Quizzers only highlights — you pick the answer.</p>
        <footer class="foot">
          <button class="btn primary rescan" type="button">Scan again</button>
          <button class="btn clear" type="button">Clear highlights</button>
          <span class="spacer"></span>
        </footer>
      </section>
      <button class="fab" type="button" aria-expanded="false" aria-label="Quizzers: highlight answers to multiple-choice questions">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="M7.5 11.2l2.4 2.4 4.6-4.8"></path>
          <path d="M17 17l4 4"></path>
        </svg>
        <span class="spinner" aria-hidden="true"></span>
        <span class="badge" hidden></span>
      </button>
    </div>
  `;

  let host = null;
  let els = null;
  let handlers = {};
  let state = { phase: 'idle' };
  let fabEnabled = true;
  let bottom = DEFAULT_BOTTOM;
  let suppressClick = false;
  let dismissed = false; // user closed the panel during the current scan

  const isBusy = () => state.phase === 'scanning' || state.phase === 'solving';
  const hasResults = () => state.phase === 'done' || state.phase === 'error';

  function h(tag, className, textContent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined) node.textContent = textContent;
    return node;
  }

  function clampBottom(value) {
    const max = Math.max(8, window.innerHeight - 60);
    return Math.min(max, Math.max(8, Math.round(value)));
  }

  function applyBottom(value) {
    bottom = clampBottom(value);
    els.root.style.setProperty('--qz-bottom', `${bottom}px`);
  }

  function setPanelOpen(open) {
    els.panel.hidden = !open;
    els.fab.setAttribute('aria-expanded', String(open));
    updateFabVisibility();
  }

  function updateFabVisibility() {
    // With the floating button disabled, the UI still appears for scans
    // started from the popup or keyboard shortcut.
    els.fab.hidden = !fabEnabled && els.panel.hidden && !isBusy();
  }

  function onFabClick() {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    dismissed = false;
    if (isBusy()) setPanelOpen(els.panel.hidden);
    else if (els.panel.hidden && hasResults()) setPanelOpen(true);
    else handlers.onScan?.();
  }

  function wireDrag(fab) {
    let drag = null;
    fab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { y: e.clientY, start: bottom, moved: false, id: e.pointerId };
    });
    fab.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dy) > 5) {
        drag.moved = true;
        fab.setPointerCapture(e.pointerId);
      }
      if (drag.moved) applyBottom(drag.start - dy);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) {
        suppressClick = true;
        handlers.onMove?.(bottom);
      }
      drag = null;
    };
    fab.addEventListener('pointerup', end);
    fab.addEventListener('pointercancel', end);
  }

  function mount(nextHandlers = {}) {
    if (host) return;
    handlers = nextHandlers;
    host = document.createElement('quizzers-ui');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.append(style);
    shadow.append(document.createRange().createContextualFragment(TEMPLATE));

    els = {
      root: shadow.querySelector('.root'),
      panel: shadow.querySelector('.panel'),
      model: shadow.querySelector('.model'),
      status: shadow.querySelector('.status'),
      list: shadow.querySelector('.list'),
      rescan: shadow.querySelector('.rescan'),
      clear: shadow.querySelector('.clear'),
      close: shadow.querySelector('.close'),
      settings: shadow.querySelector('.settings'),
      fab: shadow.querySelector('.fab'),
      badge: shadow.querySelector('.badge'),
    };

    els.fab.addEventListener('click', onFabClick);
    wireDrag(els.fab);
    els.close.addEventListener('click', () => {
      dismissed = true;
      setPanelOpen(false);
    });
    els.rescan.addEventListener('click', () => handlers.onScan?.());
    els.clear.addEventListener('click', () => {
      handlers.onClear?.();
      reset();
    });
    els.settings.addEventListener('click', () => handlers.onOpenSettings?.());
    els.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        dismissed = true;
        setPanelOpen(false);
        els.fab.focus();
      }
    });
    window.addEventListener('resize', () => applyBottom(bottom), { passive: true });

    // Attached to <html> rather than <body> so frameworks that replace the
    // body (Turbo, some SPA routers) don't remove it.
    document.documentElement.append(host);
    render(state);
  }

  /** Re-attaches the host if a page script removed it (e.g. a SPA re-render of <html>). */
  function ensureAttached() {
    if (host && !host.isConnected) document.documentElement.append(host);
  }

  function configure({ showFloatingButton, buttonOffset } = {}) {
    if (!els) return;
    if (typeof showFloatingButton === 'boolean') fabEnabled = showFloatingButton;
    if (Number.isFinite(buttonOffset)) applyBottom(buttonOffset);
    updateFabVisibility();
  }

  function summaryNote(skipped) {
    if (!skipped) return '';
    const parts = [];
    const hidden = (skipped.hidden || 0) + (skipped.honeypot || 0);
    const verification = (skipped.captcha || 0) + (skipped.verification || 0);
    if (hidden) parts.push(`${hidden} hidden / honeypot`);
    if (verification) parts.push(`${verification} CAPTCHA / verification`);
    if (skipped.outsideViewport) parts.push(`${skipped.outsideViewport} outside the viewport`);
    return parts.length ? `Ignored ${parts.join(', ')} item${hidden + verification + (skipped.outsideViewport || 0) === 1 ? '' : 's'}.` : '';
  }

  function renderStatus(s) {
    const box = els.status;
    box.replaceChildren();
    box.removeAttribute('data-kind');

    const line = (msg, withDot) => {
      const row = h('div', 'row');
      if (withDot) row.append(h('span', 'dot'));
      row.append(h('span', '', msg));
      box.append(row);
    };

    if (s.phase === 'idle') {
      line('Click “Scan again” to look for multiple-choice questions on this page.');
    } else if (s.phase === 'scanning') {
      line('Scanning the page for visible questions…', true);
    } else if (s.phase === 'solving') {
      const batch = s.batches > 1 ? ` (batch ${s.batch} of ${s.batches})` : '';
      line(`Found ${s.total} question${s.total === 1 ? '' : 's'}. Asking ${s.model}${batch}…`, true);
    } else if (s.phase === 'done') {
      const total = s.results?.length || 0;
      const highlighted = (s.results || []).filter((r) => r.status === 'highlighted').length;
      line(total ? `Highlighted ${highlighted} of ${total} question${total === 1 ? '' : 's'}.` : s.message || 'No visible multiple-choice questions found.');
      if (s.warning) {
        box.dataset.kind = 'warn';
        box.append(h('div', 'note', s.warning));
      }
    } else if (s.phase === 'error') {
      box.dataset.kind = 'error';
      line(s.error?.message || 'Something went wrong.');
      if (SETTINGS_CODES.has(s.error?.code)) {
        const btn = h('button', 'btn action', 'Open settings');
        btn.type = 'button';
        btn.addEventListener('click', () => handlers.onOpenSettings?.());
        box.append(btn);
      }
    }
    const note = summaryNote(s.skipped);
    if (note && (s.phase === 'done' || s.phase === 'solving')) box.append(h('div', 'note', note));
  }

  function renderResult(r) {
    const li = h('li', 'item');
    const q = h('button', 'q');
    q.type = 'button';
    q.title = 'Scroll to this question';
    // Stems often carry their own numbering ("3. Which…"); the panel adds its own.
    const stem = r.stem.replace(/^\s*(?:q(?:uestion)?\s*)?\d+\s*[.):]\s*/i, '') || r.stem;
    q.append(h('span', 'num', `Q${r.num}`), h('span', 'stem', stem));
    q.addEventListener('click', () => handlers.onFocus?.(r));
    li.append(q);

    if (r.status === 'highlighted' || (r.indices && r.indices.length && r.status !== 'unmatched')) {
      const low = typeof r.confidence === 'number' && r.confidence < 0.5;
      for (const idx of r.indices || []) {
        const row = h('div', 'answer');
        row.dataset.level = low ? 'low' : 'high';
        row.append(h('span', 'letter', `${LETTERS[idx] || idx + 1}.`), h('span', 'answer-text', r.options?.[idx] ?? ''));
        if (typeof r.confidence === 'number') row.append(h('span', 'conf', `${Math.round(r.confidence * 100)}%`));
        li.append(row);
      }
      if (r.status === 'stale') li.append(h('div', 'warn', 'The question changed on the page — scan again to highlight it.'));
    } else if (r.status === 'pending') {
      li.append(h('div', 'reason', 'Waiting for the model…'));
    } else if (r.status === 'unmatched') {
      const said = r.rawTexts?.length ? ` (“${r.rawTexts.join('”, “').slice(0, 160)}”)` : '';
      li.append(h('div', 'warn', `The model’s answer${said} didn’t match any option.`));
    } else if (r.status === 'missing') {
      li.append(h('div', 'warn', 'The model didn’t return an answer for this question.'));
    } else if (r.status === 'error') {
      li.append(h('div', 'warn', r.error || 'This batch failed.'));
    }
    if (r.reasoning) li.append(h('p', 'reason', r.reasoning));
    return li;
  }

  function renderBadge(s) {
    const badge = els.badge;
    if (s.phase === 'done' && s.results?.length) {
      badge.hidden = false;
      badge.dataset.kind = 'ok';
      badge.textContent = String(s.results.filter((r) => r.status === 'highlighted').length);
    } else if (s.phase === 'error') {
      badge.hidden = false;
      badge.dataset.kind = 'error';
      badge.textContent = '!';
    } else {
      badge.hidden = true;
    }
  }

  /** Renders a scan state pushed by the service worker. */
  function render(next, { open } = {}) {
    state = next || { phase: 'idle' };
    if (!els) return;
    ensureAttached();
    const busy = isBusy();
    els.fab.dataset.busy = String(busy);
    els.fab.title = busy ? 'Quizzers is working… (click to toggle the panel)' : 'Quizzers: highlight answers (click to scan)';
    els.model.textContent = state.model ? `Model: ${state.model}` : '';
    els.rescan.disabled = busy;
    els.clear.disabled = busy;
    renderStatus(state);
    els.list.replaceChildren(...(state.results || []).map(renderResult));
    renderBadge(state);
    if (state.phase === 'scanning') dismissed = false;
    const shouldOpen = open ?? (state.phase !== 'idle' && !dismissed);
    if (shouldOpen) setPanelOpen(true);
    else if (open === false) setPanelOpen(false);
    updateFabVisibility();
  }

  function reset() {
    render({ phase: 'idle' }, { open: false });
  }

  QZ.ui = Object.freeze({ mount, configure, render, reset, isMounted: () => Boolean(host) });
})();
