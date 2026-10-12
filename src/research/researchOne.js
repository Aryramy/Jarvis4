/**
 * Research One Module for JARVIS4 (Brick 24).
 * Executes Search -> Read (with fallback across candidate sources) -> Grounded Answer v1 pipeline:
 * 1. Performs explicit web search via existing OpenRouter provider (Brick 19/20)
 * 2. Verifies provider-level search evidence (searchUsed = true)
 * 3. Builds ordered valid source candidates preserving provider citation order
 * 4. Deterministically attempts page reading starting with candidate index 0
 * 5. Falls back to next candidate ONLY upon controlled page-read failures
 * 6. Stops at first successfully read page (first success wins)
 * 7. Generates grounded answer using ONLY that webpage content via Brick-22 helper
 * 8. Returns NO_READABLE_SEARCH_SOURCE if all candidates fail
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
    this.sourcesFound = details.sourcesFound;
    this.pageReadAttempts = details.pageReadAttempts;
    this.attempts = details.attempts;
  }
}

/**
 * Approved controlled page-reader error codes eligible for fallback to next source.
 */
export const CONTROLLED_PAGE_READ_ERROR_CODES = new Set([
  'INVALID_URL',
  'UNSUPPORTED_PROTOCOL',
  'URL_CREDENTIALS_NOT_ALLOWED',
  'PORT_NOT_ALLOWED',
  'LOCAL_OR_PRIVATE_HOST_BLOCKED',
  'DNS_RESOLUTION_FAILED',
  'TOO_MANY_REDIRECTS',
  'INSECURE_REDIRECT_DOWNGRADE',
  'FETCH_TIMEOUT',
  'PAGE_TOO_LARGE',
  'UNSUPPORTED_CONTENT_TYPE',
  'HTTP_ERROR',
  'NO_READABLE_CONTENT',
  'FETCH_FAILED'
]);

/**
 * Checks if an error is part of the approved controlled page-reader contract.
 * @param {Error|any} err
 * @returns {boolean}
 */
export function isControlledPageReadError(err) {
  if (!err) return false;
  if (err instanceof PageReaderError) return true;
  if (typeof err.code === 'string' && CONTROLLED_PAGE_READ_ERROR_CODES.has(err.code)) {
    return true;
  }
  return false;
}

/**
 * Builds ordered list of valid source candidates from provider citation sources.
 * Provider citation order is strictly preserved. Original indices are retained.
 * Candidate URLs must be non-empty strings with http: or https: protocols.
 * No LLM ranking, keyword scoring, or domain scoring is performed.
 *
 * @param {Array<Object>} sources
 * @returns {Array<{ index: number, url: string, title: string, source: Object }>}
 */
export function getValidSourceCandidates(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return [];
  }

  const candidates = [];
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

    candidates.push({
      index: i,
      url: trimmedUrl,
      title,
      source: src
    });
  }

  return candidates;
}

/**
 * Deterministically selects the first valid HTTP/HTTPS source from provider citation sources.
 * Preserved for backwards compatibility with Brick 23 callers.
 *
 * @param {Array<Object>} sources
 * @returns {{ index: number, url: string, title: string, source: Object }}
 */
export function selectResearchSource(sources) {
  const candidates = getValidSourceCandidates(sources);
  if (candidates.length === 0) {
    throw new ResearchOneError(
      'NO_USABLE_SEARCH_SOURCE',
      'No usable citation sources found in search results',
      { stage: 'source-selection' }
    );
  }

  return candidates[0];
}

/**
 * Executes the full Search -> Read (with fallback) -> Grounded Answer pipeline.
 *
 * Pipeline sequence:
 * 1. Validate question
 * 2. Search web via existing Brick-19/20 OpenRouter provider (exactly ONE search call)
 * 3. Verify provider search evidence (searchUsed must be true)
 * 4. Build ordered list of valid citation sources (preserving provider ranking order)
 * 5. Sequentially attempt reading candidate pages:
 *    - If read succeeds: STOP reading, select this source
 *    - If read fails with approved controlled error: record attempt, try next candidate
 *    - If read fails with unexpected error: STOP immediately, return safe internal failure
 * 6. If all candidates fail: return NO_READABLE_SEARCH_SOURCE with attempt diagnostics
 * 7. Answer grounded strictly in the ONE successfully read webpage content
 * 8. Return structured response with timing breakdowns and attempt diagnostics
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

  // 2. Perform search via existing verified search provider (exactly ONE search call)
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

  const sourcesCount = Array.isArray(searchResult.sources) ? searchResult.sources.length : 0;

  // 4. Build ordered list of valid citation source candidates
  const candidates = getValidSourceCandidates(searchResult.sources);
  if (candidates.length === 0) {
    throw new ResearchOneError(
      'NO_USABLE_SEARCH_SOURCE',
      'No usable citation sources found in search results',
      { stage: 'source-selection', searchDurationMs, sourcesFound: sourcesCount }
    );
  }

  // 5. Attempt reading candidates in authoritative provider citation order
  const reader = options.pageReaderFn || ((targetUrl) => readWebPage(targetUrl, {
    fetchFn: options.fetchFn,
    dnsLookup: options.dnsLookup,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    maxTextChars: options.maxTextChars,
    maxRedirects: options.maxRedirects
  }));

  const attempts = [];
  let selectedCandidate = null;
  let successfulPage = null;
  let totalPageReadDurationMs = 0;

  for (const candidate of candidates) {
    const attemptStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    let readResult;
    try {
      readResult = await reader(candidate.url);
    } catch (err) {
      const attemptEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
      const attemptDurationMs = Math.max(0.001, Number((attemptEndTime - attemptStartTime).toFixed(3)));
      totalPageReadDurationMs += attemptDurationMs;

      // Check if error is an approved controlled page-reader error
      if (!isControlledPageReadError(err)) {
        // Unexpected internal error: STOP immediately! Do not swallow or try more sources!
        attempts.push({
          sourceIndex: candidate.index,
          title: candidate.title,
          url: candidate.url,
          status: 'failed',
          errorCode: 'PAGE_READ_INTERNAL_ERROR'
        });
        throw new ResearchOneError(
          'PAGE_READ_INTERNAL_ERROR',
          'Unexpected error reading webpage',
          {
            stage: 'page-read',
            searchDurationMs,
            pageReadDurationMs: Number(totalPageReadDurationMs.toFixed(3)),
            sourcesFound: sourcesCount,
            pageReadAttempts: attempts.length,
            attempts
          }
        );
      }

      const errorCode = err.code || 'FETCH_FAILED';
      attempts.push({
        sourceIndex: candidate.index,
        title: candidate.title,
        url: candidate.url,
        status: 'failed',
        errorCode
      });

      // Move to next candidate source
      continue;
    }

    const attemptEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const attemptDurationMs = (typeof readResult?.serverReadDurationMs === 'number')
      ? readResult.serverReadDurationMs
      : Math.max(0.001, Number((attemptEndTime - attemptStartTime).toFixed(3)));
    totalPageReadDurationMs += attemptDurationMs;

    // Validate readable content
    if (!readResult || typeof readResult.text !== 'string' || readResult.text.trim().length === 0) {
      attempts.push({
        sourceIndex: candidate.index,
        title: candidate.title,
        url: candidate.url,
        status: 'failed',
        errorCode: 'NO_READABLE_CONTENT'
      });
      continue;
    }

    // First successful read wins! Stop reading sources immediately.
    selectedCandidate = candidate;
    successfulPage = readResult;
    attempts.push({
      sourceIndex: candidate.index,
      title: candidate.title,
      url: candidate.url,
      status: 'success'
    });
    break;
  }

  const pageReadDurationMs = Number(totalPageReadDurationMs.toFixed(3));

  // 6. If all candidates fail: return controlled NO_READABLE_SEARCH_SOURCE
  if (!selectedCandidate) {
    throw new ResearchOneError(
      'NO_READABLE_SEARCH_SOURCE',
      'No provider citation source could be safely read',
      {
        stage: 'page-read',
        searchDurationMs,
        pageReadDurationMs,
        sourcesFound: sourcesCount,
        pageReadAttempts: attempts.length,
        attempts
      }
    );
  }

  // 7. Grounded answering using ONLY extracted webpage content from the successful page
  // Note: search answer prose and search snippets are NEVER passed to the grounding prompt
  let qaResult;
  try {
    qaResult = await answerFromPageContent({
      page: successfulPage,
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
      selectedSourceIndex: selectedCandidate.index,
      selectedSource: {
        index: selectedCandidate.index,
        title: selectedCandidate.title,
        url: selectedCandidate.url
      },
      sourcesFound: sourcesCount,
      pageReadAttempts: attempts.length,
      attempts,
      ...(err.details || {})
    });
  }

  const providerQaDurationMs = qaResult.providerQaDurationMs ?? 0;

  // 8. Measure total server research duration and return structured response
  const requestEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
  const serverResearchDurationMs = Math.max(0.001, Number((requestEndTime - requestStartTime).toFixed(3)));

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
    pageReadAttempts: attempts.length,
    attempts,
    selectedSourceIndex: selectedCandidate.index,
    selectedSource: {
      index: selectedCandidate.index,
      title: selectedCandidate.title,
      url: selectedCandidate.url
    },
    page: {
      requestedUrl: successfulPage.requestedUrl || selectedCandidate.url,
      finalUrl: successfulPage.finalUrl || selectedCandidate.url,
      title: successfulPage.title ?? null,
      httpStatus: successfulPage.httpStatus || 200,
      contentType: successfulPage.contentType || 'text/html',
      truncated: Boolean(successfulPage.truncated)
    },
    pageTruncated: Boolean(successfulPage.truncated),
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
  CONTROLLED_PAGE_READ_ERROR_CODES,
  isControlledPageReadError,
  getValidSourceCandidates,
  selectResearchSource,
  executeResearchOne
};
