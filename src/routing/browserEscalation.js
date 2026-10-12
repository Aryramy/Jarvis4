/**
 * Pure local deterministic browser escalation policy for JARVIS4 (Brick 25).
 *
 * Evaluates whether a user request requires a real interactive browser or whether
 * existing static web capabilities (search, static page reading, grounded QA) are sufficient.
 *
 * Rules:
 * - Deterministic, pure local regex/string evaluation
 * - Zero network calls, zero remote LLM calls, zero language translation/detection
 * - Unicode-aware matching for English, Urdu, and Arabic
 * - False-positive guards for definitions and conceptual explanations
 * - Respects strict priority:
 *     1. Explicit browser/interactivity intent (request-intent)
 *     2. Structured browser-eligible static failure (static-outcome)
 *     3. Ordinary informational / static request (request-intent)
 *     4. Default static (request-intent)
 * - Read-only, side-effect free, stateless
 */

export const MAX_BROWSER_REQUEST_LENGTH = 2000;

export class BrowserEscalationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserEscalationError';
    this.code = code;
  }
}

export const REASON_CODES = Object.freeze({
  EXPLICIT_BROWSER_REQUEST: 'explicit-browser-request',
  INTERACTIVE_CLICK: 'interactive-click',
  INTERACTIVE_FORM_ENTRY: 'interactive-form-entry',
  INTERACTIVE_FORM_SUBMIT: 'interactive-form-submit',
  INTERACTIVE_AUTHENTICATION: 'interactive-authentication',
  INTERACTIVE_FILE_UPLOAD: 'interactive-file-upload',
  INTERACTIVE_FILE_DOWNLOAD: 'interactive-file-download',
  INTERACTIVE_CONTROL_SELECTION: 'interactive-control-selection',
  INTERACTIVE_PAGE_NAVIGATION: 'interactive-page-navigation',
  INTERACTIVE_SCROLL_OR_HOVER: 'interactive-scroll-or-hover',
  STATIC_NO_READABLE_CONTENT: 'static-no-readable-content',
  AUTHENTICATION_REQUIRED: 'authentication-required',
  INTERACTIVE_ACCESS_CANDIDATE: 'interactive-access-candidate',
  STATIC_CONTENT_SUFFICIENT: 'static-content-sufficient',
  STATIC_SEARCH_SUFFICIENT: 'static-search-sufficient',
  STATIC_PAGE_READ_SUFFICIENT: 'static-page-read-sufficient',
  UNSUPPORTED_STATIC_FAILURE: 'unsupported-static-failure'
});

export const REASON_DESCRIPTIONS = Object.freeze({
  'explicit-browser-request': 'The request explicitly asks to use or automate a web browser.',
  'interactive-click': 'The request requires clicking or activating an interactive webpage element.',
  'interactive-form-entry': 'The request requires filling or entering text into form inputs.',
  'interactive-form-submit': 'The request requires submitting a form or committing an interactive action.',
  'interactive-authentication': 'The request requires logging in, signing in, or authenticating on a website.',
  'interactive-file-upload': 'The request requires uploading or attaching a file to a webpage.',
  'interactive-file-download': 'The request requires interacting with a portal or site to download a file.',
  'interactive-control-selection': 'The request requires selecting or toggling interactive controls.',
  'interactive-page-navigation': 'The request requires interactive navigation or menu traversal on a website.',
  'interactive-scroll-or-hover': 'The request requires scrolling, hovering, or direct page interaction.',
  'static-no-readable-content': 'The static reader found no readable content (possible client-side rendering/SPA); browser interaction is required.',
  'authentication-required': 'The target resource requires authentication which necessitates interactive browser session access.',
  'interactive-access-candidate': 'Access to the resource was forbidden (HTTP 403); interactive browser or user interaction may be required.',
  'static-content-sufficient': 'The request can be handled by existing static web capabilities.',
  'static-search-sufficient': 'The request can be handled by existing search capabilities.',
  'static-page-read-sufficient': 'The request can be handled by static webpage reading.',
  'unsupported-static-failure': 'The static failure is not resolvable by browser escalation.'
});

// Non-escalating controlled static failures that must NEVER auto-escalate to browser
const NON_ESCALATING_STATIC_CODES = Object.freeze([
  'LOCAL_OR_PRIVATE_HOST_BLOCKED',
  'INVALID_URL',
  'UNSUPPORTED_PROTOCOL',
  'URL_CREDENTIALS_NOT_ALLOWED',
  'PORT_NOT_ALLOWED',
  'DNS_RESOLUTION_FAILED',
  'INSECURE_REDIRECT_DOWNGRADE',
  'PAGE_TOO_LARGE',
  'UNSUPPORTED_CONTENT_TYPE',
  'FETCH_TIMEOUT',
  'PAGE_READ_INTERNAL_ERROR',
  'FETCH_FAILED',
  'TOO_MANY_REDIRECTS'
]);

// Normalization helper
function normalizeRequestText(text) {
  if (typeof text !== 'string') return '';
  return text.trim().replace(/\s+/g, ' ');
}

// Definition and explanation guard patterns
const DEFINITION_OR_EXPLANATION_PATTERNS = Object.freeze([
  /^(?:what\s+(?:does|is\s+the)\s+.+?\s+mean[?.]?)$/i,
  /^(?:what\s+is\s+(?:an?\s+|the\s+)?(?!on\b|in\b|at\b|under\b)[\p{L}\p{N}\s-]+[?.]?)$/iu,
  /^(?:what\s+are\s+(?:the\s+)?[\p{L}\p{N}\s-]+[?.]?)$/iu,
  /^(?:meaning\s+of\s+.+[?.]?)$/i,
  /^(?:definition\s+of\s+.+[?.]?)$/i,
  /^(?:define\s+.+[?.]?)$/i,
  /^(?:explain\s+(?:how\s+.+\s+works?|[\p{L}\p{N}\s-]+)[?.]?)$/iu,
  /^(?:how\s+does\s+.+\s+work[?.]?)$/i,
  // Urdu explanation: "... کیا ہے؟" or "... کیا ہے"
  /^(?:[\p{L}\p{N}\s-]+\s+کیا\s+ہے[؟?.]?)$/u,
  // Arabic explanation: "ما هو ..." or "ما هي ..."
  /^(?:ما\s+(?:هو|هي)\s+[\p{L}\p{N}\s-]+[؟?.]?)$/u
]);

// Interactive Intent Rules defined in strict priority order
const INTERACTIVE_RULES = Object.freeze([
  {
    code: REASON_CODES.EXPLICIT_BROWSER_REQUEST,
    patterns: [
      /\b(?:use|using|open\s+in|launch|control)\s+(?:a\s+|the\s+)?(?:web\s+)?browser\b/i,
      /\b(?:in|using|with)\s+(?:the\s+)?browser\b/i,
      /\bbrowser\s+automation\b/i,
      /\b(?:use|using|open\s+in|launch)\s+(?:google\s+)?chrome\b/i,
      /\b(?:in|with)\s+chrome\b/i,
      /\b(?:use|using|open\s+in|launch)\s+edge\b/i,
      /\b(?:in|with)\s+edge\b/i,
      /\b(?:use|using|open\s+in|launch)\s+firefox\b/i,
      /\b(?:in|with)\s+firefox\b/i,
      /\bcontrol\s+browser\b/i,
      /براؤزر\s+استعمال\s+کر(?:یں|و|نا)/u,
      /کروم\s+استعمال\s+کر(?:یں|و|نا)/u,
      /براؤزر\s+میں\s+کھول(?:یں|و|نا)/u,
      /(?:استخدم|استخدام)\s+المتصفح/u,
      /افتح\s+في\s+المتصفح/u,
      /(?:استخدم|استخدام)\s+كروم/u,
      /التحكم\s+في\s+المتصفح/u
    ]
  },
  {
    code: REASON_CODES.INTERACTIVE_CLICK,
    patterns: [
      /\b(?:click|clicks|clicking)(?:\s+(?:on|the|this|that|into))?\b/i,
      /\b(?:press|presses|pressing)(?:\s+(?:on|the|this|that))?\b/i,
      /\b(?:tap|taps|tapping)(?:\s+(?:on|the|this|that))?\b/i,
      /\bopen\s+(?:the\s+)?button\b/i,
      /کلک\s+کر(?:یں|و|نا)/u,
      /بٹن\s+دبا(?:ئیں|ؤ|نا)/u,
      /(?:انقر|النقر|أنقر)(?:\s+على)?/u,
      /(?:اضغط|الضغط|أضغط)(?:\s+على)?/u
    ],
    excludePatterns: [
      /\bclick(?:-|\s+)through\s+rate\b/i
    ]
  },
  {
    code: REASON_CODES.INTERACTIVE_FORM_ENTRY,
    patterns: [
      /\bfill(?:\s+(?:in|out|up))?\s+(?:the\s+|this\s+|a\s+|an\s+)?(?:registration\s+|login\s+|signup\s+)?form\b/i,
      /\bfill\s+(?:this|the|a)\s+form\b/i,
      /\bfill\s+(?:in|out)\b/i,
      /\btype\s+(?:in|into)\b/i,
      /\benter\s+into\b/i,
      /\bcomplete\s+(?:the\s+|this\s+|a\s+)?form\b/i,
      /\bwrite\s+(?:in|into)\s+(?:the\s+|this\s+)?field\b/i,
      /فارم\s+بھر(?:یں|و|نا)/u,
      /فارم\s+پر\s+کر(?:یں|و|نا)/u,
      /فیلڈ\s+میں\s+لکھ(?:یں|و|نا)/u,
      /(?:املأ|ملء)\s+(?:هذا\s+|ال)?نموذج/u,
      /(?:اكتب|أدخل)\s+في\s+(?:حقل|الحقل)/u,
      /(?:أدخل|إدخال)\s+في/u
    ]
  },
  {
    code: REASON_CODES.INTERACTIVE_FORM_SUBMIT,
    patterns: [
      /\bsubmit(?:\s+(?:the\s+|this\s+|a\s+)?(?:registration\s+)?form)?\b/i,
      /\bsend\s+(?:the\s+|this\s+)?form\b/i,
      /\bsave\s+(?:the\s+|this\s+)?form\b/i,
      /\bpublish\b/i,
      /\bregister\b/i,
      /\bconfirm\s+(?:submission|action|order|the\s+form)?\b/i,
      /\bpress\s+continue\b/i,
      /\bclick\s+continue\b/i,
      /فارم\s+جمع\s+کر(?:یں|و|نا)/u,
      /رجسٹر\s+کر(?:یں|و|نا)/u,
      /تصدیق\s+کر(?:یں|و|نا)/u,
      /جاری\s+رکھ(?:یں|و|نا)/u,
      /(?:أرسل|إرسال)\s+النموذج/u,
      /(?:تأكيد|أكد)\s+النموذج/u,
      /(?:تسجيل|سجل)\s+في/u
    ]
  },
  {
    code: REASON_CODES.INTERACTIVE_AUTHENTICATION,
    patterns: [
      /\blog(?:ged|ging)?\s*in(?:\s+to)?\b/i,
      /\blog\s+into\b/i,
      /\bsign(?:ed|ing)?\s*in(?:\s+to)?\b/i,
      /\bsign\s+into\b/i,
      /\bauthenticate\b/i,
      /\blog(?:ged|ging)?\s*out\b/i,
      /\bsign(?:ed|ing)?\s*out\b/i,
      /لاگ\s+ان\s+کر(?:یں|و|نا)/u,
      /سائن\s+ان\s+کر(?:یں|و|نا)/u,
      /لاگ\s+آؤٹ\s+کر(?:یں|و|نا)/u,
      /سائن\s+آؤٹ\s+کر(?:یں|و|نا)/u,
      /(?:تسجيل|سجل)\s+الدخول/u,
      /(?:تسجيل|سجل)\s+الخروج/u,
      /مصادقة/u
    ]
  },
  {
    code: REASON_CODES.INTERACTIVE_FILE_UPLOAD,
    patterns: [
      /\bupload\s+(?:the\s+|this\s+|a\s+)?file\b/i,
      /\bupload\b/i,
      /\battach\s+(?:the\s+|this\s+|a\s+)?(?:file|document)\b/i,
      /\bchoose\s+file\b/i,
      /فائل\s+اپ\s*لوڈ\s+کر(?:یں|و|نا)/u,
      /دستاویز\s+منسلک\s+کر(?:یں|و|نا)/u,
      /فائل\s+منسلک\s+کر(?:یں|و|نا)/u,
      /(?:ارفع|رفع)\s+الملف/u,
      /(?:أرفق|إرفاق)\s+(?:الملف|مستند)/u
    ]
  },
  {
    code: REASON_CODES.INTERACTIVE_FILE_DOWNLOAD,
    patterns: [
      /\bdownload\s+.*?\s+from\s+(?:the\s+)?(?:portal|site|website|dashboard|account)\b/i,
      /\bdownload\s+from\s+(?:the\s+)?(?:portal|site|website)\b/i,
      /پورٹل\s+سے\s+ڈاؤن\s*لوڈ\s+کر(?:یں|و|نا)/u,
      /ویب\s*سائٹ\s+سے\s+ڈاؤن\s*لوڈ\s+کر(?:یں|و|نا)/u,
      /فائل\s+ڈاؤن\s*لوڈ\s+کر(?:یں|و|نا)/u,
      /(?:تحميل|تنزيل)\s+.*?\s+من\s+(?:البوابة|الموقع)/u,
      /(?:تحميل|تنزيل)\s+الملف/u
    ]
  },
  {
    code: REASON_CODES.INTERACTIVE_CONTROL_SELECTION,
    patterns: [
      /\bselect\s+.*?\s+from\s+(?:the\s+)?dropdown\b/i,
      /\bchoose\s+.*?\s+from\s+(?:the\s+)?dropdown\b/i,
      /\bselect\s+(?:from\s+)?(?:the\s+)?dropdown\b/i,
      /\bchoose\s+option\b/i,
      /\bselect\s+option\b/i,
      /\bcheck\s+(?:the\s+)?checkbox\b/i,
      /\b(?:uncheck|tick)\s+(?:the\s+)?checkbox\b/i,
      /\bcheckbox\b/i,
      /\bradio\s+button\b/i,
      /\btoggle\b/i,
      /ڈراپ\s*ڈاؤن\s+سے\s+منتخب\s+کر(?:یں|و|نا)/u,
      /چیک\s*باکس/u,
      /ریڈیو\s+بٹن/u,
      /منتخب\s+کر(?:یں|و|نا)/u,
      /(?:اختر|حدد)\s+.*?\s+من\s+القائمة\s+المنسدلة/u,
      /خانة\s+الاختيار/u,
      /زر\s+الاختيار/u,
      /(?:اختر|حدد)\s+الخيار/u
    ]
  },
  {
    code: REASON_CODES.INTERACTIVE_PAGE_NAVIGATION,
    patterns: [
      /\bnavigate\s+(?:through|the|to)\b/i,
      /\bgo\s+through\s+(?:the\s+)?steps\b/i,
      /\bopen\s+(?:the\s+)?menu\b/i,
      /\bnext\s+page\b/i,
      /\bprevious\s+page\b/i,
      /\bswitch\s+tabs?\b/i,
      /مینو\s+کھول(?:یں|و|نا)/u,
      /اگلے\s+صفحے\s+پر\s+جائیں/u,
      /نیویگیٹ\s+کر(?:یں|و|نا)/u,
      /(?:افتح|فتح)\s+القائمة/u,
      /الصفحة\s+التالية/u,
      /الصفحة\s+السابقة/u,
      /تصفح\s+الموقع/u
    ]
  },
  {
    code: REASON_CODES.INTERACTIVE_SCROLL_OR_HOVER,
    patterns: [
      /\bscroll(?:\s+(?:down|up|to|left|right))?\b/i,
      /\bhover(?:\s+over)?\b/i,
      /\bdrag\s+and\s+drop\b/i,
      /\bdrag\b/i,
      /سکرول\s+کر(?:یں|و|نا)/u,
      /نیچے\s+سکرول/u,
      /اوپر\s+سکرول/u,
      /(?:مرر|التمرير)(?:\s+(?:لأسفل|لأعلى))?/u,
      /تحويم/u,
      /سحب\s+وإفلات/u
    ]
  }
]);

// Search and page reading indicators for informational static classification
const SEARCH_INTENT_PATTERN = /\b(?:search(?:\s+the\s+web)?|find\s+(?:the\s+)?latest|look\s+up|latest\s+news|news\s+about)\b/i;
const URDU_SEARCH_PATTERN = /تلاش\s+کر(?:یں|و|نا)/u;
const ARABIC_SEARCH_PATTERN = /ابحث\s+عن/u;

const STATIC_PAGE_READ_PATTERN = /\b(?:summarize|read|parse)\b|https?:\/\//i;

/**
 * Evaluates structured static outcome to determine if browser escalation is warranted.
 * @param {Object} [outcome]
 * @returns {Object|null}
 */
export function evaluateStaticOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return null;

  const errorCode = outcome.errorCode || outcome.code || null;
  const status = outcome.status ?? outcome.statusCode ?? outcome.httpStatus ?? null;

  // 1. NO_READABLE_CONTENT (SPA / client-rendered pages)
  if (errorCode === 'NO_READABLE_CONTENT') {
    return {
      browserRequired: true,
      route: 'browser',
      reasonCode: REASON_CODES.STATIC_NO_READABLE_CONTENT,
      reason: REASON_DESCRIPTIONS[REASON_CODES.STATIC_NO_READABLE_CONTENT],
      source: 'static-outcome',
      matchedSignals: ['NO_READABLE_CONTENT']
    };
  }

  // 2. HTTP 401 Unauthorized
  if (status === 401 || errorCode === 'HTTP_401' || errorCode === 'AUTHENTICATION_REQUIRED') {
    return {
      browserRequired: true,
      route: 'browser',
      reasonCode: REASON_CODES.AUTHENTICATION_REQUIRED,
      reason: REASON_DESCRIPTIONS[REASON_CODES.AUTHENTICATION_REQUIRED],
      source: 'static-outcome',
      matchedSignals: ['HTTP_401']
    };
  }

  // 3. HTTP 403 Forbidden (conservative neutral reason)
  if (status === 403 || errorCode === 'HTTP_403') {
    return {
      browserRequired: true,
      route: 'browser',
      reasonCode: REASON_CODES.INTERACTIVE_ACCESS_CANDIDATE,
      reason: REASON_DESCRIPTIONS[REASON_CODES.INTERACTIVE_ACCESS_CANDIDATE],
      source: 'static-outcome',
      matchedSignals: ['HTTP_403']
    };
  }

  // 4. Non-escalating controlled static errors
  if (errorCode && NON_ESCALATING_STATIC_CODES.includes(errorCode)) {
    return {
      browserRequired: false,
      route: 'static',
      reasonCode: REASON_CODES.UNSUPPORTED_STATIC_FAILURE,
      reason: REASON_DESCRIPTIONS[REASON_CODES.UNSUPPORTED_STATIC_FAILURE],
      source: 'static-outcome',
      matchedSignals: [errorCode]
    };
  }

  return null;
}

/**
 * Main deterministic browser escalation decision engine for Brick 25.
 *
 * @param {Object} params
 * @param {string} params.request - The user instruction or question
 * @param {Object} [params.staticOutcome] - Optional outcome from static stack
 * @returns {{
 *   browserRequired: boolean,
 *   route: 'browser' | 'static',
 *   reasonCode: string,
 *   reason: string,
 *   source: 'request-intent' | 'static-outcome',
 *   matchedSignals: string[]
 * }}
 */
export function decideBrowserEscalation({ request, staticOutcome } = {}) {
  // Validate request
  if (request === undefined || request === null) {
    throw new BrowserEscalationError('INVALID_REQUEST', 'Request must be a non-empty string');
  }

  if (typeof request !== 'string') {
    throw new BrowserEscalationError('INVALID_REQUEST', 'Request must be a non-empty string');
  }

  const normalized = normalizeRequestText(request);
  if (normalized.length === 0) {
    throw new BrowserEscalationError('INVALID_REQUEST', 'Request cannot be empty or whitespace-only');
  }

  if (request.length > MAX_BROWSER_REQUEST_LENGTH) {
    throw new BrowserEscalationError('REQUEST_TOO_LONG', `Request exceeds maximum allowed length of ${MAX_BROWSER_REQUEST_LENGTH} characters`);
  }

  // Check definition / explanation guard (e.g. "What is a login page?", "What is browser automation?")
  const isDefinitionOrExplanation = DEFINITION_OR_EXPLANATION_PATTERNS.some((pattern) => pattern.test(normalized));

  // PRIORITY 1: Explicit interactive/browser intent in request
  const matchedInteractiveCodes = [];

  if (!isDefinitionOrExplanation) {
    for (const rule of INTERACTIVE_RULES) {
      if (rule.excludePatterns && rule.excludePatterns.some((ep) => ep.test(normalized))) {
        continue;
      }
      const matched = rule.patterns.some((pattern) => pattern.test(normalized));
      if (matched) {
        matchedInteractiveCodes.push(rule.code);
      }
    }
  } else {
    // If it's a definition/explanation query, only explicit browser requests with imperative phrasing
    // like "use Chrome to..." can override.
    const explicitChromeRule = /\b(?:use|using|open\s+in)\s+(?:google\s+)?chrome\b/i;
    if (explicitChromeRule.test(normalized)) {
      matchedInteractiveCodes.push(REASON_CODES.EXPLICIT_BROWSER_REQUEST);
    }
  }

  if (matchedInteractiveCodes.length > 0) {
    // Return primary code according to deterministic priority
    const primaryCode = matchedInteractiveCodes[0];
    return {
      browserRequired: true,
      route: 'browser',
      reasonCode: primaryCode,
      reason: REASON_DESCRIPTIONS[primaryCode] || 'The request requires browser interaction.',
      source: 'request-intent',
      matchedSignals: matchedInteractiveCodes
    };
  }

  // PRIORITY 2: Structured browser-eligible static failure
  if (staticOutcome && typeof staticOutcome === 'object') {
    const staticDecision = evaluateStaticOutcome(staticOutcome);
    if (staticDecision) {
      return staticDecision;
    }
  }

  // PRIORITY 3: Informational / static request classification
  let reasonCode = REASON_CODES.STATIC_CONTENT_SUFFICIENT;

  if (STATIC_PAGE_READ_PATTERN.test(normalized)) {
    reasonCode = REASON_CODES.STATIC_PAGE_READ_SUFFICIENT;
  } else if (SEARCH_INTENT_PATTERN.test(normalized) || URDU_SEARCH_PATTERN.test(normalized) || ARABIC_SEARCH_PATTERN.test(normalized)) {
    reasonCode = REASON_CODES.STATIC_SEARCH_SUFFICIENT;
  }

  return {
    browserRequired: false,
    route: 'static',
    reasonCode,
    reason: REASON_DESCRIPTIONS[reasonCode],
    source: 'request-intent',
    matchedSignals: []
  };
}

export default {
  MAX_BROWSER_REQUEST_LENGTH,
  BrowserEscalationError,
  REASON_CODES,
  REASON_DESCRIPTIONS,
  evaluateStaticOutcome,
  decideBrowserEscalation
};
