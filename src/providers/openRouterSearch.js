/**
 * OpenRouter Web Search Provider Adapter for JARVIS4 (Brick 19).
 * Connects to OpenRouter /chat/completions with the openrouter:web_search server tool (engine: exa, mode: fast, max_uses: 1).
 */

import { SearchProvider } from './searchBase.js';
import { config } from '../config/index.js';

/**
 * Builds the isolated search system instruction with dynamic current date awareness,
 * freshness honesty, and concise answer guidelines.
 *
 * @param {string} [currentDate] - Date string in YYYY-MM-DD format (defaults to current UTC date)
 * @returns {string}
 */
export function buildSearchSystemPrompt(currentDate = new Date().toISOString().slice(0, 10)) {
  return [
    `Current date: ${currentDate}.`,
    'You have access to live web search. For this request, use web search before answering. Base current factual claims on the returned search results. Do not invent sources or URLs. Clearly distinguish uncertainty when the search evidence is insufficient.',
    'For queries containing concepts such as latest, recent, current, today, this week, this month, newest, recently announced, or similar wording:',
    '- search for information relevant to the current date',
    '- include the current year in the search intent when useful',
    '- prioritize recently published authoritative sources',
    '- prefer primary/official sources when available',
    '- do not describe older results as "latest" if newer evidence was not found',
    '- explicitly state the newest publication date actually found',
    'If the newest credible source returned is old relative to the user\'s request, do not claim they are the latest announcements; instead state: "The newest search result I found is dated <date>. I did not find a newer result in this search." Do not fabricate dates.',
    'Answer format requirements:',
    '- Provide a concise answer with approximately 3-5 useful bullet points and a brief summary.',
    '- Maximum 3 primary sources when possible.',
    '- Avoid unnecessary background history.',
    '- Do not repeat the list of source URLs inside the narrative prose.'
  ].join('\n');
}

export const NARROW_SEARCH_SYSTEM_INSTRUCTION = buildSearchSystemPrompt();

export const PINNED_SEARCH_TOOL = Object.freeze({
  type: 'openrouter:web_search',
  parameters: Object.freeze({
    engine: 'exa',
    mode: 'fast',
    max_uses: 1,
    max_results: 3,
    max_total_results: 3,
    max_characters: 1200
  })
});

/**
 * Detects whether a search query is freshness-sensitive.
 *
 * @param {string} query
 * @returns {boolean}
 */
export function isFreshnessSensitiveQuery(query) {
  if (typeof query !== 'string') return false;
  const pattern = /\b(latest|recent|recently|current|currently|today|this\s+week|this\s+month|newest|recently\s+announced)\b/i;
  return pattern.test(query);
}

/**
 * Safely extracts text from assistant message content.
 * Handles both plain strings and OpenRouter/OpenAI structured text content blocks.
 *
 * @param {*} content
 * @returns {string}
 */
export function extractMessageText(content) {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block) continue;
      if (typeof block === 'string') {
        parts.push(block);
      } else if (typeof block === 'object' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('').trim();
  }
  return '';
}

/**
 * Computes search freshness metadata based on query sensitivity, sources, and current date.
 *
 * @param {string} query
 * @param {Array<{ publishedDate?: string|null }>} sources
 * @param {string} currentDate - YYYY-MM-DD
 * @returns {{
 *   freshnessSensitive: boolean,
 *   newestSourceDate: string|null,
 *   freshnessStatus: 'current'|'older-results-only'|'unknown'
 * }}
 */
export function computeFreshnessMetadata(query, sources, currentDate) {
  const freshnessSensitive = isFreshnessSensitiveQuery(query);
  const datedSources = Array.isArray(sources)
    ? sources.filter((s) => typeof s.publishedDate === 'string' && s.publishedDate.trim().length > 0)
    : [];

  if (datedSources.length === 0) {
    return {
      freshnessSensitive,
      newestSourceDate: null,
      freshnessStatus: 'unknown'
    };
  }

  const parseTime = (dateStr) => {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const t = Date.parse(dateStr.trim());
    return Number.isNaN(t) ? null : t;
  };

  let newestSourceDate = null;
  let newestTimeMs = -Infinity;

  for (const s of datedSources) {
    const t = parseTime(s.publishedDate);
    if (t !== null && t > newestTimeMs) {
      newestTimeMs = t;
      newestSourceDate = s.publishedDate.trim();
    } else if (newestSourceDate === null) {
      newestSourceDate = s.publishedDate.trim();
    }
  }

  let freshnessStatus = 'unknown';
  const currTime = parseTime(currentDate) ?? Date.now();

  if (newestTimeMs !== -Infinity) {
    const ageDays = (currTime - newestTimeMs) / (1000 * 60 * 60 * 24);
    // Recent if within 90 days or future/same day
    if (ageDays <= 90) {
      freshnessStatus = 'current';
    } else {
      freshnessStatus = 'older-results-only';
    }
  } else if (newestSourceDate) {
    const currYear = typeof currentDate === 'string' ? currentDate.slice(0, 4) : '';
    if (currYear && newestSourceDate.includes(currYear)) {
      freshnessStatus = 'current';
    } else {
      freshnessStatus = 'older-results-only';
    }
  }

  return {
    freshnessSensitive,
    newestSourceDate,
    freshnessStatus
  };
}

export class OpenRouterSearchProvider extends SearchProvider {
  /**
   * @param {Object} [options]
   * @param {string} [options.apiKey]
   * @param {string} [options.baseUrl]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchFn]
   */
  constructor(options = {}) {
    super('openrouter-search');

    const defaultCfg = config.openRouter || {};

    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? defaultCfg.apiKey ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.OPENROUTER_SEARCH_BASE_URL ?? process.env.OPENROUTER_TEXT_BASE_URL ?? defaultCfg.searchBaseUrl ?? defaultCfg.textBaseUrl ?? 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, '');
    this.model = options.model ?? process.env.OPENROUTER_SEARCH_MODEL ?? defaultCfg.searchModel ?? 'deepseek/deepseek-v4-flash-0731';
    this.timeoutMs = Number(options.timeoutMs ?? process.env.OPENROUTER_SEARCH_TIMEOUT_MS ?? defaultCfg.searchTimeoutMs ?? 30000) || 30000;
    this.fetchFn = options.fetchFn || globalThis.fetch;

    this.engine = 'exa';
    this.mode = 'fast';
    this.maxUses = 1;
    this.maxResults = 3;
    this.maxTotalResults = 3;
    this.maxCharacters = 1200;
    this.maxTokens = 1500;
  }

  /**
   * Validates configuration required to make external search calls.
   * @returns {{ valid: boolean, error?: string }}
   */
  validateConfig() {
    if (!this.apiKey || typeof this.apiKey !== 'string' || this.apiKey.trim().length === 0) {
      return { valid: false, error: 'OpenRouter API key is required' };
    }
    if (!this.model || typeof this.model !== 'string' || this.model.trim().length === 0) {
      return { valid: false, error: 'OpenRouter search model is required' };
    }
    return { valid: true };
  }

  /**
   * Sanitizes error messages ensuring API key is never leaked.
   * @param {string} message
   * @returns {string}
   */
  sanitizeError(message) {
    if (!message || typeof message !== 'string') return '';
    let safe = message;
    const keyToRedact = this.apiKey || process.env.OPENROUTER_API_KEY;
    if (keyToRedact) {
      safe = safe.replaceAll(keyToRedact, '[REDACTED]');
    }
    return safe;
  }

  /**
   * Safely extracts and deduplicates real URL citations from provider response data.
   * Preserves publication dates when supplied by provider metadata.
   * Never fabricates sources and never parses URLs or dates out of model narrative text.
   *
   * @param {Object} data - Raw provider response JSON
   * @returns {Array<{ title: string, url: string, content?: string, publishedDate?: string|null }>}
   */
  extractSources(data) {
    const sources = [];
    const seenUrls = new Set();

    const addSource = (rawUrl, rawTitle, rawContent, rawPublishedDate) => {
      if (!rawUrl || typeof rawUrl !== 'string') return;
      const url = rawUrl.trim();
      if (!url || seenUrls.has(url)) return;

      seenUrls.add(url);
      const sourceObj = {
        title: (typeof rawTitle === 'string' && rawTitle.trim().length > 0) ? rawTitle.trim() : '',
        url
      };
      if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
        sourceObj.content = rawContent.trim();
      }
      if (typeof rawPublishedDate === 'string' && rawPublishedDate.trim().length > 0) {
        sourceObj.publishedDate = rawPublishedDate.trim();
      } else {
        sourceObj.publishedDate = null;
      }
      sources.push(sourceObj);
    };

    const firstChoice = data?.choices?.[0];
    const message = firstChoice?.message;

    const getDate = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      return obj.published_date || obj.publishedDate || obj.date || null;
    };

    // 1. Check annotations array on message, choice, or data
    const annotations = message?.annotations || firstChoice?.annotations || data?.annotations;
    if (Array.isArray(annotations)) {
      for (const ann of annotations) {
        if (!ann || typeof ann !== 'object') continue;
        const pubDate = getDate(ann.url_citation) || getDate(ann);
        if (ann.type === 'url_citation' && ann.url_citation && typeof ann.url_citation === 'object') {
          addSource(ann.url_citation.url, ann.url_citation.title, ann.url_citation.content, pubDate);
        } else if (ann.type === 'url_citation' && ann.url) {
          addSource(ann.url, ann.title, ann.content, pubDate);
        } else if (ann.url) {
          addSource(ann.url, ann.title, ann.content, pubDate);
        }
      }
    }

    // 2. Check citations array on message, choice, or data
    const citations = message?.citations || firstChoice?.citations || data?.citations;
    if (Array.isArray(citations)) {
      for (const cit of citations) {
        if (!cit || typeof cit !== 'object') continue;
        if (cit.url) {
          const pubDate = getDate(cit);
          addSource(cit.url, cit.title, cit.content, pubDate);
        }
      }
    }

    return sources;
  }

  /**
   * Performs an explicit web search using OpenRouter server-tool architecture.
   *
   * @param {string} prompt - Prompt or question requiring live search
   * @param {Object} [options]
   * @param {number} [options.timeoutMs] - Override timeout in milliseconds
   * @param {string} [options.systemPrompt] - Override narrow system prompt
   * @param {string} [options.currentDate] - Override dynamic date (e.g. for testing)
   * @returns {Promise<{
   *   success: boolean,
   *   text?: string,
   *   response?: string,
   *   provider?: string,
   *   model?: string,
   *   searchUsed: boolean,
   *   searchRequests: number|null,
   *   searchEvidence: string,
   *   sources: Array<{ title: string, url: string, content?: string, publishedDate?: string|null }>,
   *   currentDate: string,
   *   freshnessSensitive: boolean,
   *   newestSourceDate: string|null,
   *   freshnessStatus: string,
   *   providerFinishReason?: string|null,
   *   hasMessage?: boolean,
   *   hasMessageContent?: boolean,
   *   contentType?: string,
   *   hasToolCalls?: boolean,
   *   hasReasoning?: boolean,
   *   annotationCount?: number,
   *   providerSearchDurationMs?: number,
   *   providerDurationMs?: number,
   *   error?: string
   * }>}
   */
  async search(prompt, options = {}) {
    const currentDate = options.currentDate || new Date().toISOString().slice(0, 10);
    const freshnessSensitive = typeof prompt === 'string' ? isFreshnessSensitiveQuery(prompt) : false;

    // 1. Validate prompt
    if (typeof prompt !== 'string') {
      return {
        success: false,
        error: 'Prompt must be a string',
        searchUsed: false,
        searchRequests: null,
        searchEvidence: 'none',
        sources: [],
        currentDate,
        freshnessSensitive,
        newestSourceDate: null,
        freshnessStatus: 'unknown',
        providerFinishReason: null,
        hasMessage: false,
        hasMessageContent: false,
        contentType: 'none',
        hasToolCalls: false,
        hasReasoning: false,
        annotationCount: 0
      };
    }

    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length === 0) {
      return {
        success: false,
        error: 'Prompt cannot be empty',
        searchUsed: false,
        searchRequests: null,
        searchEvidence: 'none',
        sources: [],
        currentDate,
        freshnessSensitive,
        newestSourceDate: null,
        freshnessStatus: 'unknown',
        providerFinishReason: null,
        hasMessage: false,
        hasMessageContent: false,
        contentType: 'none',
        hasToolCalls: false,
        hasReasoning: false,
        annotationCount: 0
      };
    }

    // 2. Validate configuration
    const configCheck = this.validateConfig();
    if (!configCheck.valid) {
      return {
        success: false,
        error: configCheck.error,
        searchUsed: false,
        searchRequests: null,
        searchEvidence: 'none',
        sources: [],
        currentDate,
        freshnessSensitive,
        newestSourceDate: null,
        freshnessStatus: 'unknown',
        providerFinishReason: null,
        hasMessage: false,
        hasMessageContent: false,
        contentType: 'none',
        hasToolCalls: false,
        hasReasoning: false,
        annotationCount: 0
      };
    }

    // 3. Prepare HTTP request
    const endpoint = `${this.baseUrl}/chat/completions`;
    const timeout = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timeoutId = null;

    if (timeout > 0 && typeof setTimeout === 'function') {
      timeoutId = setTimeout(() => {
        controller.abort(new Error(`Request timed out after ${timeout}ms`));
      }, timeout);
    }

    const reqStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    const getElapsedProviderMs = () => {
      const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
      return Math.max(0, Math.round(now - reqStartTime));
    };

    const systemPrompt = options.systemPrompt ?? buildSearchSystemPrompt(currentDate);

    const toolDefinition = {
      type: 'openrouter:web_search',
      parameters: {
        engine: this.engine,
        mode: this.mode,
        max_uses: this.maxUses,
        max_results: this.maxResults,
        max_total_results: this.maxTotalResults,
        max_characters: this.maxCharacters
      }
    };

    const requestBody = {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: trimmedPrompt
        }
      ],
      tools: [toolDefinition],
      max_tokens: this.maxTokens
    };

    try {
      const response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!response.ok) {
        let errorDetail = '';
        try {
          const errorJson = await response.json();
          errorDetail = errorJson.error?.message || errorJson.message || JSON.stringify(errorJson);
        } catch {
          try {
            errorDetail = await response.text();
          } catch {
            errorDetail = response.statusText || 'Unknown error';
          }
        }
        const safeError = this.sanitizeError(errorDetail || response.statusText);
        return {
          success: false,
          error: `Provider HTTP ${response.status}: ${safeError || response.statusText}`,
          searchUsed: false,
          searchRequests: null,
          searchEvidence: 'none',
          sources: [],
          currentDate,
          freshnessSensitive,
          newestSourceDate: null,
          freshnessStatus: 'unknown',
          providerFinishReason: null,
          hasMessage: false,
          hasMessageContent: false,
          contentType: 'none',
          hasToolCalls: false,
          hasReasoning: false,
          annotationCount: 0,
          providerSearchDurationMs: getElapsedProviderMs(),
          providerDurationMs: getElapsedProviderMs()
        };
      }

      let data;
      try {
        data = await response.json();
      } catch (err) {
        return {
          success: false,
          error: `Malformed response from provider: failed to parse JSON (${err.message})`,
          searchUsed: false,
          searchRequests: null,
          searchEvidence: 'none',
          sources: [],
          currentDate,
          freshnessSensitive,
          newestSourceDate: null,
          freshnessStatus: 'unknown',
          providerFinishReason: null,
          hasMessage: false,
          hasMessageContent: false,
          contentType: 'none',
          hasToolCalls: false,
          hasReasoning: false,
          annotationCount: 0,
          providerSearchDurationMs: getElapsedProviderMs(),
          providerDurationMs: getElapsedProviderMs()
        };
      }

      if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
        return {
          success: false,
          error: 'Malformed response from provider: missing choices array',
          searchUsed: false,
          searchRequests: null,
          searchEvidence: 'none',
          sources: [],
          currentDate,
          freshnessSensitive,
          newestSourceDate: null,
          freshnessStatus: 'unknown',
          providerFinishReason: null,
          hasMessage: false,
          hasMessageContent: false,
          contentType: 'none',
          hasToolCalls: false,
          hasReasoning: false,
          annotationCount: 0,
          providerSearchDurationMs: getElapsedProviderMs(),
          providerDurationMs: getElapsedProviderMs()
        };
      }

      const firstChoice = data.choices[0];
      const message = firstChoice?.message;
      const providerFinishReason = typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : null;

      // 1. Extract real citations/sources first (direct provider url_citation annotations only)
      const sources = this.extractSources(data);
      const hasCitationEvidence = sources.length > 0;

      // Count annotations
      const annotations = message?.annotations || firstChoice?.annotations || data?.annotations;
      const annotationCount = Array.isArray(annotations) ? annotations.length : 0;

      // 2. Extract search requests count from usage metadata
      const rawSearchRequests = data?.usage?.server_tool_use?.web_search_requests
        ?? data?.usage?.web_search_requests;
      const hasValidUsageNumber = typeof rawSearchRequests === 'number' && Number.isFinite(rawSearchRequests) && rawSearchRequests >= 0;

      const searchRequests = hasValidUsageNumber ? rawSearchRequests : null;
      const hasUsageEvidence = hasValidUsageNumber && searchRequests >= 1;

      // searchUsed = true when EITHER:
      // A. usage.server_tool_use.web_search_requests >= 1
      // OR
      // B. one or more genuine OpenRouter url_citation annotations are present
      const searchUsed = hasUsageEvidence || hasCitationEvidence;

      let searchEvidence = 'none';
      if (hasUsageEvidence && hasCitationEvidence) {
        searchEvidence = 'usage+url_citation';
      } else if (hasUsageEvidence) {
        searchEvidence = 'usage';
      } else if (hasCitationEvidence) {
        searchEvidence = 'url_citation';
      } else {
        searchEvidence = 'none';
      }

      // 3. Compute freshness metadata
      const { newestSourceDate, freshnessStatus } = computeFreshnessMetadata(trimmedPrompt, sources, currentDate);

      // 4. Inspect final message content safely
      const rawContent = message?.content;
      const finalText = extractMessageText(rawContent);
      const hasMessage = Boolean(message);
      const hasMessageContent = Boolean(finalText && finalText.length > 0);
      const contentType = typeof rawContent === 'string'
        ? 'string'
        : (Array.isArray(rawContent) ? 'array' : (rawContent === null ? 'null' : typeof rawContent));
      const hasToolCalls = Boolean(Array.isArray(message?.tool_calls) && message.tool_calls.length > 0);
      const hasReasoning = Boolean(message?.reasoning || message?.reasoning_content);

      const elapsedMs = getElapsedProviderMs();

      if (!hasMessageContent) {
        let errorCode = 'SEARCH_PROVIDER_NO_FINAL_CONTENT';
        if (providerFinishReason === 'length') {
          errorCode = 'SEARCH_OUTPUT_TRUNCATED';
        } else if (hasToolCalls) {
          errorCode = 'SEARCH_TOOL_LOOP_INCOMPLETE';
        }

        return {
          success: false,
          error: errorCode,
          searchUsed,
          searchRequests,
          searchEvidence,
          sources,
          currentDate,
          freshnessSensitive,
          newestSourceDate,
          freshnessStatus,
          providerFinishReason,
          hasMessage,
          hasMessageContent: false,
          contentType,
          hasToolCalls,
          hasReasoning,
          annotationCount,
          providerSearchDurationMs: elapsedMs,
          providerDurationMs: elapsedMs
        };
      }

      return {
        success: true,
        text: finalText,
        response: finalText,
        provider: 'openrouter',
        model: data.model || this.model,
        searchUsed,
        searchRequests,
        searchEvidence,
        sources,
        currentDate,
        freshnessSensitive,
        newestSourceDate,
        freshnessStatus,
        providerFinishReason,
        hasMessage: true,
        hasMessageContent: true,
        contentType,
        hasToolCalls,
        hasReasoning,
        annotationCount,
        providerSearchDurationMs: elapsedMs,
        providerDurationMs: elapsedMs
      };
    } catch (err) {
      const elapsedMs = getElapsedProviderMs();
      if (err.name === 'AbortError' || controller.signal.aborted) {
        return {
          success: false,
          error: `Request timed out after ${timeout}ms`,
          searchUsed: false,
          searchRequests: null,
          searchEvidence: 'none',
          sources: [],
          currentDate,
          freshnessSensitive,
          newestSourceDate: null,
          freshnessStatus: 'unknown',
          providerFinishReason: null,
          hasMessage: false,
          hasMessageContent: false,
          contentType: 'none',
          hasToolCalls: false,
          hasReasoning: false,
          annotationCount: 0,
          providerSearchDurationMs: elapsedMs,
          providerDurationMs: elapsedMs
        };
      }
      return {
        success: false,
        error: `Network error: ${this.sanitizeError(err.message)}`,
        searchUsed: false,
        searchRequests: null,
        searchEvidence: 'none',
        sources: [],
        currentDate,
        freshnessSensitive,
        newestSourceDate: null,
        freshnessStatus: 'unknown',
        providerFinishReason: null,
        hasMessage: false,
        hasMessageContent: false,
        contentType: 'none',
        hasToolCalls: false,
        hasReasoning: false,
        annotationCount: 0,
        providerSearchDurationMs: elapsedMs,
        providerDurationMs: elapsedMs
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}

export default OpenRouterSearchProvider;
