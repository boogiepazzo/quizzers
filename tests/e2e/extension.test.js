// End-to-end: the unpacked extension in headless Chromium, with OpenRouter
// stubbed inside the service worker.
const test = require('node:test');
const assert = require('node:assert/strict');
const { launchExtension, mockOpenRouter, requests, setSettings, scanFromWorker, badgeText, highlighted } = require('../helpers/extension');

const KEYED = { apiKey: 'sk-or-v1-e2e', model: 'test/mock-model' };
const EXPECTED_TOP = [
  'high:Queue', 'high:O(log n)', 'high:2', 'maybe:7', 'high:Mars', 'high:Au', 'high:Jane Austen', 'high:x = 5', 'low:1',
  'filled:Paris', 'filled:6', 'suggested:Saturn', // text: drafts in empty fields; the typed answer is kept
];

let ext;
test.before(async () => {
  ext = await launchExtension();
});
test.after(async () => {
  await ext?.close();
});

async function openQuiz(url = 'https://ocw.mit.edu/courses/quizzers-e2e/quiz') {
  const page = await ext.context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  return { page, errors };
}

const edxFrame = (page) => page.frames().find((f) => f.url().startsWith('https://courses.edx.org/'));

test('clicking the floating button highlights answers across frames — and never selects anything', async () => {
  const sw = await ext.sw();
  await setSettings(sw, KEYED);
  await mockOpenRouter(sw);
  const { page, errors } = await openQuiz();
  await page.waitForFunction(() => document.querySelector('quizzers-ui'));

  // The trigger lives in a closed shadow root; click it where a user would.
  const { width, height } = page.viewportSize();
  await page.mouse.click(width - 16 - 22, height - 24 - 22);
  await page.waitForFunction(() => document.querySelectorAll('[data-qz-highlight]').length >= 10, null, { timeout: 15_000 });
  await edxFrame(page).waitForFunction(() => document.querySelector('[data-qz-highlight]'));

  assert.deepEqual(await highlighted(page), EXPECTED_TOP);
  assert.deepEqual(await highlighted(edxFrame(page)), ['high:404']);

  // Q7 is a bare text run, highlighted with the CSS Custom Highlight API.
  const rangeText = await page.evaluate(() => [...CSS.highlights.get('qz-correct')].map((r) => r.toString().trim()));
  assert.deepEqual(rangeText, ['B) 100']);

  // Choice questions are never auto-answered: nothing checked, no dropdown changed.
  assert.equal(await page.evaluate(() => document.querySelectorAll('input:checked').length), 0);
  assert.equal(await page.evaluate(() => document.querySelector('select[name=q5]').value), '');
  assert.equal(await edxFrame(page).evaluate(() => document.querySelectorAll('input:checked').length), 0);

  // 13 questions (12 top frame + 1 edX iframe) in batches of 12 → two requests, nothing else.
  const reqs = await requests(sw);
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].headers.Authorization, 'Bearer sk-or-v1-e2e');
  assert.equal(reqs[0].body.response_format.type, 'json_schema');
  const users = reqs.map((r) => r.body.messages.find((m) => m.role === 'user').content);
  const user = users.join('\n');
  const sent = users.flatMap((u) => JSON.parse(u.slice(u.indexOf('{'))).questions);
  assert.deepEqual(sent.map((q) => q.id), Array.from({ length: 13 }, (_, i) => `q${i + 1}`));
  assert.match(sent[12].question, /Not Found/);
  assert.deepEqual(sent[9].constraints, { max_length: 40, format: 'single line' });
  for (const banned of ['IGNORE-', 'HONEYPOT', 'OTHER-ORIGIN', 'traffic lights', 'Are you a human', 'Remember me', 'Analytics']) {
    assert.ok(!user.includes(banned), `request must not contain “${banned}”`);
  }

  assert.equal(await badgeText(sw, 'https://ocw.mit.edu/*'), '13');
  assert.deepEqual(errors, []);

  // Clearing removes highlights in every frame.
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://ocw.mit.edu/*' });
    await clearTab(tab.id);
  });
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-qz-highlight]').length), 0);
  assert.equal(await page.evaluate(() => CSS.highlights.size), 0);
  assert.deepEqual(
    await page.evaluate(() => ['answer_q10', 'answer_q11', 'answer_q12'].map((n) => document.querySelector(`[name=${n}]`).value)),
    ['', '', 'Saturn'],
    'unedited drafts are removed; user text stays'
  );
  assert.equal(await edxFrame(page).evaluate(() => document.querySelectorAll('[data-qz-highlight]').length), 0);
  await page.close();
});

test('missing API key: no request is made and the user is told what to do', async () => {
  const sw = await ext.sw();
  await setSettings(sw, { model: 'test/mock-model' });
  await mockOpenRouter(sw);
  const { page } = await openQuiz();
  await page.waitForFunction(() => document.querySelector('quizzers-ui'));

  assert.deepEqual(await scanFromWorker(sw, 'https://ocw.mit.edu/*'), { errorCode: 'NO_API_KEY' });
  assert.equal((await requests(sw)).length, 0);
  assert.equal(await badgeText(sw, 'https://ocw.mit.edu/*'), '!');
  await page.close();
});

test('rejected API key surfaces INVALID_API_KEY and leaves the page untouched', async () => {
  const sw = await ext.sw();
  await setSettings(sw, KEYED);
  await mockOpenRouter(sw, { status: 401, message: 'User not found.' });
  const { page } = await openQuiz();
  await page.waitForFunction(() => document.querySelector('quizzers-ui'));

  assert.deepEqual(await scanFromWorker(sw, 'https://ocw.mit.edu/*'), { errorCode: 'INVALID_API_KEY' });
  assert.equal((await requests(sw)).length, 1, '401 is not retried');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-qz-highlight]').length), 0);
  await page.close();
});

test('bot-challenge pages are refused before anything is sent', async () => {
  const sw = await ext.sw();
  await setSettings(sw, KEYED);
  await mockOpenRouter(sw);
  const { page } = await openQuiz('https://www.coursera.org/challenge');
  await page.waitForFunction(() => document.querySelector('quizzers-ui'));

  assert.deepEqual(await scanFromWorker(sw, 'https://www.coursera.org/*'), { errorCode: 'VERIFICATION_PAGE' });
  assert.equal((await requests(sw)).length, 0);
  await page.close();
});

test('injects on demand on sites outside the default list (popup / shortcut path)', async () => {
  const sw = await ext.sw();
  await setSettings(sw, KEYED);
  await mockOpenRouter(sw);
  const { page } = await openQuiz('https://openrouter.ai/quizzers-fixture');
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('quizzers-ui'))), false, 'not auto-injected');

  const { result } = await scanFromWorker(sw, 'https://openrouter.ai/quizzers-fixture*');
  // 12 from the injected top frame + 1 from the embedded edX frame (declared match).
  assert.equal(result.found, 13);
  assert.equal(result.highlighted, 13);
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('quizzers-ui'))), true, 'UI mounted after injection');
  assert.deepEqual(await highlighted(page), EXPECTED_TOP);
  await page.close();
});

test('popup saves settings, tests the key and loads the model list', async () => {
  const sw = await ext.sw();
  await setSettings(sw, {});
  await mockOpenRouter(sw);
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${ext.extensionId}/popup.html`);

  await page.fill('#api-key', 'sk-or-v1-from-popup');
  await page.selectOption('#model', 'anthropic/claude-haiku-5.5');
  await page.check('input[name="scope"][value="viewport"]');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('settings-status').textContent.startsWith('Saved'));
  const stored = await sw.evaluate(() => chrome.storage.local.get(['apiKey', 'model', 'scanScope']));
  assert.deepEqual(stored, { apiKey: 'sk-or-v1-from-popup', model: 'anthropic/claude-haiku-5.5', scanScope: 'viewport' });

  await page.click('#test-key');
  await page.waitForFunction(() => document.getElementById('settings-status').dataset.kind === 'ok');
  assert.match(await page.textContent('#settings-status'), /Key works \(“e2e key”\) · \$0\.25 used · \$9\.75 remaining/);

  await page.click('#load-models');
  await page.waitForFunction(() => /models loaded/.test(document.getElementById('models-status').textContent));
  const values = await page.$$eval('#model option', (opts) => opts.map((o) => o.value));
  assert.ok(values.includes('zeta/structured-model') && values.includes('omega/plain-model'));

  // Custom model IDs are validated.
  await page.selectOption('#model', '__custom__');
  await page.fill('#custom-model', 'not a model id');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('settings-status').dataset.kind === 'error');
  assert.equal((await sw.evaluate(() => chrome.storage.local.get('model'))).model, 'anthropic/claude-haiku-5.5');
  await page.close();
});
