/**
 * Shared deterministic freshness signal and guard definitions for JARVIS4 (Brick 20).
 *
 * Provides a single shared source of truth for:
 * 1. Automatic search decision routing (Brick 20)
 * 2. Search freshness-sensitive detection (Brick 19 search layer)
 *
 * Rules:
 * - Deterministic, pure local regex/string evaluation
 * - Zero network calls, zero remote LLM calls, zero language translation/detection
 * - Unicode-aware matching for Arabic & Urdu scripts (\p{L}, \p{N})
 * - Guard rails against false positives on definitions and conceptual explanations
 */

/**
 * Normalizes user text for classification without mutating original query.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text.trim().replace(/\s+/g, ' ');
}

// 1. Definition guards: "What does X mean?", "Define X", "Meaning of X", "Definition of X"
export const DEFINITION_PATTERN = /^(?:what\s+(?:does|is\s+the)\s+(?:["'“‘]?[\p{L}\p{N}-]+["'”’]?\s+mean|meaning\s+of\s+["'“‘]?[\p{L}\p{N}-]+["'”’]?)|meaning\s+of\s+["'“‘]?[\p{L}\p{N}-]+["'”’]?|define\s+["'“‘]?[\p{L}\p{N}-]+["'”’]?|definition\s+of\s+["'“‘]?[\p{L}\p{N}-]+["'”’]?)\s*[.?!]?$/iu;

// 2. Explanation / mechanism guards: explanations of concepts rather than live facts
export const EXPLANATION_HOW_WORKS_PATTERN = /\b(?:explain\s+how\b.*?\bworks?|how\s+does\b.*?\bwork)\b/i;
export const EXPLANATION_DIRECT_PATTERN = /\bexplain\s+(?:weather\s+forecasting|software\s+release\s+management)\b/i;
export const EXPLANATION_NEWS_ARTICLE_PATTERN = /\bwhat\s+is\s+(?:a\s+)?news\s+article\b/i;
export const EXPLANATION_ELECTRIC_CURRENT_PATTERN = /\belectric\s+current\b/i;
export const EXPLANATION_HOW_UPDATE_PATTERN = /\bhow\s+do\s+i\s+update\b/i;

export const EXPLANATION_PATTERNS = Object.freeze([
  EXPLANATION_HOW_WORKS_PATTERN,
  EXPLANATION_DIRECT_PATTERN,
  EXPLANATION_NEWS_ARTICLE_PATTERN,
  EXPLANATION_ELECTRIC_CURRENT_PATTERN,
  EXPLANATION_HOW_UPDATE_PATTERN
]);

// 3. Time-Sensitive Current Entity & Rate Patterns
export const CURRENT_ENTITY_PATTERN = /\bcurrent\s+(?:ceo|president|prime\s+minister|leader|status|score|standings|weather|forecast|version|release)\b/i;
export const CURRENT_PRICE_OR_RATE_PATTERN = /\bcurrent\s+(?:[A-Za-z0-9\s/$-]{1,25}\s+)?(?:rate|price)\b/i;

// 4. Authorized English Freshness Signals
export const ENGLISH_FRESHNESS_SIGNALS = Object.freeze([
  'latest',
  'newest',
  'recent',
  'recently',
  'today',
  'tonight',
  'right now',
  'currently',
  'this week',
  'this month',
  'this year',
  'as of today',
  'as of now',
  'news'
]);

export const ENGLISH_FRESHNESS_RULES = Object.freeze([
  { signal: 'latest', rule: 'freshness:latest', regex: /\blatest\b/i },
  { signal: 'newest', rule: 'freshness:newest', regex: /\bnewest\b/i },
  { signal: 'recently', rule: 'freshness:recently', regex: /\brecently\b/i },
  { signal: 'recent', rule: 'freshness:recent', regex: /\brecent\b/i },
  { signal: 'breaking', rule: 'freshness:breaking', regex: /\bbreaking\b/i },
  { signal: 'as of today', rule: 'freshness:as-of-today', regex: /\bas\s+of\s+today\b/i },
  { signal: 'today', rule: 'freshness:today', regex: /\btoday\b/i },
  { signal: 'tonight', rule: 'freshness:tonight', regex: /\btonight\b/i },
  { signal: 'right now', rule: 'freshness:right-now', regex: /\bright\s+now\b/i },
  { signal: 'currently', rule: 'freshness:currently', regex: /\bcurrently\b/i },
  { signal: 'this week', rule: 'freshness:this-week', regex: /\bthis\s+week\b/i },
  { signal: 'this month', rule: 'freshness:this-month', regex: /\bthis\s+month\b/i },
  { signal: 'this year', rule: 'freshness:this-year', regex: /\bthis\s+year\b/i },
  { signal: 'as of now', rule: 'freshness:as-of-now', regex: /\bas\s+of\s+now\b/i },
  { signal: 'news', rule: 'freshness:news', regex: /\bnews\b/i },
  { signal: "what's new", rule: 'freshness:whats-new', regex: /\bwhat(?:'s|\s+is)\s+new\b/i },
  { signal: 'recently announced', rule: 'freshness:recently-announced', regex: /\brecently\s+announced\b/i }
]);

// 5. Authorized Urdu Freshness Signals
export const URDU_FRESHNESS_SIGNALS = Object.freeze([
  'تازہ ترین',
  'حالیہ',
  'آج',
  'ابھی',
  'اس ہفتے',
  'اس مہینے',
  'اس سال',
  'خبریں'
]);

// 6. Authorized Arabic Freshness Signals
export const ARABIC_FRESHNESS_SIGNALS = Object.freeze([
  'أحدث',
  'الأحدث',
  'اليوم',
  'الآن',
  'حاليًا',
  'هذا الأسبوع',
  'هذا الشهر',
  'هذا العام',
  'أخبار',
  'الأخبار'
]);

/**
 * Compiles a Unicode-safe regular expression bounded by non-letter / non-number boundaries.
 * @param {string} phrase
 * @returns {RegExp}
 */
export function compileUnicodePhraseRegex(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=[^\\p{L}\\p{N}]|$)`, 'u');
}

export const COMPILED_URDU_SIGNALS = Object.freeze(
  URDU_FRESHNESS_SIGNALS.map((phrase) => Object.freeze({
    phrase,
    regex: compileUnicodePhraseRegex(phrase)
  }))
);

export const COMPILED_ARABIC_SIGNALS = Object.freeze(
  ARABIC_FRESHNESS_SIGNALS.map((phrase) => Object.freeze({
    phrase,
    regex: compileUnicodePhraseRegex(phrase)
  }))
);

/**
 * Checks Unicode boundary matches for non-ASCII phrases or compiled signal descriptors.
 * @param {Array<string | { phrase: string, regex: RegExp }>} signals
 * @param {string} text
 * @returns {string|null} The matched phrase string or null
 */
export function matchUnicodePhrase(signals, text) {
  if (typeof text !== 'string' || !Array.isArray(signals)) return null;
  for (const item of signals) {
    if (typeof item === 'string') {
      const regex = compileUnicodePhraseRegex(item);
      if (regex.test(text)) return item;
    } else if (item && item.regex) {
      if (item.regex.test(text)) return item.phrase;
    }
  }
  return null;
}

/**
 * Detects whether a query is freshness-sensitive using the shared deterministic definitions.
 *
 * Reused by:
 * - Brick-19 Search Provider (`openRouterSearch.js` and `server.js`)
 * - Brick-20 Search Decision Router (`searchDecision.js`)
 *
 * @param {string} query
 * @returns {boolean}
 */
export function isFreshnessSensitiveQuery(query) {
  if (typeof query !== 'string') return false;
  const normalized = normalizeText(query);
  if (!normalized) return false;

  // 1. Definition guards
  if (DEFINITION_PATTERN.test(normalized)) {
    return false;
  }

  // 2. Explanation / mechanism guards
  for (const pattern of EXPLANATION_PATTERNS) {
    if (pattern.test(normalized)) {
      return false;
    }
  }

  // 3. Multilingual Freshness Signals (Urdu & Arabic)
  if (matchUnicodePhrase(COMPILED_URDU_SIGNALS, normalized)) {
    return true;
  }
  if (matchUnicodePhrase(COMPILED_ARABIC_SIGNALS, normalized)) {
    return true;
  }

  // 4. Current entity or rate/price patterns
  if (CURRENT_ENTITY_PATTERN.test(normalized) || CURRENT_PRICE_OR_RATE_PATTERN.test(normalized)) {
    return true;
  }

  // 5. English freshness rules
  for (const { regex } of ENGLISH_FRESHNESS_RULES) {
    if (regex.test(normalized)) {
      return true;
    }
  }

  return false;
}
