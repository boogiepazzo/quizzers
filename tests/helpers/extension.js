// Launches Chromium with the unpacked extension and stubs OpenRouter inside
// the service worker, so end-to-end tests never hit the real API.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { EXT } = require('./load-lib');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

// Correct option text(s) keyed by a phrase from each fixture question.
const ANSWER_KEY = [
  ['FIFO', ['Queue']],
  ['binary search', ['O(log n)']],
  ['prime numbers', ['2', '7']],
  ['Red Planet', ['Mars']],
  ['symbol for gold', ['Au']],
  ['Pride and Prejudice', ['Jane Austen']],
  ['boiling point', ['100']],
  ['Solve for x', ['x = 5']],
  ['Evaluate', ['1']],
  ['Not Found', ['404']],
];

async function launchExtension() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quizzers-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', // full Chromium build: supports extensions in headless mode
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  // Serve fixtures on real course-platform origins so manifest matches apply.
  const serve = (pattern, file) => context.route(pattern, (route) => route.fulfill({ path: path.join(FIXTURES, file), contentType: 'text/html' }));
  await serve('https://ocw.mit.edu/**', 'quiz.html');
  await serve('https://courses.edx.org/**', 'edx-frame.html');
  await serve('https://example.org/**', 'other-frame.html');
  await serve('https://www.coursera.org/challenge**', 'challenge.html');
  // Host-permitted but not in content_scripts.matches → exercises on-demand injection.
  await serve('https://openrouter.ai/quizzers-fixture**', 'quiz.html');

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;

  return {
    context,
    extensionId,
    /** The worker can be restarted when idle, so always fetch the live one. */
    async sw() {
      const [live] = context.serviceWorkers();
      return live || context.waitForEvent('serviceworker');
    },
    async close() {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Replaces fetch inside the service worker.
 * @param {'answer'|{status:number, message:string}} chatBehaviour
 */
async function mockOpenRouter(sw, chatBehaviour = 'answer') {
  await sw.evaluate(
    ({ key, behaviour }) => {
      self.__qzRequests = [];
      self.fetch = async (url, init = {}) => {
        const href = String(url);
        const body = init.body ? JSON.parse(init.body) : null;
        self.__qzRequests.push({ url: href, body, headers: init.headers || {} });
        const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

        if (href.endsWith('/api/v1/key')) return reply(200, { data: { label: 'e2e key', usage: 0.25, limit: 10, limit_remaining: 9.75 } });
        if (href.endsWith('/api/v1/models')) {
          return reply(200, {
            data: [
              { id: 'zeta/structured-model', name: 'Zeta', supported_parameters: ['structured_outputs'], architecture: { output_modalities: ['text'] } },
              { id: 'omega/plain-model', name: 'Omega', supported_parameters: [], architecture: { output_modalities: ['text'] } },
            ],
          });
        }
        if (behaviour !== 'answer') return reply(behaviour.status, { error: { code: behaviour.status, message: behaviour.message } });

        const user = body.messages.find((m) => m.role === 'user').content;
        const payload = JSON.parse(user.slice(user.indexOf('{')));
        const answers = payload.questions.map((q) => {
          const hit = key.find(([phrase]) => q.question.includes(phrase));
          const texts = hit ? hit[1] : [];
          const lowConfidence = q.question.includes('Evaluate');
          return {
            id: q.id,
            // Q7 deliberately answers with a 1-based index to exercise text matching.
            correct_indices: texts.map((t) => q.options.findIndex((o) => o.text === t) + (q.question.includes('boiling') ? 1 : 0)),
            correct_texts: texts,
            confidence: lowConfidence ? 0.4 : 0.93,
            reasoning: `Mock reasoning for ${q.id}.`,
          };
        });
        return reply(200, {
          model: body.model,
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ answers }) } }],
        });
      };
    },
    { key: ANSWER_KEY, behaviour: chatBehaviour }
  );
}

const requests = (sw) => sw.evaluate(() => self.__qzRequests || []);

async function setSettings(sw, values) {
  await sw.evaluate(async (v) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(v);
  }, values);
}

/** Runs a scan from the worker (as the popup/shortcut would) and returns {result|errorCode}. */
async function scanFromWorker(sw, urlPattern) {
  return sw.evaluate(async (pattern) => {
    const [tab] = await chrome.tabs.query({ url: pattern });
    try {
      return { result: await scanTab(tab.id) };
    } catch (err) {
      return { errorCode: err.code || String(err) };
    }
  }, urlPattern);
}

const badgeText = (sw, urlPattern) =>
  sw.evaluate(async (pattern) => {
    const [tab] = await chrome.tabs.query({ url: pattern });
    return chrome.action.getBadgeText({ tabId: tab.id });
  }, urlPattern);

const highlighted = (frame) =>
  frame.evaluate(() =>
    Array.from(document.querySelectorAll('[data-qz-highlight]'))
      .filter((el) => el.tagName !== 'OPTION')
      .map((el) => {
        const label = el.tagName === 'SELECT' ? el.querySelector('option[data-qz-highlight]')?.text || '' : el.textContent;
        return `${el.getAttribute('data-qz-highlight')}:${label.trim()}`;
      })
  );

module.exports = { launchExtension, mockOpenRouter, requests, setSettings, scanFromWorker, badgeText, highlighted, ANSWER_KEY };
