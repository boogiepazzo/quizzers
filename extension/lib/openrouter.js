/*
 * OpenRouter HTTP client. Used only by the service worker, so the API key
 * never leaves the extension's privileged context.
 *
 * Structured output is attempted in three modes, degrading when a model or
 * provider rejects one:  json_schema (strict)  →  json_object  →  plain prompt.
 * The mode that worked is remembered per model for the worker's lifetime.
 */
(() => {
  const QZ = (globalThis.QZ = globalThis.QZ || {});
  if (QZ.openrouter) return;

  const { QZError } = QZ.errors;
  const { API_URL, MODELS_URL, KEY_URL, APP_TITLE, APP_REFERER, LIMITS } = QZ.config;

  const MODES = Object.freeze(['json_schema', 'json_object', 'plain']);

  function defaultSleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new QZError('ABORTED'));
        },
        { once: true }
      );
    });
  }

  function backoffMs(attempt) {
    return Math.min(8000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
  }

  function retryAfterMs(res) {
    const header = res.headers?.get?.('retry-after');
    if (!header) return null;
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.min(10_000, Math.max(0, secs * 1000));
    const date = Date.parse(header);
    return Number.isFinite(date) ? Math.min(10_000, Math.max(0, date - Date.now())) : null;
  }

  /** Maps an HTTP status + OpenRouter error body to a QZError. */
  function errorFromStatus(status, serverMessage, model) {
    const msg = serverMessage ? String(serverMessage).slice(0, 300) : '';
    const withDetail = (code, text) => new QZError(code, text, { status, detail: msg });
    switch (true) {
      case status === 401:
        return withDetail('INVALID_API_KEY');
      case status === 402:
        return withDetail('INSUFFICIENT_CREDITS');
      case status === 403:
        return withDetail('MODERATION', msg ? `Blocked by moderation (403): ${msg}` : undefined);
      case status === 408:
        return new QZError('TIMEOUT', undefined, { status, retryable: true, detail: msg });
      case /not a valid model|no endpoints found for|model .{0,80}not (found|exist)/i.test(msg):
        return withDetail('MODEL_NOT_FOUND', `Model “${model}” is not available on OpenRouter: ${msg} Pick another model in the popup.`);
      case status === 413 || /context length|maximum context|too many tokens|too long/i.test(msg):
        return withDetail('CONTEXT_TOO_LONG');
      case status === 429:
        return new QZError('RATE_LIMITED', undefined, { status, retryable: true, detail: msg });
      case status === 404 && !/response_format|json|schema|structured|support|parameter/i.test(msg):
        return withDetail('MODEL_NOT_FOUND', `Model “${model}” is not available on OpenRouter${msg ? `: ${msg}` : ''}. Pick another model in the popup.`);
      case status === 400 || status === 404 || status === 422:
        return new QZError('BAD_REQUEST', msg ? `OpenRouter rejected the request (${status}): ${msg}` : undefined, {
          status,
          degradable: true,
          detail: msg,
        });
      case status >= 500:
        return new QZError('PROVIDER_ERROR', msg ? `Provider error (${status}): ${msg}` : undefined, {
          status,
          retryable: true,
          detail: msg,
        });
      default:
        return new QZError('UNKNOWN', `Unexpected OpenRouter response (${status})${msg ? `: ${msg}` : ''}`, { status });
    }
  }

  function messageContent(message) {
    const c = message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
    if (c && typeof c === 'object') return c; // some providers return parsed JSON
    return '';
  }

  function maxTokensFor(count) {
    // Generous: reasoning models spend part of the budget thinking, and we only
    // pay for tokens actually generated.
    return Math.min(16_000, 2_000 + 450 * count);
  }

  function buildBody(model, messages, mode, count) {
    const body = { model, messages, temperature: 0, max_tokens: maxTokensFor(count) };
    if (mode === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'mcq_answers', strict: true, schema: QZ.prompt.RESPONSE_SCHEMA },
      };
    } else if (mode === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    return body;
  }

  /**
   * @param {{fetchImpl?: typeof fetch, sleep?: (ms:number, signal?:AbortSignal)=>Promise<void>, timeoutMs?: number, maxRetries?: number}} [deps]
   */
  function createClient(deps = {}) {
    // Resolve fetch lazily so tests (and the SW) can swap globalThis.fetch.
    const doFetch = deps.fetchImpl || ((...args) => globalThis.fetch(...args));
    const sleep = deps.sleep || defaultSleep;
    const timeoutMs = deps.timeoutMs ?? LIMITS.REQUEST_TIMEOUT_MS;
    const maxRetries = deps.maxRetries ?? LIMITS.MAX_RETRIES;
    const modeCache = new Map(); // model -> index into MODES

    /** One HTTP round-trip with a timeout linked to the caller's signal. */
    async function send(url, init, signal) {
      if (signal?.aborted) throw new QZError('ABORTED');
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await doFetch(url, { ...init, signal: controller.signal });
      } catch (err) {
        // Not retried: a stalled model is unlikely to recover, and the user is waiting.
        if (timedOut) throw new QZError('TIMEOUT', `OpenRouter took longer than ${Math.round(timeoutMs / 1000)}s to respond.`);
        if (signal?.aborted) throw new QZError('ABORTED');
        throw new QZError('NETWORK', undefined, { retryable: true, detail: String(err?.message || err) });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }

    async function readJson(res) {
      const text = await res.text();
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return { _raw: text };
      }
    }

    /** Request with retries for transient failures (429, 5xx, network). */
    async function requestJson(url, init, { signal, model } = {}) {
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await send(url, init, signal);
        } catch (err) {
          if (err.retryable && attempt < maxRetries) {
            await sleep(backoffMs(attempt), signal);
            continue;
          }
          throw err;
        }
        const data = await readJson(res);
        if (res.ok && !data.error) return data;

        // OpenRouter can also report errors inside a 200 body.
        const status = res.ok ? Number(data.error?.code) || 502 : res.status;
        const err = errorFromStatus(status, data.error?.message || data._raw, model);
        if (err.retryable && attempt < maxRetries) {
          await sleep(retryAfterMs(res) ?? backoffMs(attempt), signal);
          continue;
        }
        throw err;
      }
    }

    function headers(apiKey) {
      return {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': APP_REFERER,
        'X-Title': APP_TITLE,
      };
    }

    /**
     * Solves one batch of questions.
     * @param {Array<{id:string,type:string,stem:string,context?:string,options:string[]}>} questions
     * @param {{apiKey:string, model:string, pageTitle?:string, signal?:AbortSignal}} opts
     */
    async function solveBatch(questions, { apiKey, model, pageTitle, signal }) {
      if (!apiKey) throw new QZError('NO_API_KEY');
      const messages = QZ.prompt.buildMessages(questions, { pageTitle });
      let lastError;

      for (let mode = modeCache.get(model) ?? 0; mode < MODES.length; mode++) {
        const body = buildBody(model, messages, MODES[mode], questions.length);
        try {
          const data = await requestJson(
            API_URL,
            { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body) },
            { signal, model }
          );
          const choice = data.choices?.[0];
          if (!choice) throw new QZError('BAD_RESPONSE', 'OpenRouter returned no choices.', { degradable: true });
          if (choice.error) {
            throw errorFromStatus(Number(choice.error.code) || 502, choice.error.message, model);
          }
          const content = messageContent(choice.message);
          const finish = choice.finish_reason || choice.native_finish_reason;
          if (!content) {
            if (choice.message?.refusal) throw new QZError('REFUSED', `The model declined: ${String(choice.message.refusal).slice(0, 200)}`);
            if (finish === 'length') throw new QZError('TRUNCATED');
            throw new QZError('BAD_RESPONSE', 'The model returned an empty reply.', { degradable: true });
          }

          let parsed;
          try {
            parsed = QZ.prompt.parseModelJson(content);
          } catch {
            if (finish === 'length') throw new QZError('TRUNCATED');
            throw new QZError('BAD_RESPONSE', undefined, { degradable: true, detail: String(content).slice(0, 200) });
          }

          modeCache.set(model, mode);
          return {
            answers: QZ.prompt.normalizeAnswers(parsed, questions),
            model: data.model || model,
            mode: MODES[mode],
            usage: data.usage || null,
          };
        } catch (err) {
          lastError = err;
          if (!(err instanceof QZError) || !err.degradable) throw err;
        }
      }
      throw lastError;
    }

    /** GET /key — validates a key and returns its label/usage/limit. */
    async function validateKey(apiKey) {
      if (!apiKey) throw new QZError('NO_API_KEY');
      const data = await requestJson(KEY_URL, { method: 'GET', headers: headers(apiKey) });
      const info = data.data || data;
      return {
        label: info.label ?? null,
        usage: info.usage ?? null,
        limit: info.limit ?? null,
        limitRemaining: info.limit_remaining ?? null,
        isFreeTier: info.is_free_tier ?? null,
      };
    }

    /** GET /models — public; returns text-output models, structured-capable first. */
    async function listModels() {
      const data = await requestJson(MODELS_URL, { method: 'GET' });
      const models = (Array.isArray(data.data) ? data.data : [])
        .filter((m) => m && typeof m.id === 'string')
        .filter((m) => {
          const out = m.architecture?.output_modalities;
          return !Array.isArray(out) || out.includes('text');
        })
        .map((m) => {
          const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
          return {
            id: m.id,
            name: String(m.name || m.id),
            structured: params.includes('structured_outputs') || params.includes('response_format'),
          };
        });
      models.sort((a, b) => Number(b.structured) - Number(a.structured) || a.id.localeCompare(b.id));
      return models;
    }

    return Object.freeze({ solveBatch, validateKey, listModels });
  }

  QZ.openrouter = Object.freeze({ createClient, MODES, errorFromStatus, buildBody });
})();
