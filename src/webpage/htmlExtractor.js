/**
 * HTML Text and Metadata Extractor for JARVIS4 (Brick 21).
 * Extracts clean, readable text from static HTML using cheerio.
 */

import * as cheerio from 'cheerio';
import { PageReaderError } from './urlSafety.js';

const NOISE_SELECTORS = 'script, style, noscript, svg, canvas, iframe, nav, footer, form';

/**
 * Normalizes text whitespace while preserving lines and Unicode scripts.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeText(raw) {
  if (typeof raw !== 'string') return '';
  // Convert CRLF and CR to LF
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Trim spaces/tabs on each line and collapse repeated intra-line spaces
  text = text
    .split('\n')
    .map(line => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line, idx, arr) => {
      // Don't keep consecutive blank lines beyond 1
      if (line === '' && (idx === 0 || arr[idx - 1] === '')) return false;
      return true;
    })
    .join('\n');
  // Collapse 3 or more newlines to 2
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

/**
 * Extracts readable plain text and metadata from static HTML.
 * @param {string} html
 * @param {Object} [options]
 * @param {number} [options.maxTextChars=30000]
 * @returns {{ title: string|null, text: string, extractedCharacters: number, truncated: boolean, extractionDurationMs: number }}
 */
export function extractHtmlContent(html, options = {}) {
  const maxTextChars = options.maxTextChars ?? 30000;
  const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  if (typeof html !== 'string' || html.trim().length === 0) {
    throw new PageReaderError('NO_READABLE_CONTENT', 'HTML content is empty');
  }

  const $ = cheerio.load(html);

  // 1. Extract <title>
  let title = null;
  const rawTitle = $('title').first().text();
  if (typeof rawTitle === 'string') {
    const normalizedTitle = rawTitle.replace(/\s+/g, ' ').trim();
    if (normalizedTitle.length > 0) {
      title = normalizedTitle;
    }
  }

  // 2. Remove noise elements
  $(NOISE_SELECTORS).remove();

  // 3. Prefer containers: main -> article -> body
  let rawText = '';
  const mainEl = $('main');
  const articleEl = $('article');

  if (mainEl.length > 0 && mainEl.text().trim().length > 0) {
    rawText = mainEl.map((_, el) => $(el).text()).get().join('\n\n');
  } else if (articleEl.length > 0 && articleEl.text().trim().length > 0) {
    rawText = articleEl.map((_, el) => $(el).text()).get().join('\n\n');
  } else if ($('body').length > 0) {
    rawText = $('body').text();
  } else {
    rawText = $.root().text();
  }

  // 4. Normalize whitespace
  const normalizedText = normalizeText(rawText);

  if (normalizedText.length === 0) {
    throw new PageReaderError('NO_READABLE_CONTENT', 'No readable textual content could be extracted from the page.');
  }

  // 5. Truncate if exceeding limit
  let finalContent = normalizedText;
  let truncated = false;

  if (finalContent.length > maxTextChars) {
    finalContent = finalContent.slice(0, maxTextChars);
    truncated = true;
  }

  const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
  const extractionDurationMs = Math.max(0.001, Number((endTime - startTime).toFixed(3)));

  return {
    title,
    text: finalContent,
    extractedCharacters: finalContent.length,
    truncated,
    extractionDurationMs
  };
}
