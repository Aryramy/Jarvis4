/**
 * Web Page Reader Module for JARVIS4 (Brick 21).
 * Safely fetches an HTML page with timeout, size limits, redirect revalidation, and extracts readable text.
 */

import { validateUrlSafety, PageReaderError } from './urlSafety.js';
import { extractHtmlContent } from './htmlExtractor.js';
import { config } from '../config/index.js';

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const SUPPORTED_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);

/**
 * Reads an incremental stream while tracking byte count and enforcing a maximum limit.
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<{ buffer: Buffer, rawBytes: number }>}
 */
async function readResponseBodySafely(response, maxBytes) {
  // Check Content-Length header if available
  const contentLengthHeader = response.headers?.get
    ? response.headers.get('content-length')
    : response.headers?.['content-length'];

  if (contentLengthHeader) {
    const declaredLength = Number(contentLengthHeader);
    if (!isNaN(declaredLength) && declaredLength > maxBytes) {
      throw new PageReaderError('PAGE_TOO_LARGE', `Response Content-Length (${declaredLength} bytes) exceeds maximum allowed limit (${maxBytes} bytes)`);
    }
  }

  // If response.body is an async iterable or Web ReadableStream
  if (response.body && (typeof response.body.getReader === 'function' || Symbol.asyncIterator in response.body)) {
    const chunks = [];
    let totalBytes = 0;

    if (typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.length;
            if (totalBytes > maxBytes) {
              await reader.cancel('PAGE_TOO_LARGE').catch(() => {});
              throw new PageReaderError('PAGE_TOO_LARGE', `Response body exceeded maximum allowed limit of ${maxBytes} bytes`);
            }
            chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
          }
        }
      } finally {
        reader.releaseLock?.();
      }
    } else {
      // Async iterator (e.g. Node stream)
      for await (const chunk of response.body) {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          response.body.destroy?.();
          throw new PageReaderError('PAGE_TOO_LARGE', `Response body exceeded maximum allowed limit of ${maxBytes} bytes`);
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    }

    return {
      buffer: Buffer.concat(chunks),
      rawBytes: totalBytes
    };
  }

  // Fallback for mocked response objects that supply .arrayBuffer() or .text()
  if (typeof response.arrayBuffer === 'function') {
    const arrayBuf = await response.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.length > maxBytes) {
      throw new PageReaderError('PAGE_TOO_LARGE', `Response body exceeded maximum allowed limit of ${maxBytes} bytes`);
    }
    return { buffer: buf, rawBytes: buf.length };
  }

  if (typeof response.text === 'function') {
    const text = await response.text();
    const buf = Buffer.from(text, 'utf8');
    if (buf.length > maxBytes) {
      throw new PageReaderError('PAGE_TOO_LARGE', `Response body exceeded maximum allowed limit of ${maxBytes} bytes`);
    }
    return { buffer: buf, rawBytes: buf.length };
  }

  throw new PageReaderError('FETCH_FAILED', 'Unable to read response body');
}

/**
 * Safely fetches a single webpage and extracts its text and metadata.
 * @param {string} urlStr
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxTextChars]
 * @param {number} [options.maxRedirects]
 * @param {Function} [options.fetchFn]
 * @param {Function} [options.dnsLookup]
 * @returns {Promise<{
 *   success: boolean,
 *   requestedUrl: string,
 *   finalUrl: string,
 *   title: string|null,
 *   contentType: string,
 *   httpStatus: number,
 *   redirectCount: number,
 *   rawBytes: number,
 *   extractedCharacters: number,
 *   truncated: boolean,
 *   fetchDurationMs: number,
 *   extractionDurationMs: number,
 *   serverReadDurationMs: number,
 *   text: string
 * }>}
 */
export async function readWebPage(urlStr, options = {}) {
  const serverStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  const timeoutMs = options.timeoutMs ?? config.webRead?.timeoutMs ?? 12000;
  const maxBytes = options.maxBytes ?? config.webRead?.maxBytes ?? 1500000;
  const maxTextChars = options.maxTextChars ?? config.webRead?.maxTextChars ?? 30000;
  const maxRedirects = options.maxRedirects ?? config.webRead?.maxRedirects ?? 3;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const dnsLookup = options.dnsLookup;

  if (typeof urlStr !== 'string' || urlStr.trim().length === 0) {
    throw new PageReaderError('INVALID_URL', 'URL must be a non-empty string');
  }

  const requestedUrl = urlStr.trim();
  let currentUrl = requestedUrl;
  let redirectCount = 0;
  let finalResponse = null;
  let finalUrl = currentUrl;
  let fetchDurationMs = 0;

  while (true) {
    // 1. URL Safety & SSRF Check for current URL
    await validateUrlSafety(currentUrl, { dnsLookup });

    // 2. Controlled Fetch with timeout
    const fetchStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    const controller = new AbortController();
    let timeoutFired = false;
    const timer = setTimeout(() => {
      timeoutFired = true;
      controller.abort();
    }, timeoutMs);

    let response;
    try {
      response = await fetchFn(currentUrl, {
        method: 'GET',
        headers: {
          'Accept': 'text/html, application/xhtml+xml',
          'User-Agent': 'JARVIS4-PageReader/1.0 (+http://127.0.0.1:8080)'
        },
        redirect: 'manual',
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (timeoutFired || controller.signal.aborted || err.name === 'AbortError') {
        throw new PageReaderError('FETCH_TIMEOUT', `Page fetch timed out after ${timeoutMs} ms`, { requestedUrl, finalUrl: currentUrl });
      }
      if (err instanceof PageReaderError) {
        throw err;
      }
      throw new PageReaderError('FETCH_FAILED', `Fetch failed: ${err.message || 'Network error'}`, { requestedUrl, finalUrl: currentUrl });
    } finally {
      clearTimeout(timer);
    }

    if (timeoutFired || controller.signal.aborted) {
      throw new PageReaderError('FETCH_TIMEOUT', `Page fetch timed out after ${timeoutMs} ms`, { requestedUrl, finalUrl: currentUrl });
    }

    const fetchEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    fetchDurationMs += Math.max(0.001, Number((fetchEndTime - fetchStartTime).toFixed(3)));

    // 3. Check for redirects
    if (REDIRECT_STATUS_CODES.has(response.status)) {
      if (redirectCount >= maxRedirects) {
        throw new PageReaderError('TOO_MANY_REDIRECTS', `Exceeded maximum redirect limit of ${maxRedirects}`, { requestedUrl, finalUrl: currentUrl, redirectCount });
      }

      const locationHeader = response.headers?.get
        ? response.headers.get('location')
        : response.headers?.['location'];

      if (!locationHeader) {
        throw new PageReaderError('HTTP_ERROR', `Redirect status ${response.status} missing Location header`, { requestedUrl, finalUrl: currentUrl, httpStatus: response.status });
      }

      let nextUrl;
      try {
        nextUrl = new URL(locationHeader, currentUrl).href;
      } catch {
        throw new PageReaderError('INVALID_URL', `Invalid redirect Location header: "${locationHeader}"`, { requestedUrl, finalUrl: currentUrl });
      }

      // Check HTTPS -> HTTP downgrade
      if (currentUrl.startsWith('https:') && nextUrl.startsWith('http:')) {
        throw new PageReaderError('INSECURE_REDIRECT_DOWNGRADE', `Insecure redirect downgrade from HTTPS to HTTP blocked: "${nextUrl}"`, { requestedUrl, finalUrl: currentUrl });
      }

      redirectCount++;
      currentUrl = nextUrl;
      continue;
    }

    finalResponse = response;
    finalUrl = currentUrl;
    break;
  }

  // 4. HTTP Status Validation
  if (finalResponse.status < 200 || finalResponse.status >= 300) {
    throw new PageReaderError('HTTP_ERROR', `HTTP error status ${finalResponse.status}`, {
      requestedUrl,
      finalUrl,
      httpStatus: finalResponse.status
    });
  }

  // 5. Content-Type Validation
  const rawContentType = finalResponse.headers?.get
    ? finalResponse.headers.get('content-type')
    : finalResponse.headers?.['content-type'];
  const mimeType = (rawContentType || '').split(';')[0].trim().toLowerCase();

  if (!SUPPORTED_CONTENT_TYPES.has(mimeType)) {
    throw new PageReaderError('UNSUPPORTED_CONTENT_TYPE', `Unsupported content type: "${mimeType || 'unknown'}". Only HTML is supported.`, {
      requestedUrl,
      finalUrl,
      httpStatus: finalResponse.status,
      contentType: mimeType
    });
  }

  // 6. Safe Body Reading with byte limit
  const { buffer, rawBytes } = await readResponseBodySafely(finalResponse, maxBytes);
  const htmlText = buffer.toString('utf8');

  // 7. Extract readable text & title
  const extractionResult = extractHtmlContent(htmlText, { maxTextChars });

  const serverEndTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
  const serverReadDurationMs = Math.max(0.001, Number((serverEndTime - serverStartTime).toFixed(3)));

  return {
    success: true,
    requestedUrl,
    finalUrl,
    title: extractionResult.title,
    contentType: mimeType,
    httpStatus: finalResponse.status,
    redirectCount,
    rawBytes,
    extractedCharacters: extractionResult.extractedCharacters,
    truncated: extractionResult.truncated,
    fetchDurationMs: Number(fetchDurationMs.toFixed(3)),
    extractionDurationMs: extractionResult.extractionDurationMs,
    serverReadDurationMs,
    text: extractionResult.text
  };
}
