/*
 * Service worker: the only context that holds the API key and talks to
 * OpenRouter. It also coordinates scans across frames:
 *
 *   collect (every frame)  →  one batched API call  →  highlight (per frame)
 *
 * Content scripts never see the API key; they only receive answers.
 */
importScripts('lib/config.js', 'lib/errors.js', 'lib/settings.js', 'lib/prompt.js', 'lib/openrouter.js');

const { MSG, LIMITS } = QZ.config;
const { QZError, toPlain } = QZ.errors;
const client = QZ.openrouter.createClient();

/** tabId -> { promise, controller } for scans in progress */
const inflight = new Map();

/* ---------- per-frame functions (serialized into the page) ---------- */
// These run in the content scripts' isolated world, so they can reach QZ.app.

async function frameCollect(opts) {
  const app = globalThis.QZ && globalThis.QZ.app;
  if (!app) return null;
  try {
    return await app.collect(opts);
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

function frameHighlight(token, items) {
  const app = globalThis.QZ && globalThis.QZ.app;
  return app ? app.highlight(token, items) : null;
}

function frameFocus(token, localId) {
  const app = globalThis.QZ && globalThis.QZ.app;
  return app ? app.focus(token, localId) : false;
}

function frameClear() {
  const app = globalThis.QZ && globalThis.QZ.app;
  return app ? app.clear() : false;
}

function frameHasApp() {
  return Boolean(globalThis.QZ && globalThis.QZ.app);
}

/* ---------- helpers ---------- */

function pushState(tabId, state) {
  chrome.tabs.sendMessage(tabId, { type: MSG.STATE, state }, { frameId: 0 }).catch(() => {
    /* top frame has no content script (e.g. restricted page) */
  });
}

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function addSkipped(total, skipped) {
  for (const [key, n] of Object.entries(skipped || {})) total[key] = (total[key] || 0) + (Number(n) || 0);
  return total;
}

async function execute(target, func, args = []) {
  try {
    return await chrome.scripting.executeScript({ target, func, args });
  } catch (err) {
    throw new QZError('NO_ACCESS', undefined, { detail: String(err?.message || err) });
  }
}

/** On sites outside the manifest's matches, inject on demand (activeTab). */
async function ensureContentScripts(tabId) {
  const [probe] = await execute({ tabId }, frameHasApp);
  if (probe?.result) return;
  const { content_scripts: scripts = [] } = chrome.runtime.getManifest();
  const files = scripts[0]?.js || [];
  const css = scripts[0]?.css || [];
  try {
    if (css.length) await chrome.scripting.insertCSS({ target: { tabId }, files: css });
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch (err) {
    throw new QZError('NO_ACCESS', undefined, { detail: String(err?.message || err) });
  }
}

async function collectFrames(tabId, scope) {
  const injections = await execute({ tabId, allFrames: true }, frameCollect, [{ scope }]);
  const frames = [];
  const failures = [];
  for (const r of injections) {
    if (!r || !r.result) continue; // frame without our content script
    if (r.result.error) failures.push({ frameId: r.frameId, error: r.result.error });
    else frames.push({ frameId: r.frameId, documentId: r.documentId, ...r.result });
  }
  if (failures.length) console.warn('[Quizzers] parser failed in some frames:', failures);
  frames.sort((a, b) => a.frameId - b.frameId);
  return { frames, failures };
}

/* ---------- answer cache (chrome.storage.session) ---------- */
// Keyed by a hash of model + question + options, so a rescan (e.g. after more
// of the page loaded) only sends questions that haven't been answered yet.

const CACHE_KEY = 'answerCache';

async function fingerprint(model, q) {
  const raw = JSON.stringify([model, q.type, q.stem, q.context || '', q.options, q.constraints || null]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadCache() {
  try {
    return (await chrome.storage.session.get(CACHE_KEY))[CACHE_KEY] || {};
  } catch {
    return {};
  }
}

async function saveToCache(batch, answers, fingerprints) {
  const cache = await loadCache();
  const now = Date.now();
  for (const q of batch) {
    const a = answers.get(q.id);
    const usable = a && (q.type === 'text' ? a.text : a.indices.length);
    if (usable) cache[fingerprints.get(q.id)] = { a, t: now };
  }
  const entries = Object.entries(cache).sort((x, y) => y[1].t - x[1].t).slice(0, LIMITS.CACHE_ENTRIES);
  await chrome.storage.session.set({ [CACHE_KEY]: Object.fromEntries(entries) }).catch(() => {});
}

/* ---------- completeness ---------- */

/**
 * Compares what was found with what the page implies: "Question N of M"
 * counters, gaps in question numbering, frames that couldn't be read, and a
 * page that was still changing when the scan ran.
 */
function completenessReport(frames, questions, scope) {
  const numbers = new Set(frames.flatMap((f) => f.completeness?.numbers || []));
  const declared = Math.max(0, ...frames.map((f) => f.completeness?.declaredTotal || 0)) || null;
  const numbered = numbers.size >= 3; // numbering only counts as evidence when most questions carry it
  const expected = Math.max(declared || 0, numbered ? Math.max(...numbers) : 0) || null;
  let missingNumbers = [];
  if (expected && numbered) {
    for (let n = 1; n <= expected && missingNumbers.length < 50; n++) if (!numbers.has(n)) missingNumbers.push(n);
  }
  const missingCount = numbered ? missingNumbers.length : declared ? Math.max(0, declared - questions.length) : 0;
  const childFrames = frames.reduce((sum, f) => sum + (f.completeness?.childFrames || 0), 0);
  const inaccessibleFrames = Math.max(0, childFrames - (frames.length - 1));
  const unstable = frames.some((f) => f.completeness && !f.completeness.stable);

  const notes = [];
  if (scope !== 'viewport' && missingCount) {
    const which = missingNumbers.length ? ` (${missingNumbers.slice(0, 10).join(', ')}${missingNumbers.length > 10 ? '…' : ''})` : '';
    notes.push(`The page suggests ${expected} questions but ${missingCount} weren’t found${which}. They may not be loaded yet, be on another page, or use an unsupported layout.`);
  }
  if (inaccessibleFrames) notes.push(`${inaccessibleFrames} embedded frame${inaccessibleFrames === 1 ? '' : 's'} couldn’t be scanned (different website).`);
  if (unstable) notes.push('The page was still changing during the scan — scan again once it has finished loading.');
  return {
    expected,
    found: questions.length,
    missingNumbers,
    missingCount,
    inaccessibleFrames,
    unstable,
    complete: !notes.length,
    notes,
  };
}

/** Records answers on results and paints them in the frames that own the questions. */
async function applyAnswers(tabId, batch, answers, results, settings, { cached = false } = {}) {
  const perDocument = new Map();
  for (const q of batch) {
    const r = results[q.num - 1];
    const answer = answers.get(q.id);
    if (!answer) {
      r.status = 'missing';
      continue;
    }
    Object.assign(r, {
      indices: answer.indices,
      confidence: answer.confidence,
      reasoning: answer.reasoning,
      rawTexts: answer.rawTexts,
      uncertain: answer.uncertain,
      text: answer.text,
      cached,
    });
    if (q.type === 'text' ? !answer.text : !answer.indices.length) {
      r.status = q.type === 'text' ? 'missing' : 'unmatched';
      continue;
    }
    const key = q.documentId || `frame:${q.frameId}`;
    if (!perDocument.has(key)) perDocument.set(key, { frameId: q.frameId, documentId: q.documentId, token: q.token, items: [] });
    perDocument.get(key).items.push({
      localId: q.localId,
      indices: answer.indices,
      confidence: answer.confidence,
      reasoning: answer.reasoning,
      optionTexts: q.options,
      uncertain: answer.uncertain,
      text: answer.text,
      fillText: settings.fillTextAnswers,
    });
  }

  for (const doc of perDocument.values()) {
    const target = doc.documentId ? { tabId, documentIds: [doc.documentId] } : { tabId, frameIds: [doc.frameId] };
    let applied = [];
    try {
      const [res] = await chrome.scripting.executeScript({ target, func: frameHighlight, args: [doc.token, doc.items] });
      applied = res?.result || [];
    } catch {
      applied = []; // frame navigated away
    }
    const byLocal = new Map(applied.map((a) => [a.localId, a]));
    for (const item of doc.items) {
      const r = results.find((x) => x.localId === item.localId && (x.documentId || `frame:${x.frameId}`) === (doc.documentId || `frame:${doc.frameId}`));
      if (!r) continue;
      const outcome = byLocal.get(item.localId);
      r.status = outcome?.applied ? 'highlighted' : 'stale';
      if (outcome?.outcome) r.textOutcome = outcome.outcome; // filled | not-empty | suggested
    }
  }
}

/* ---------- scanning ---------- */

async function runScan(tabId, signal) {
  const started = Date.now();
  setBadge(tabId, '…', '#2f855a');
  // Inject first so even a missing-key error is shown in the page's panel.
  await ensureContentScripts(tabId);
  pushState(tabId, { phase: 'scanning' });

  const settings = await QZ.settings.load();
  if (!settings.apiKey) throw new QZError('NO_API_KEY');

  const { frames, failures } = await collectFrames(tabId, settings.scanScope);

  const top = frames.find((f) => f.frameId === 0);
  if (top?.blocked) throw new QZError('VERIFICATION_PAGE');
  const skipped = frames.reduce((acc, f) => addSkipped(acc, f.blocked ? { captcha: 1 } : f.skipped), {});

  // Flatten questions from every frame; ids are what the model sees.
  let questions = frames
    .filter((f) => !f.blocked)
    .flatMap((f) =>
      f.questions.map((q) => ({
        ...q,
        frameId: f.frameId,
        documentId: f.documentId,
        token: f.token,
      }))
    )
    .map((q, i) => ({ ...q, id: `q${i + 1}`, num: i + 1 }));

  let warning = '';
  if (questions.length > LIMITS.MAX_QUESTIONS) {
    warning = `Only the first ${LIMITS.MAX_QUESTIONS} of ${questions.length} questions were sent. Use the “viewport only” scope for the rest.`;
    questions = questions.slice(0, LIMITS.MAX_QUESTIONS);
  }

  const results = questions.map((q) => ({
    id: q.id,
    num: q.num,
    frameId: q.frameId,
    documentId: q.documentId,
    token: q.token,
    localId: q.localId,
    stem: q.stem,
    options: q.options,
    type: q.type,
    status: 'pending',
    indices: [],
    confidence: null,
    reasoning: '',
  }));

  if (failures.length) {
    if (!questions.length) throw new QZError('PARSE_FAILED', undefined, { detail: failures[0].error });
    warning = [warning, 'Part of this page could not be parsed; some questions may be missing.'].filter(Boolean).join(' ');
  }

  if (!questions.length) {
    const message =
      'No visible multiple-choice questions found. Questions shown as images, or still loading, can’t be read — scroll to them or wait, then scan again.';
    const state = { phase: 'done', results, skipped, model: settings.model, message, completeness: completenessReport(frames, questions, settings.scanScope) };
    pushState(tabId, state);
    setBadge(tabId, '0', '#718096');
    return { found: 0, highlighted: 0, skipped };
  }

  const pageTitle = top?.title || '';
  const completeness = completenessReport(frames, questions, settings.scanScope);
  let modelUsed = settings.model;

  // Reuse answers from earlier scans: only unseen questions cost an API call.
  const fingerprints = new Map(await Promise.all(questions.map(async (q) => [q.id, await fingerprint(settings.model, q)])));
  const cache = await loadCache();
  const cachedAnswers = new Map();
  for (const q of questions) {
    const hit = cache[fingerprints.get(q.id)];
    if (hit) cachedAnswers.set(q.id, hit.a);
  }
  const pending = questions.filter((q) => !cachedAnswers.has(q.id));
  if (cachedAnswers.size) {
    await applyAnswers(tabId, questions.filter((q) => cachedAnswers.has(q.id)), cachedAnswers, results, settings, { cached: true });
  }

  const batches = chunk(pending, LIMITS.BATCH_SIZE);
  for (let b = 0; b < batches.length; b++) {
    pushState(tabId, { phase: 'solving', model: settings.model, total: pending.length, reused: cachedAnswers.size, batch: b + 1, batches: batches.length, results, skipped, completeness });

    let solved;
    try {
      solved = await client.solveBatch(batches[b], { apiKey: settings.apiKey, model: settings.model, pageTitle, signal });
    } catch (err) {
      // Keep earlier highlights; report the failure for the rest.
      if (b === 0 && !cachedAnswers.size) throw err;
      const plain = toPlain(err);
      for (const q of batches.slice(b).flat()) {
        const r = results[q.num - 1];
        r.status = 'error';
        r.error = plain.message;
      }
      warning = [warning, `Some questions failed: ${plain.message}`].filter(Boolean).join(' ');
      break;
    }
    if (signal.aborted) throw new QZError('ABORTED'); // cleared mid-scan: don't repaint
    modelUsed = solved.model || modelUsed;
    await saveToCache(batches[b], solved.answers, fingerprints);
    await applyAnswers(tabId, batches[b], solved.answers, results, settings);
  }

  const highlighted = results.filter((r) => r.status === 'highlighted').length;
  pushState(tabId, {
    phase: 'done',
    model: modelUsed,
    results,
    skipped,
    warning,
    completeness,
    reused: cachedAnswers.size,
    sent: pending.length,
    durationMs: Date.now() - started,
  });
  setBadge(tabId, String(highlighted), '#2f855a');
  return { found: questions.length, highlighted, skipped, warning, completeness, reused: cachedAnswers.size, sent: pending.length };
}

function scanTab(tabId) {
  if (!Number.isInteger(tabId)) return Promise.reject(new QZError('NO_TAB'));
  const existing = inflight.get(tabId);
  if (existing) return existing.promise;

  const controller = new AbortController();
  const promise = runScan(tabId, controller.signal)
    .catch((err) => {
      const error = toPlain(err);
      if (error.code !== 'ABORTED') {
        pushState(tabId, { phase: 'error', error });
        setBadge(tabId, '!', '#c53030');
      }
      throw err;
    })
    .finally(() => inflight.delete(tabId));
  inflight.set(tabId, { promise, controller });
  return promise;
}

function cancelScan(tabId) {
  inflight.get(tabId)?.controller.abort();
}

async function clearTab(tabId) {
  cancelScan(tabId);
  await execute({ tabId, allFrames: true }, frameClear).catch(() => {});
  // "Clear" also forgets cached answers, so the next scan asks the model afresh.
  await chrome.storage.session.remove(CACHE_KEY).catch(() => {});
  setBadge(tabId, '');
  return true;
}

async function focusQuestion(tabId, { frameId, documentId, token, localId }) {
  const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [frameId] };
  const [res] = await execute(target, frameFocus, [token, localId]);
  return Boolean(res?.result);
}

/* ---------- message routing ---------- */

// `pageOnly` handlers are refused when the sender is a content script.
const HANDLERS = {
  [MSG.SCAN_TAB]: { run: (msg, tabId) => scanTab(tabId) },
  [MSG.CLEAR_TAB]: { run: (msg, tabId) => clearTab(tabId) },
  [MSG.FOCUS_QUESTION]: { run: (msg, tabId) => focusQuestion(tabId, msg) },
  [MSG.OPEN_SETTINGS]: { run: () => chrome.runtime.openOptionsPage() },
  [MSG.LIST_MODELS]: { pageOnly: true, run: () => client.listModels() },
  [MSG.TEST_KEY]: {
    pageOnly: true,
    run: async (msg) => client.validateKey(String(msg.apiKey || '').trim() || (await QZ.settings.load(['apiKey'])).apiKey),
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;
  // Extension pages (popup / options tab) name the tab to act on; content
  // scripts may only ever act on the tab they run in.
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  if (handler.pageOnly && !fromExtensionPage) {
    sendResponse({ ok: false, error: { code: 'UNKNOWN', message: 'Not allowed from a web page.' } });
    return false;
  }
  const tabId = fromExtensionPage ? msg.tabId : sender.tab?.id;
  Promise.resolve()
    .then(() => handler.run(msg, tabId))
    .then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: toPlain(err) })
    );
  return true; // async response
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'scan-page' && tab?.id !== undefined) scanTab(tab.id).catch(() => {});
});

// Navigations need no handling: highlights target documentIds, so a scan that
// finishes after the page changed simply reports its questions as stale.
chrome.tabs.onRemoved.addListener(cancelScan);

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const { apiKey } = await QZ.settings.load(['apiKey']);
  if (!apiKey) chrome.runtime.openOptionsPage();
});
