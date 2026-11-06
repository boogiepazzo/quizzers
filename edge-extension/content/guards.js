/*
 * Anti-bot & verification guardrails, plus the visibility tests they rely on.
 *
 *  - CAPTCHA frames and widgets (reCAPTCHA, hCaptcha, Cloudflare Turnstile and
 *    interstitials, Arkose, DataDome, PerimeterX, …) are detected and never
 *    parsed, sent to the API or interacted with.
 *  - Honeypots — hidden or off-screen elements, bot-trap inputs, "leave this
 *    blank" prompts — are excluded, so only what a person can actually see
 *    reaches the model.
 */
(() => {
  const QZ = (globalThis.QZ = globalThis.QZ || {});
  if (QZ.guards) return;

  /* ---------- CAPTCHA / challenge detection ---------- */

  const CAPTCHA_HOST_RE =
    /(^|\.)(recaptcha\.net|hcaptcha\.com|arkoselabs\.com|funcaptcha\.com|geetest\.com|captcha-delivery\.com|perimeterx\.net|px-cloud\.net|mtcaptcha\.com|friendlycaptcha\.(com|eu)|captcha\.com)$/i;

  function isCaptchaUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return false;
    }
    const host = url.hostname;
    if (CAPTCHA_HOST_RE.test(host)) return true;
    if (host === 'challenges.cloudflare.com') return true;
    if (/(^|\.)(google|gstatic)\.com$/i.test(host) && /\/recaptcha\//i.test(url.pathname)) return true;
    return /\/cdn-cgi\/challenge-platform\/h\//i.test(url.pathname);
  }

  // Widgets that may be embedded in an otherwise normal page.
  const CAPTCHA_WIDGET_SELECTOR = [
    '.g-recaptcha',
    '.grecaptcha-badge',
    '#recaptcha',
    '.h-captcha',
    '.cf-turnstile',
    '[data-sitekey]',
    '[data-hcaptcha-widget-id]',
    '#px-captcha',
    '.frc-captcha',
    '.mtcaptcha',
    'iframe[src*="recaptcha" i]',
    'iframe[src*="hcaptcha" i]',
    'iframe[src*="challenges.cloudflare.com" i]',
    'iframe[src*="arkoselabs" i]',
    'iframe[src*="captcha" i]',
    'textarea[name="g-recaptcha-response"]',
    'textarea[name="h-captcha-response"]',
    'input[name="cf-turnstile-response"]',
  ].join(',');

  // Looser match used only for ancestors of a candidate question.
  const CAPTCHA_ANCESTOR_SELECTOR = `${CAPTCHA_WIDGET_SELECTOR},[id*="captcha" i],[class*="captcha" i],[name*="captcha" i]`;

  // Full-page interstitials (the whole document is a challenge).
  const CHALLENGE_PAGE_SELECTOR = [
    '#challenge-form',
    '#challenge-running',
    '#challenge-stage',
    '#challenge-body-text',
    '#cf-challenge-running',
    '#cf-please-wait',
    '.cf-browser-verification',
    '#px-captcha',
    'iframe[src*="captcha-delivery.com" i]',
  ].join(',');

  const CHALLENGE_TITLE_RE =
    /just a moment|attention required|checking your browser|verify(ing)? (that )?you are (a )?human|are you a robot|security check|access denied|human verification/i;

  /**
   * Returns a reason string when the *current document* is a CAPTCHA frame or
   * a full-page bot challenge; null for normal pages.
   */
  function detectBlockingChallenge(doc = document) {
    if (isCaptchaUrl(doc.location?.href || '')) return 'captcha-frame';
    const title = doc.title || '';
    if (doc.querySelector(CHALLENGE_PAGE_SELECTOR)) return 'challenge-page';
    if (CHALLENGE_TITLE_RE.test(title) && doc.querySelector('script[src*="/cdn-cgi/challenge-platform/" i], ' + CAPTCHA_WIDGET_SELECTOR)) {
      return 'challenge-page';
    }
    // A page that is little more than a visible CAPTCHA widget.
    const widget = doc.querySelector(CAPTCHA_WIDGET_SELECTOR);
    if (widget && isRendered(widget)) {
      const textLength = (doc.body?.innerText || '').trim().length;
      if (textLength < 400) return 'captcha-wall';
    }
    return null;
  }

  /* ---------- text heuristics ---------- */

  // Phrases that only ever appear in human-verification prompts.
  const STRONG_VERIFICATION_RE = new RegExp(
    [
      "\\bi'?m not a robot\\b",
      '\\bi am not a robot\\b',
      '\\bare you (a )?(human|robot|bot)\\b',
      "\\bverify (that )?you(?:'re| are) (a )?(human|real person|not a (ro)?bot)\\b",
      "\\bprove (that )?you(?:'re| are) (a )?human\\b",
      '\\bhuman verification\\b',
      '\\bselect all (the )?(images|squares|pictures|tiles)\\b',
      '\\bclick (on )?(each|all|every) (image|picture|tile)s?\\b',
      '\\bpress (and|&) hold\\b',
      '\\bchecking (if the site connection is secure|your browser)\\b',
    ].join('|'),
    'i'
  );

  // Words that also occur in genuine course questions ("What is a CAPTCHA?"),
  // so they only count when the text doesn't read like a question.
  const WEAK_VERIFICATION_RE =
    /\b((re|h)?captcha|turnstile|security check|anti-?spam|spam (check|protection|prevention)|bot (check|detection|verification|protection))\b/i;

  const HONEYPOT_TEXT_RE = new RegExp(
    [
      '\\bleave (this|it|the) (field |box |checkbox )?(blank|empty|unchecked|unticked)\\b',
      "\\b(do not|don'?t) (fill|check|tick|select|answer|change|touch) (this|in|anything)\\b",
      '\\bif you are (a )?human\\b',
      '\\bhumans? (should|must) (not|ignore|leave)\\b',
      '\\b(for|only) (spam ?)?(bots|robots)( only)?\\b',
      '\\bbots? only\\b',
    ].join('|'),
    'i'
  );

  // Attribute names commonly used for honeypot / bot-trap fields.
  const HONEYPOT_ATTR_RE =
    /(honey|hpot|(^|[-_\s])hp([-_\s]|$)|bot[-_]?trap|spam[-_]?trap|(^|[-_\s])gotcha([-_\s]|$)|leave[-_]?(this[-_]?)?(blank|empty)|ak_hp|(^|[-_\s])nobots?([-_\s]|$)|(^|[-_\s])b_[0-9a-f]{8,}_[0-9a-f]{6,})/i;

  /**
   * Classifies a candidate question by its visible text.
   * @returns {'honeypot'|'verification'|null}
   */
  function classifyText(stem, optionTexts = []) {
    const all = [stem, ...optionTexts].join('\n');
    if (HONEYPOT_TEXT_RE.test(all)) return 'honeypot';
    if (STRONG_VERIFICATION_RE.test(all)) return 'verification';
    if (WEAK_VERIFICATION_RE.test(all) && !/\?/.test(stem || '')) return 'verification';
    return null;
  }

  function attrString(el) {
    return [el.getAttribute('name'), el.id, el.getAttribute('class')].filter(Boolean).join(' ');
  }

  /** Bot-trap inputs: trap names, or the classic aria-hidden + tabindex=-1 combo. */
  function looksLikeHoneypotInput(input) {
    if (!input || input.nodeType !== 1) return false;
    if (HONEYPOT_ATTR_RE.test(attrString(input))) return true;
    if (input.getAttribute('tabindex') === '-1' && input.closest('[aria-hidden="true"]')) return true;
    let el = input.parentElement;
    for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
      if (HONEYPOT_ATTR_RE.test(attrString(el))) return true;
    }
    return false;
  }

  /** True when `el` sits inside (or wraps) a CAPTCHA widget. */
  function isCaptchaRelated(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest(CAPTCHA_ANCESTOR_SELECTOR)) return true;
    return Boolean(el.querySelector(CAPTCHA_WIDGET_SELECTOR));
  }

  /* ---------- regions that never contain quiz content ---------- */

  const EXCLUDED_REGION_SELECTOR = [
    'nav',
    '[role="navigation"]',
    '[role="search"]',
    '[role="menu"]',
    '[role="menubar"]',
    '[role="toolbar"]',
    '[role="tablist"]',
    'footer',
    '[role="contentinfo"]',
    '#onetrust-consent-sdk',
    '#CybotCookiebotDialog',
    '[id*="cookie" i]',
    '[class*="cookie" i]',
    '[id*="consent" i]',
    '[class*="consent" i]',
    'quizzers-ui',
  ].join(',');

  function isExcludedRegion(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest(EXCLUDED_REGION_SELECTOR)) return true;
    // Login / sign-up forms ("Remember me", "Accept terms" checkboxes).
    const form = el.closest('form');
    return Boolean(form && form.querySelector('input[type="password" i]'));
  }

  /* ---------- visibility ---------- */

  const SR_CLIP_RE = /^rect\(\s*(0|1)px,?\s*(0|1)px,?\s*(0|1)px,?\s*(0|1)px\s*\)$/;
  const CLIP_PATH_RE = /^(inset\(\s*(50|100)%|circle\(\s*0|polygon\(\s*0px 0px,\s*0px 0px)/;

  function isClippedAway(style) {
    const positioned = style.position === 'absolute' || style.position === 'fixed';
    if (positioned && SR_CLIP_RE.test(style.clip || '')) return true;
    return CLIP_PATH_RE.test(style.clipPath || '');
  }

  function documentSize() {
    const root = document.documentElement;
    return {
      width: Math.max(root.scrollWidth, window.innerWidth),
      height: Math.max(root.scrollHeight, window.innerHeight),
    };
  }

  /** Entirely outside the scrollable document (e.g. left:-9999px). */
  function isOffscreen(rect) {
    const { width, height } = documentSize();
    const left = rect.left + window.scrollX;
    const top = rect.top + window.scrollY;
    return left + rect.width <= 0 || top + rect.height <= 0 || left >= width + 50 || top >= height + 50;
  }

  function isTinyBox(el, style) {
    if (style.display === 'inline' || style.display === 'contents') return false;
    const overflowHidden = /(hidden|clip)/.test(style.overflow + style.overflowX + style.overflowY);
    return overflowHidden && el.offsetWidth <= 1 && el.offsetHeight <= 1;
  }

  /**
   * Whether a person can see `el`: rendered, non-trivial size, inside the
   * document, not clipped away and not (nearly) transparent — checked up the
   * ancestor chain. Used for option rows and question containers.
   */
  function isRendered(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    if (
      typeof el.checkVisibility === 'function' &&
      !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })
    ) {
      return false;
    }
    const style = getComputedStyle(el);
    if (style.display === 'contents') return Array.from(el.children).some(isRendered);
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (isOffscreen(rect)) return false;

    let opacity = 1;
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 60; depth++, node = node.parentElement) {
      const s = node === el ? style : getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
      opacity *= parseFloat(s.opacity);
      if (!(opacity >= 0.05)) return false;
      if (isClippedAway(s)) return false;
      if (node !== el && isTinyBox(node, s)) return false;
    }
    return true;
  }

  /** For the text walker: hides this element's whole subtree? */
  function isSubtreeHidden(el) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
    if (style.contentVisibility === 'hidden') return true;
    if (parseFloat(style.opacity) < 0.05) return true;
    if (isClippedAway(style)) return true;
    if (isTinyBox(el, style)) return true;
    if (style.position === 'absolute' || style.position === 'fixed') {
      const rect = el.getBoundingClientRect();
      if (isOffscreen(rect)) return true;
    }
    return false;
  }

  /* text colour vs. background */

  let bgCache = new WeakMap();

  function parseColor(value) {
    const m = String(value || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i);
    if (!m) return null;
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (!Number.isFinite(a)) a = 1;
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }

  /** First opaque background colour up the tree; null if an image/gradient intervenes. */
  function effectiveBackground(el) {
    if (bgCache.has(el)) return bgCache.get(el);
    let result = { r: 255, g: 255, b: 255, a: 1 };
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.backgroundImage && s.backgroundImage !== 'none') {
        result = null;
        break;
      }
      const c = parseColor(s.backgroundColor);
      if (c && c.a >= 0.9) {
        result = c;
        break;
      }
    }
    bgCache.set(el, result);
    return result;
  }

  /** For the text walker: is this element's own text invisible (colour/size tricks)? */
  function isOwnTextHidden(el) {
    const style = getComputedStyle(el);
    if (parseFloat(style.fontSize) < 3) return true;
    if (parseFloat(style.textIndent) < -999) return true;
    const color = parseColor(style.color);
    if (!color) return false;
    if (color.a < 0.05) {
      // Gradient text uses a transparent fill with background-clip:text.
      return !/text/.test(style.backgroundClip || style.webkitBackgroundClip || '');
    }
    const bg = effectiveBackground(el);
    if (!bg || color.a < 0.9) return false;
    const distance = Math.abs(color.r - bg.r) + Math.abs(color.g - bg.g) + Math.abs(color.b - bg.b);
    return distance < 18;
  }

  function intersectsViewport(rect) {
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function resetCaches() {
    bgCache = new WeakMap();
  }

  QZ.guards = Object.freeze({
    isCaptchaUrl,
    detectBlockingChallenge,
    isCaptchaRelated,
    classifyText,
    looksLikeHoneypotInput,
    isExcludedRegion,
    isRendered,
    isSubtreeHidden,
    isOwnTextHidden,
    intersectsViewport,
    resetCaches,
    CAPTCHA_WIDGET_SELECTOR,
  });
})();
