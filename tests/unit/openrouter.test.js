const test = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('../helpers/load-lib');

const QZ = loadLib('lib/config.js', 'lib/errors.js', 'lib/prompt.js', 'lib/openrouter.js');

const questions = [{ id: 'q1', type: 'single', stem: 'Which is FIFO?', options: ['Stack', 'Queue'] }];
const ANSWER = { answers: [{ id: 'q1', correct_indices: [1], correct_texts: ['Queue'], confidence: 0.9, reasoning: 'FIFO.' }] };

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const chat = (content, extra = {}) =>
  json(200, { model: 'test/model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content }, ...extra }] });

/** A fetch stub that serves `responses` in order (the last one repeats) and records calls. */
function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === 'function' ? next(url, init) : next.clone();
  };
  return { calls, fetchImpl };
}

function client(fetchImpl, extra = {}) {
  const sleeps = [];
  const c = QZ.openrouter.createClient({ fetchImpl, sleep: async (ms) => sleeps.push(ms), timeoutMs: 1000, ...extra });
  return { c, sleeps };
}

const solve = (c, opts = {}) => c.solveBatch(questions, { apiKey: 'sk-or-v1-x', model: 'test/model', ...opts });

test('sends a strict json_schema request with auth and attribution headers', async () => {
  const { calls, fetchImpl } = stubFetch([chat(JSON.stringify(ANSWER))]);
  const { c } = client(fetchImpl);
  const result = await solve(c, { pageTitle: 'PS3' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-or-v1-x');
  assert.ok(calls[0].init.headers['X-Title']);
  const body = calls[0].body;
  assert.equal(body.model, 'test/model');
  assert.equal(body.temperature, 0);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema, QZ.prompt.RESPONSE_SCHEMA);
  assert.equal(result.mode, 'json_schema');
  assert.deepEqual(result.answers.get('q1').indices, [1]);
});

test('degrades json_schema → json_object when the provider rejects it, and remembers', async () => {
  const { calls, fetchImpl } = stubFetch([
    json(400, { error: { code: 400, message: 'response_format json_schema is not supported by this provider' } }),
    chat(JSON.stringify(ANSWER)),
  ]);
  const { c } = client(fetchImpl);
  const first = await solve(c);
  assert.equal(first.mode, 'json_object');
  assert.equal(calls[1].body.response_format.type, 'json_object');

  calls.length = 0;
  await solve(c);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.response_format.type, 'json_object', 'cached mode is used first');
});

test('falls back to a plain prompt when the reply is not JSON, then parses fenced JSON', async () => {
  const { calls, fetchImpl } = stubFetch([
    chat('I think the answer is Queue.'),
    chat('I think the answer is Queue.'),
    chat('```json\n' + JSON.stringify(ANSWER) + '\n```'),
  ]);
  const { c } = client(fetchImpl);
  const result = await solve(c);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.response_format, undefined);
  assert.equal(result.mode, 'plain');
});

test('maps auth, credit, moderation and model errors without retrying', async () => {
  const cases = [
    [401, 'User not found.', 'INVALID_API_KEY'],
    [402, 'Insufficient credits', 'INSUFFICIENT_CREDITS'],
    [403, 'flagged', 'MODERATION'],
    [404, 'No endpoints found for test/model.', 'MODEL_NOT_FOUND'],
    [400, 'test/model is not a valid model ID', 'MODEL_NOT_FOUND'],
    [400, 'This endpoint\'s maximum context length is 8192 tokens', 'CONTEXT_TOO_LONG'],
  ];
  for (const [status, message, code] of cases) {
    const { calls, fetchImpl } = stubFetch([json(status, { error: { code: status, message } })]);
    const { c } = client(fetchImpl);
    await assert.rejects(solve(c), (err) => err.code === code && err.status === status, `${status} → ${code}`);
    assert.equal(calls.length, 1, `${code} is not retried`);
  }
});

test('retries 429 honouring Retry-After, then succeeds', async () => {
  const { calls, fetchImpl } = stubFetch([
    json(429, { error: { code: 429, message: 'slow down' } }, { 'retry-after': '2' }),
    chat(JSON.stringify(ANSWER)),
  ]);
  const { c, sleeps } = client(fetchImpl);
  await solve(c);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('gives up on persistent 5xx after the retry budget', async () => {
  const { calls, fetchImpl } = stubFetch([json(503, { error: { code: 503, message: 'overloaded' } })]);
  const { c, sleeps } = client(fetchImpl, { maxRetries: 2 });
  await assert.rejects(solve(c), (err) => err.code === 'PROVIDER_ERROR');
  assert.equal(calls.length, 3);
  assert.equal(sleeps.length, 2);
});

test('treats an error object inside a 200 body as a provider error', async () => {
  const { calls, fetchImpl } = stubFetch([json(200, { error: { code: 502, message: 'upstream died' } }), chat(JSON.stringify(ANSWER))]);
  const { c } = client(fetchImpl);
  await solve(c);
  assert.equal(calls.length, 2);
});

test('retries network failures and reports NETWORK when they persist', async () => {
  let n = 0;
  const flaky = async () => {
    n++;
    if (n === 1) throw new TypeError('Failed to fetch');
    return chat(JSON.stringify(ANSWER));
  };
  await solve(client(flaky).c);
  assert.equal(n, 2);

  const down = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(solve(client(down).c), (err) => err.code === 'NETWORK');
});

test('times out a hung request', async () => {
  const hang = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const { c } = client(hang, { timeoutMs: 30 });
  await assert.rejects(solve(c), (err) => err.code === 'TIMEOUT');
});

test('honours the caller abort signal', async () => {
  const controller = new AbortController();
  const hang = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const { c } = client(hang, { timeoutMs: 5000 });
  const pending = solve(c, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => err.code === 'ABORTED');
});

test('reports truncation and refusals clearly', async () => {
  const truncated = stubFetch([
    json(200, { choices: [{ finish_reason: 'length', message: { content: '{"answers":[{"id":"q1","correct_' } }] }),
  ]);
  await assert.rejects(solve(client(truncated.fetchImpl).c), (err) => err.code === 'TRUNCATED');

  const refused = stubFetch([json(200, { choices: [{ finish_reason: 'stop', message: { content: '', refusal: 'I cannot help.' } }] })]);
  await assert.rejects(solve(client(refused.fetchImpl).c), (err) => err.code === 'REFUSED');
});

test('requires an API key', async () => {
  const { calls, fetchImpl } = stubFetch([chat('{}')]);
  await assert.rejects(client(fetchImpl).c.solveBatch(questions, { apiKey: '', model: 'm/x' }), (err) => err.code === 'NO_API_KEY');
  assert.equal(calls.length, 0);
});

test('validateKey and listModels map OpenRouter responses', async () => {
  const keyFetch = stubFetch([json(200, { data: { label: 'my key', usage: 1.5, limit: null, limit_remaining: null, is_free_tier: false } })]);
  const info = await client(keyFetch.fetchImpl).c.validateKey('sk-or-v1-x');
  assert.equal(keyFetch.calls[0].url, 'https://openrouter.ai/api/v1/key');
  assert.deepEqual(info, { label: 'my key', usage: 1.5, limit: null, limitRemaining: null, isFreeTier: false });

  const modelsFetch = stubFetch([
    json(200, {
      data: [
        { id: 'b/plain', name: 'Plain', supported_parameters: ['temperature'], architecture: { output_modalities: ['text'] } },
        { id: 'a/structured', name: 'Structured', supported_parameters: ['structured_outputs'], architecture: { output_modalities: ['text'] } },
        { id: 'c/image', name: 'Image only', supported_parameters: [], architecture: { output_modalities: ['image'] } },
      ],
    }),
  ]);
  const models = await client(modelsFetch.fetchImpl).c.listModels();
  assert.deepEqual(
    models.map((m) => [m.id, m.structured]),
    [
      ['a/structured', true],
      ['b/plain', false],
    ]
  );
});
