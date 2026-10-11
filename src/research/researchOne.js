/**
 * Research One Module for JARVIS4 (Brick 23).
 * Executes Search -> Read -> Grounded Answer v1 pipeline:
 * 1. Performs explicit web search via existing OpenRouter provider (Brick 19/20)
 * 2. Verifies provider-level search evidence (searchUsed = true)
 * 3. Deterministically selects the first valid HTTP/HTTPS citation source in provider order
 * 4. Safely reads that ONE webpage via verified Brick-21 reader
 * 5. Generates grounded answer using ONLY that webpage content via Brick-22 helper
 */

import { OpenRouterSearchProvider } from '../providers/openRouterSearch.js';
import { readWebPage } from '../webpage/pageReader.js';
import { PageReaderError } from '../webpage/urlSafety.js';
import { validatePageQaQuestion, answerFromPageContent, PageQaError } from '../webpage/pageQa.js';
import { config } from '../config/index.js';

export class ResearchOneError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Object} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ResearchOneError';
    this.code = code;
    this.stage = details.stage || 'unknown';
    this.details = details;
  }
}

/**
 * Deterministically selects the first valid HTTP/HTTPS source from provider citation sources.
 * Provider ranking order is preserved authoritative. No LLM or reranking is used.
 *
 * @param {Array<Object>} sources
 * @returns {{ index: number, url: string, title: string, source: Object }}
 */
export function selectResearchSource(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new ResearchOneError(
      'NO_USABLE_SEARCH_SOURCE',
      'No usable citation sources found in search results',
      { stage: 'source-selection' }
    );
  }

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (!src || typeof src !== 'object') continue;
    if (typeof src.url !== 'string') continue;

    const trimmedUrl = src.url.trim();
    if (trimmedUrl.length === 0) continue;

    let parsed;
    try {
      parsed = new URL(trimmedUrl);
    } catch {
      continue;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      continue;
    }

    const title = (typeof src.title === 'string' && src.title.trim().length > 0)
      ? src.title.trim()
      : '';

    return {
      index: i,
      url: trimmedUrl,
      title,
      source: src
    };
  }

  throw new ResearchOneError(
    'NO_USABLE_SEARCH_SOURCE',
    'No usable citation sources found in search results',
    { stage: 'source-selection' }
  );
}

/**
 * Executes the full Search -> Read -> Grounded Answer pipeline.
 *
 * Pipeline sequence:
 * 1. Validate question
 * 2. Search web via existing Brick-19/20 OpenRouter provider
 * 3. Verify provider search evidence (searchUsed must be true)
 * 4. Deterministically select ONE citation source (first valid http/https)
 * 5. Safely read that ONE webpage via Brick-21 reader
 * 6. Answer grounded strictly in that webpage content via Brick-22 helper
 * 7. Return structured response with timing breakdowns
 *
 * @param {Object} params
 * @param {string} params.question
 * @param {Object} [options]
 * @param {Object} [options.searchProvider]
 * @param {Function} [options.pageReaderFn]
 * @param {Object} [options.aiProvider]
 * @param {Object} [options.textProvider]
 * @param {Function} [options.fetchFn]
 * @param {Function} [options.dnsLookup]
 * @param {number} [options.maxQuestionChars]
 * @param {number} [options.maxOutputTokens]
 * @returns {Promise<Object>}
 */
export async function executeResearchOne({ question, options = {} }) {
  const requestStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  // 1. Validate question
  const maxQuestionChars = options.maxQuestionChars ?? config.pageQa?.maxQuestionChars ?? 4000;
  let cleanQuestion;
  try {
    cleanQuestion = validatePageQaQuestion(question, maxQuestionChars);
  } catch (err) {
    throw new ResearchOneError(
      err.code || 'INVALID_QUESTION',
      err.message || 'Question validation failed',
      { stage: 'validation', ...(err.details || {}) }
    );
  }

  // 2. Perform search via existing verified search provider
  const searchProvider = options.searchProvider || new OpenRouterSearchProvider({
    fetchFn: options.fetchFn
  });

  const searchStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  let searchResult;
  try {
    searchResult = await searchProvider.search(cleanQuestion);
  } catch (err) {
    const searchEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const searchDurationMs = Math.max(0.001, Number((searchEndTime - searchStartTime).toFixed(3)));
    throw new ResearchOneError(
      'SEARCH_FAILED',
      err.message || 'Search execution failed',
      { stage: 'search', searchDurationMs }
    );
  }

  const searchEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
  const searchDurationMs = (typeof searchResult?.providerSearchDurationMs === 'number')
    ? searchResult.providerSearchDurationMs
    : ((typeof searchResult?.providerDurationMs === 'number')
      ? searchResult.providerDurationMs
      : Math.max(0.001, Number((searchEndTime - searchStartTime).toFixed(3))));

  if (!searchResult || !searchResult.success) {
    throw new ResearchOneError(
      searchResult?.error || 'SEARCH_FAILED',
      searchResult?.error || 'Search request failed',
      { stage: 'search', searchDurationMs }
    );
  }

  // 3. Verify provider-level search execution evidence
  if (!searchResult.searchUsed) {
    throw new ResearchOneError(
      'SEARCH_NOT_EXECUTED',
      'Search was not executed by provider',
      { stage: 'search', searchDurationMs }
    );
  }

  // 4. Deterministically select ONE citation source
  const selected = selectResearchSource(searchResult.sources);

  // 5. Read selected webpage ONCE via verified Brick-21 reader
  const reader = options.pageReaderFn || ((targetUrl) => readWebPage(targetUrl, {
    fetchFn: options.fetchFn,
    dnsLookup: options.dnsLookup,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    maxTextChars: options.maxTextChars,
    maxRedirects: options.maxRedirects
  }));

  const readStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  let readResult;
  try {
    readResult = await reader(selected.url);
  } catch (err) {
    const readEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const pageReadDurationMs = Math.max(0.001, Number((readEndTime - readStartTime).toFixed(3)));
    const errorCode = err.code || 'FETCH_FAILED';
    const errorMessage = err.message || 'Page read failed';

    throw new ResearchOneError(errorCode, errorMessage, {
      stage: 'page-read',
      searchDurationMs,
      pageReadDurationMs,
      selectedSource: { index: selected.index, title: selected.title, url: selected.url },
      requestedUrl: selected.url,
      finalUrl: err.details?.finalUrl || null,
      httpStatus: err.details?.httpStatus || null,
      contentType: err.details?.contentType || null,
      ...(err.details || {})
    });
  }

  const pageReadDurationMs = readResult.serverReadDurationMs ?? Math.max(
    0.001,
    Number(((readResult.fetchDurationMs || 0) + (readResult.extractionDurationMs || 0)).toFixed(3))
  );

  if (!readResult || typeof readResult.text !== 'string' || readResult.text.trim().length === 0) {
    throw new ResearchOneError('NO_READABLE_CONTENT', 'No readable text content found on webpage', {
      stage: 'page-read',
      searchDurationMs,
      pageReadDurationMs,
      selectedSource: { index: selected.index, title: selected.title, url: selected.url },
      requestedUrl: selected.url,
      finalUrl: readResult?.finalUrl || selected.url
    });
  }

  // 6. Grounded answering using ONLY extracted webpage content
  // Note: search answer prose and search snippets are NEVER passed to the grounding prompt
  let qaResult;
  try {
    qaResult = await answerFromPageContent({
      page: readResult,
      question: cleanQuestion,
      provider: options.aiProvider || options.textProvider,
      options
    });
  } catch (err) {
    const errorCode = err.code || 'PROVIDER_ERROR';
    const errorMessage = err.message || 'Page Q&A AI generation failed';

    throw new ResearchOneError(errorCode, errorMessage, {
      stage: 'grounded-answer',
      searchDurationMs,
      pageReadDurationMs,
      providerQaDurationMs: err.details?.providerDurationMs || 0,
      selectedSource: { index: selected.index, title: selected.title, url: selected.url },
      ...(err.details || {})
    });
  }

  const providerQaDurationMs = qaResult.providerQaDurationMs ?? 0;

  // 7. Measure total server research duration and return structured response
  const requestEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
  const serverResearchDurationMs = Math.max(0.001, Number((requestEndTime - requestStartTime).toFixed(3)));

  const sourcesCount = Array.isArray(searchResult.sources) ? searchResult.sources.length : 0;

  return {
    success: true,
    answer: qaResult.answer,
    grounded: true,
    search: {
      searchUsed: Boolean(searchResult.searchUsed),
      searchRequests: (typeof searchResult.searchRequests === 'number' && Number.isFinite(searchResult.searchRequests))
        ? searchResult.searchRequests
        : null,
      searchEvidence: searchResult.searchEvidence || 'none',
      sourcesFound: sourcesCount
    },
    sourcesFound: sourcesCount,
    selectedSourceIndex: selected.index,
    selectedSource: {
      index: selected.index,
      title: selected.title,
      url: selected.url
    },
    page: {
      requestedUrl: readResult.requestedUrl || selected.url,
      finalUrl: readResult.finalUrl || selected.url,
      title: readResult.title ?? null,
      httpStatus: readResult.httpStatus || 200,
      contentType: readResult.contentType || 'text/html',
      truncated: Boolean(readResult.truncated)
    },
    pageTruncated: Boolean(readResult.truncated),
    provider: 'openrouter',
    model: qaResult.model || config.openRouter?.textModel || 'deepseek/deepseek-v4-flash-0731',
    searchDurationMs,
    pageReadDurationMs,
    providerQaDurationMs,
    serverResearchDurationMs
  };
}

export default {
  ResearchOneError,
  selectResearchSource,
  executeResearchOne
};
