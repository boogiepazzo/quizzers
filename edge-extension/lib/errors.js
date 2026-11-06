/*
 * Typed errors with user-facing messages.
 *
 * Errors cross the message boundary between the service worker, the popup and
 * content scripts as plain `{ code, message }` objects (see `toPlain`).
 */
(() => {
  const QZ = (globalThis.QZ = globalThis.QZ || {});
  if (QZ.errors) return;

  const MESSAGES = Object.freeze({
    NO_API_KEY: 'No OpenRouter API key saved. Click the Quizzers toolbar icon and add your key.',
    INVALID_API_KEY: 'OpenRouter rejected the API key (401). Check the key in the Quizzers popup.',
    INSUFFICIENT_CREDITS: 'Your OpenRouter account is out of credits (402). Add credits or switch to a cheaper model.',
    MODERATION: 'The request was blocked by the model provider’s moderation filter (403).',
    MODEL_NOT_FOUND: 'The selected model is not available on OpenRouter. Pick another model in the popup.',
    RATE_LIMITED: 'OpenRouter rate-limited the request (429). Wait a few seconds and try again.',
    CONTEXT_TOO_LONG: 'The questions are too long for this model’s context window. Try the “viewport only” scan scope.',
    BAD_REQUEST: 'OpenRouter could not process the request (400).',
    PROVIDER_ERROR: 'The model provider returned an error. Try again or pick another model.',
    TIMEOUT: 'OpenRouter took too long to respond.',
    NETWORK: 'Could not reach OpenRouter. Check your internet connection.',
    TRUNCATED: 'The model’s answer was cut off before it finished. Try fewer questions (viewport scope) or another model.',
    BAD_RESPONSE: 'The model’s reply could not be parsed as the expected JSON.',
    REFUSED: 'The model declined to answer these questions.',
    VERIFICATION_PAGE:
      'This page is showing a CAPTCHA or bot-verification challenge. Quizzers never touches those — complete it yourself, then scan again.',
    NO_ACCESS:
      'Quizzers can’t run on this page. Edge blocks extensions on edge:// pages, the Microsoft Edge Add-ons store and some other sites.',
    PARSE_FAILED: 'Quizzers couldn’t parse this page’s layout. Try reloading the page, or use the “viewport only” scope.',
    NO_TAB: 'No active tab to scan.',
    ABORTED: 'The scan was cancelled.',
    CONTEXT_INVALIDATED: 'Quizzers was updated or reloaded. Refresh this page to reconnect.',
    UNKNOWN: 'Something went wrong.',
  });

  class QZError extends Error {
    /**
     * @param {keyof MESSAGES} code
     * @param {string} [message]   overrides the default message for `code`
     * @param {{status?: number, retryable?: boolean, degradable?: boolean, detail?: string}} [extra]
     */
    constructor(code, message, extra = {}) {
      super(message || MESSAGES[code] || MESSAGES.UNKNOWN);
      this.name = 'QZError';
      this.code = code;
      this.status = extra.status;
      this.retryable = Boolean(extra.retryable);
      // "degradable" = worth retrying with a simpler response_format mode.
      this.degradable = Boolean(extra.degradable);
      this.detail = extra.detail;
    }
  }

  /** Serializable form for chrome.runtime messaging. */
  function toPlain(err) {
    if (err instanceof QZError) {
      return { code: err.code, message: err.message, status: err.status, detail: err.detail };
    }
    if (err && err.name === 'AbortError') return { code: 'ABORTED', message: MESSAGES.ABORTED };
    const raw = String((err && err.message) || err || '');
    if (/extension context invalidated/i.test(raw)) {
      return { code: 'CONTEXT_INVALIDATED', message: MESSAGES.CONTEXT_INVALIDATED };
    }
    return { code: 'UNKNOWN', message: raw ? `${MESSAGES.UNKNOWN} (${raw})` : MESSAGES.UNKNOWN };
  }

  QZ.errors = Object.freeze({ QZError, MESSAGES, toPlain });
})();
