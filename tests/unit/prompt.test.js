const test = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('../helpers/load-lib');

const QZ = loadLib('lib/config.js', 'lib/errors.js', 'lib/prompt.js');
const { buildMessages, parseModelJson, normalizeAnswers, matchOptionText, RESPONSE_SCHEMA, SYSTEM_PROMPT } = QZ.prompt;

const questions = [
  { id: 'q1', type: 'single', stem: 'Which data structure is FIFO?', options: ['Stack', 'Queue', 'Binary tree', 'Hash map'] },
  { id: 'q2', type: 'multiple', stem: 'Which are prime?', options: ['2', '4', '7', '9'] },
  { id: 'q3', type: 'unknown', stem: 'Complexity of binary search?', options: ['O(n)', 'O(log n)', 'O(n log n)'] },
];

test('buildMessages sends a system prompt and a JSON payload with zero-based indices', () => {
  const messages = buildMessages(questions, { pageTitle: 'Problem Set 3' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, SYSTEM_PROMPT);
  assert.match(SYSTEM_PROMPT, /untrusted/i, 'system prompt guards against injected instructions');
  const user = messages[1].content;
  const payload = JSON.parse(user.slice(user.indexOf('{')));
  assert.equal(payload.page_title, 'Problem Set 3');
  assert.deepEqual(payload.questions[0].options[1], { index: 1, label: 'B', text: 'Queue' });
  assert.equal(payload.questions[1].type, 'multiple');
});

test('response schema is strict-mode compatible (all properties required, no extras)', () => {
  const visit = (node) => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(visit);
    }
    if (node.type === 'array') visit(node.items);
  };
  visit(RESPONSE_SCHEMA);
});

test('parseModelJson tolerates code fences, prose and bare arrays', () => {
  assert.deepEqual(parseModelJson('{"answers":[]}'), { answers: [] });
  assert.deepEqual(parseModelJson('```json\n{"answers":[1]}\n```'), { answers: [1] });
  assert.deepEqual(parseModelJson('Sure! Here you go: {"answers":[2]} Hope it helps.'), { answers: [2] });
  assert.deepEqual(parseModelJson('[{"id":"q1"}]'), [{ id: 'q1' }]);
  assert.deepEqual(parseModelJson({ answers: [] }), { answers: [] });
  assert.throws(() => parseModelJson('not json at all'), SyntaxError);
  assert.throws(() => parseModelJson(''), SyntaxError);
});

test('matchOptionText handles letters, formatting differences and near-duplicates', () => {
  const opts = ['O(n)', 'O(log n)', 'O(n log n)', 'O(1)'];
  assert.equal(matchOptionText('B', opts), 1);
  assert.equal(matchOptionText('(c)', opts), 2);
  assert.equal(matchOptionText('Option D', opts), 3);
  assert.equal(matchOptionText('o(log n)', opts), 1);
  assert.equal(matchOptionText('B) O(log n)', opts), 1);
  assert.equal(matchOptionText('O(n)', opts), 0, 'exact match beats containment');
  assert.equal(matchOptionText('Quadratic time', opts), -1);
  assert.equal(matchOptionText('', opts), -1);
  assert.equal(matchOptionText('The Queue data structure', ['Stack', 'Queue data structure']), 1);
});

test('normalizeAnswers: indices and texts that agree', () => {
  const raw = { answers: [{ id: 'q1', correct_indices: [1], correct_texts: ['Queue'], confidence: 0.9, reasoning: 'FIFO.' }] };
  const out = normalizeAnswers(raw, questions);
  assert.deepEqual(out.get('q1'), { indices: [1], confidence: 0.9, reasoning: 'FIFO.', method: 'index+text', rawTexts: ['Queue'] });
});

test('normalizeAnswers: corrects 1-based indices using the option text', () => {
  const raw = { answers: [{ id: 'q2', correct_indices: [1, 3], correct_texts: ['2', '7'], confidence: 0.8, reasoning: '' }] };
  const a = normalizeAnswers(raw, questions).get('q2');
  assert.deepEqual(a.indices, [0, 2]);
  assert.equal(a.method, 'one-based');
});

test('normalizeAnswers: text wins when it contradicts the index', () => {
  const raw = { answers: [{ id: 'q3', correct_indices: [0], correct_texts: ['O(log n)'], confidence: 0.7, reasoning: '' }] };
  const a = normalizeAnswers(raw, questions).get('q3');
  assert.deepEqual(a.indices, [1]);
  assert.equal(a.method, 'text-override');
});

test('normalizeAnswers: letters, percentages, single-answer trimming, missing ids', () => {
  const raw = {
    answers: [
      { id: 'q1', correct_indices: ['B', 'C'], correct_texts: [], confidence: 93, reasoning: 'x' },
      { id: 'q99', correct_indices: [0], correct_texts: [], confidence: 1, reasoning: '' },
    ],
  };
  const out = normalizeAnswers(raw, questions);
  assert.deepEqual(out.get('q1').indices, [1], 'single-answer question keeps one option');
  assert.equal(out.get('q1').confidence, 0.93);
  assert.equal(out.has('q99'), false);
  assert.equal(out.has('q2'), false);
});

test('normalizeAnswers: accepts keyed objects and out-of-range indices', () => {
  const out = normalizeAnswers({ q1: { correct_index: 7, correct_text: 'Queue', confidence: '0.6' } }, questions);
  assert.deepEqual(out.get('q1').indices, [1]);
  assert.equal(out.get('q1').confidence, 0.6);
  const none = normalizeAnswers({ answers: [{ id: 'q3', correct_indices: [9], correct_texts: ['nothing like it'] }] }, questions);
  assert.deepEqual(none.get('q3').indices, []);
  assert.equal(none.get('q3').method, 'none');
});
