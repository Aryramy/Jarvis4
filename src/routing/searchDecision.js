/**
 * Pure local deterministic search decision module for JARVIS4 (Brick 20).
 *
 * Evaluates user queries using deterministic pattern matching and guard rails
 * to decide whether live web search or normal AI should handle the request.
 *
 * Rules:
 * - Must NOT perform network calls
 * - Must NOT invoke LLMs, OpenRouter, or remote classifiers
 * - Must NOT mutate global state or input strings
 * - Must NOT read API keys or storage
 * - Fast, explainable, testable offline, zero-cost
 */

export { normalizeText } from './freshnessSignals.js';
import {
  normalizeText,
  DEFINITION_PATTERN,
  EXPLANATION_HOW_WORKS_PATTERN,
  EXPLANATION_DIRECT_PATTERN,
  EXPLANATION_NEWS_ARTICLE_PATTERN,
  EXPLANATION_ELECTRIC_CURRENT_PATTERN,
  EXPLANATION_HOW_UPDATE_PATTERN,
  CURRENT_ENTITY_PATTERN,
  CURRENT_PRICE_OR_RATE_PATTERN,
  ENGLISH_FRESHNESS_RULES,
  COMPILED_URDU_SIGNALS,
  COMPILED_ARABIC_SIGNALS,
  matchUnicodePhrase
} from './freshnessSignals.js';

// Live-Data Patterns (Weather, Financial/Crypto, Sports, Service status)
const WEATHER_PATTERNS = [
  /\bweather\s+(?:in|for)\s+[\p{L}\s-]+/iu,
  /\bforecast\s+(?:in|for)\s+[\p{L}\s-]+/iu,
  /\bwhat(?:'s|\s+is)\s+the\s+weather\b/i
];
const FINANCIAL_PATTERNS = [
  /\bexchange\s+rates?\b/i,
  /\b(?:stock|share)\s+price\b/i,
  /\b(?:crypto|bitcoin|btc)\s+price\b/i
];
const SPORTS_PATTERNS = [
  /\bscore\s+of\s+[\p{L}\p{N}\s-]+/iu,
  /\bscores\s+for\s+[\p{L}\p{N}\s-]+/iu,
  /\bstandings\s+for\s+[\p{L}\p{N}\s-]+/iu
];
const SERVICE_DOWN_PATTERN = /\bis\s+[\w.-]+\s+down\b/i;

/**
 * Evaluates whether a given query should route to 'search' or 'ai'.
 *
 * @param {string} text - Raw user input
 * @returns {{
 *   route: 'ai' | 'search',
 *   reason: string,
 *   matchedRule: string | null
 * }}
 */
export function decideSearchRoute(text) {
  if (typeof text !== 'string') {
    return {
      route: 'ai',
      reason: 'default:invalid-input',
      matchedRule: null
    };
  }

  const normalized = normalizeText(text);
  if (!normalized) {
    return {
      route: 'ai',
      reason: 'default:empty-input',
      matchedRule: null
    };
  }

  // 1. Definition guards (lexical inquiries about words/concepts)
  if (DEFINITION_PATTERN.test(normalized)) {
    return {
      route: 'ai',
      reason: 'guard:definition',
      matchedRule: 'guard:definition'
    };
  }

  // 2. Explanation / mechanism guards
  if (
    EXPLANATION_HOW_WORKS_PATTERN.test(normalized) ||
    EXPLANATION_DIRECT_PATTERN.test(normalized) ||
    EXPLANATION_NEWS_ARTICLE_PATTERN.test(normalized) ||
    EXPLANATION_ELECTRIC_CURRENT_PATTERN.test(normalized) ||
    EXPLANATION_HOW_UPDATE_PATTERN.test(normalized)
  ) {
    return {
      route: 'ai',
      reason: 'guard:explanation',
      matchedRule: 'guard:explanation'
    };
  }

  // 3. Multilingual Freshness Signals (Urdu & Arabic)
  const urduMatch = matchUnicodePhrase(COMPILED_URDU_SIGNALS, normalized);
  if (urduMatch) {
    return {
      route: 'search',
      reason: `multilingual:urdu:${urduMatch}`,
      matchedRule: `multilingual:urdu:${urduMatch}`
    };
  }

  const arabicMatch = matchUnicodePhrase(COMPILED_ARABIC_SIGNALS, normalized);
  if (arabicMatch) {
    return {
      route: 'search',
      reason: `multilingual:arabic:${arabicMatch}`,
      matchedRule: `multilingual:arabic:${arabicMatch}`
    };
  }

  // 4. Live-Data Patterns (Weather, Financial/Crypto, Sports, Service status)
  for (const weatherPattern of WEATHER_PATTERNS) {
    if (weatherPattern.test(normalized)) {
      return {
        route: 'search',
        reason: 'live:weather',
        matchedRule: 'live:weather'
      };
    }
  }

  for (const finPattern of FINANCIAL_PATTERNS) {
    if (finPattern.test(normalized)) {
      if (/exchange\s+rate/i.test(normalized)) {
        return {
          route: 'search',
          reason: 'live:exchange-rate',
          matchedRule: 'live:exchange-rate'
        };
      }
      if (/(?:stock|share)\s+price/i.test(normalized)) {
        return {
          route: 'search',
          reason: 'live:stock-price',
          matchedRule: 'live:stock-price'
        };
      }
      return {
        route: 'search',
        reason: 'live:crypto-price',
        matchedRule: 'live:crypto-price'
      };
    }
  }

  for (const sportsPattern of SPORTS_PATTERNS) {
    if (sportsPattern.test(normalized)) {
      return {
        route: 'search',
        reason: 'live:sports',
        matchedRule: 'live:sports'
      };
    }
  }

  if (SERVICE_DOWN_PATTERN.test(normalized)) {
    return {
      route: 'search',
      reason: 'live:service-down',
      matchedRule: 'live:service-down'
    };
  }

  // 5. Current + Time-Sensitive Entity Patterns
  if (CURRENT_ENTITY_PATTERN.test(normalized)) {
    const match = normalized.match(CURRENT_ENTITY_PATTERN);
    const attr = match ? match[0].toLowerCase().replace(/^current\s+/, '').replace(/\s+/g, '-') : 'entity';
    return {
      route: 'search',
      reason: `current:${attr}`,
      matchedRule: `current:${attr}`
    };
  }

  if (CURRENT_PRICE_OR_RATE_PATTERN.test(normalized)) {
    const isRate = /rate\b/i.test(normalized);
    const reason = isRate ? 'current:rate' : 'current:price';
    return {
      route: 'search',
      reason,
      matchedRule: reason
    };
  }

  // 6. High-Confidence English Freshness Signals
  for (const { rule, regex } of ENGLISH_FRESHNESS_RULES) {
    if (regex.test(normalized)) {
      return {
        route: 'search',
        reason: rule,
        matchedRule: rule
      };
    }
  }

  // Default: Normal AI
  return {
    route: 'ai',
    reason: 'default:no-live-signal',
    matchedRule: null
  };
}
