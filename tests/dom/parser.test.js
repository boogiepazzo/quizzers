// Parser, guard, text and highlighter tests against real DOM fixtures in
// headless Chromium. Content-script libraries are injected into the page
// directly (no extension), so these run fast and need no chrome.* APIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { EXT } = require('../helpers/load-lib');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const CONTENT_LIBS = ['lib/config.js', 'lib/errors.js', 'content/guards.js', 'content/text.js', 'content/parser.js', 'content/highlighter.js'];

let browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(async () => {
  await browser?.close();
});

async function open(target, { viewport = { width: 1280, height: 900 } } = {}) {
  const page = await browser.newPage({ viewport });
  await page.route(/^https?:/, (route) => route.abort()); // fixtures are offline
  if (target.startsWith('<')) await page.setContent(target);
  else await page.goto(`file://${path.join(FIXTURES, target)}`);
  for (const file of CONTENT_LIBS) await page.addScriptTag({ path: path.join(EXT, file) });
  return page;
}

const scan = (page, scope = 'page') =>
  page.evaluate((s) => {
    const r = globalThis.QZ.parser.findQuestions({ scope: s });
    return { blocked: r.blocked, skipped: r.skipped, questions: r.questions };
  }, scope);

test('quiz fixture: finds every MCQ layout with clean stems and options', async () => {
  const page = await open('quiz.html');
  const { blocked, questions } = await scan(page);
  await page.close();

  assert.equal(blocked, null);
  const summary = questions.map((q) => [q.source, q.type, q.stem, q.options]);
  assert.deepEqual(summary, [
    ['native', 'single', '1. Which data structure uses FIFO (first-in, first-out) ordering?', ['Stack', 'Queue', 'Binary tree', 'Hash map']],
    ['native', 'single', 'What is the time complexity of binary search on a sorted array?', ['O(n)', 'O(log n)', 'O(n log n)', 'O(1)']],
    ['native', 'multiple', '3. Which of the following are prime numbers? Select all that apply.', ['2', '4', '7', '9']],
    ['aria', 'single', '4. Which planet is known as the Red Planet?', ['Venus', 'Mars', 'Jupiter', 'Saturn']],
    ['select', 'single', '5. The chemical symbol for gold is ____ .', ['Ag', 'Au', 'Gd', 'Go']],
    ['lettered-list', 'unknown', '6. Who wrote “Pride and Prejudice”?', ['Charlotte Brontë', 'Jane Austen', 'Mary Shelley']],
    ['lettered-lines', 'unknown', '7. What is the boiling point of water at sea level, in degrees Celsius?', ['90', '100', '110']],
    ['custom', 'unknown', '8. Solve for x: $2x = 10$', ['x = 3', 'x = 5', 'x = 10']],
    ['native', 'single', '9. Evaluate $\\int_0^1 2x\\,dx$ .', ['0', '1', '2']],
    ['text', 'text', '10. What is the capital of France?', []],
    ['text', 'text', '11. How many sides does a hexagon have?', []],
    ['text', 'text', '12. Which planet is the largest in our solar system?', []],
  ]);
  assert.deepEqual(questions[9].constraints, { numeric: false, maxLength: 40, multiline: false, placeholder: null });
  assert.equal(questions[10].constraints.numeric, true);
});

test('quiz fixture: honeypots, CAPTCHAs, verification prompts and hidden text never reach the payload', async () => {
  const page = await open('quiz.html');
  const { skipped, questions } = await scan(page);
  await page.close();

  assert.deepEqual(skipped, { hidden: 2, honeypot: 2, captcha: 1, verification: 1, outsideViewport: 0 });
  const everything = JSON.stringify(questions);
  for (const banned of ['IGNORE-', 'HONEYPOT', 'traffic lights', 'Are you a human', 'Remember me', 'Analytics', 'English', 'Smith', 'reinforces', 'feedback', 'Search the course']) {
    assert.ok(!everything.includes(banned), `payload must not contain “${banned}”`);
  }
});

test('viewport scope only returns questions currently on screen', async () => {
  const page = await open('quiz.html', { viewport: { width: 1000, height: 600 } });
  const { questions, skipped } = await scan(page, 'viewport');
  await page.close();
  assert.ok(questions.length >= 1 && questions.length < 12, `got ${questions.length}`);
  assert.match(questions[0].stem, /FIFO/);
  assert.ok(skipped.outsideViewport > 0);
});

test('full-page bot challenges block the scan entirely', async () => {
  const page = await open('challenge.html');
  const { blocked, questions } = await scan(page);
  await page.close();
  assert.equal(blocked, 'challenge-page');
  assert.equal(questions.length, 0);
});

test('a page that is just a CAPTCHA widget is treated as a wall', async () => {
  const page = await open(`<!doctype html><title>Verify</title><body>
    <div class="h-captcha" data-sitekey="x" style="width:300px;height:80px;border:1px solid #ccc">widget</div>
    <p>Please complete the check.</p></body>`);
  const { blocked } = await scan(page);
  await page.close();
  assert.equal(blocked, 'captcha-wall');
});

test('a genuine question that merely mentions CAPTCHA is kept', async () => {
  const page = await open(`<!doctype html><body><fieldset><legend>What does the acronym CAPTCHA stand for?</legend>
    <label><input type="radio" name="a"> Completely Automated Public Turing test to tell Computers and Humans Apart</label>
    <label><input type="radio" name="a"> Computer Assisted Program To Check Human Access</label></fieldset></body>`);
  const { questions, skipped } = await scan(page);
  await page.close();
  assert.equal(questions.length, 1);
  assert.equal(skipped.verification, 0);
});

test('text extraction skips visually hidden text and reads MathJax v3 TeX', async () => {
  const page = await open(`<!doctype html><body style="background:#fff;color:#000">
    <div id="t">Visible
      <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">SR-ONLY</span>
      <span style="opacity:0">TRANSPARENT</span>
      <span style="color:rgba(0,0,0,0)">CLEAR-INK</span>
      <span style="text-indent:-9999px;display:inline-block">INDENTED</span>
      <mjx-container class="MathJax" jax="CHTML"><mjx-math aria-hidden="true">GLYPHS</mjx-math><mjx-assistive-mml><math><semantics><mi>y</mi><annotation encoding="application/x-tex">y^2</annotation></semantics></math></mjx-assistive-mml></mjx-container>
      <img alt="a diagram" src="data:,">
    </div></body>`);
  const text = await page.evaluate(() => globalThis.QZ.text.extract(document.getElementById('t')));
  await page.close();
  assert.equal(text, 'Visible $y^2$ [image: a diagram]');
});

test('highlighter marks and fully restores elements without touching their state', async () => {
  const page = await open('quiz.html');
  const result = await page.evaluate(() => {
    const { parser, highlighter, ATTR } = { ...globalThis.QZ, ATTR: globalThis.QZ.highlighter.ATTR };
    const r = parser.findQuestions({});
    const q1 = r.entries[0];
    const select = r.entries[4];
    const label = q1.options[1].row;
    label.setAttribute('title', 'original');
    highlighter.markOption(q1.options[1], { confidence: 0.9, reasoning: 'FIFO' });
    highlighter.markOption(select.options[1], { confidence: 0.3, reasoning: 'Au is gold', optionText: 'Au' });
    const during = {
      row: label.getAttribute(ATTR),
      title: label.getAttribute('title'),
      select: select.options[1].row.getAttribute(ATTR),
      selectTitle: select.options[1].row.getAttribute('title'),
      checked: document.querySelectorAll('input:checked').length,
      selectValue: document.querySelector('select[name=q5]').value,
    };
    highlighter.clear();
    return {
      during,
      after: { remaining: document.querySelectorAll(`[${ATTR}]`).length, title: label.getAttribute('title'), selectTitle: select.options[1].row.hasAttribute('title') },
    };
  });
  await page.close();
  assert.equal(result.during.row, 'high');
  assert.match(result.during.title, /Quizzers suggestion · 90% confident\nFIFO/);
  assert.equal(result.during.select, 'low');
  assert.match(result.during.selectTitle, /suggests: Au/);
  assert.equal(result.during.checked, 0);
  assert.equal(result.during.selectValue, '');
  assert.deepEqual(result.after, { remaining: 0, title: 'original', selectTitle: false });
});

test('fillText drafts only empty fields, notifies the page, and Clear removes unedited drafts', async () => {
  const page = await open('quiz.html');
  const r = await page.evaluate(() => {
    const { parser, highlighter } = globalThis.QZ;
    const entries = parser.findQuestions({}).entries;
    const empty = entries[9].field;
    const typed = entries[11].field;
    let events = 0;
    empty.addEventListener('input', () => events++);
    const out = { a: highlighter.fillText(empty, 'Paris'), b: highlighter.fillText(typed, 'Jupiter') };
    out.values = [empty.value, typed.value, empty.getAttribute('data-qz-highlight'), typed.getAttribute('data-qz-highlight')];
    out.events = events;
    highlighter.clear();
    out.afterClear = [empty.value, typed.value];
    highlighter.fillText(empty, 'Paris');
    empty.value = 'Paris, France'; // user edits the draft
    highlighter.clear();
    out.afterEdit = empty.value;
    out.submitted = document.querySelectorAll('form').length && false;
    return out;
  });
  await page.close();
  assert.equal(r.a, 'filled');
  assert.equal(r.b, 'not-empty');
  assert.deepEqual(r.values, ['Paris', 'Saturn', 'filled', 'suggested']);
  assert.equal(r.events, 1);
  assert.deepEqual(r.afterClear, ['', 'Saturn']);
  assert.equal(r.afterEdit, 'Paris, France', 'user edits are never reverted');
});
