/**
 * Structured Extraction & Scraping module for JARVIS4 (Brick 38).
 * Provides deterministic, read-only extraction of structured data from the active managed webpage.
 *
 * Strict invariants:
 * - Read-only: zero DOM mutations, zero clicks, zero typing, zero navigation, zero reload.
 * - Main document only: no iframe or shadow DOM orchestration (deferred to Brick 39).
 * - Zero AI: exactly 0 LLM calls, 0 OpenRouter calls, 0 Exa search calls, 0 schema inference.
 * - Strict Privacy: never scrape input values (text/password/textarea), hidden tokens, cookies, or storage.
 * - Deterministic: extracts metadata, headings, links, tables, lists, definitions, and semantic records.
 * - Bounded: respects configured records, text chars, field chars, and nesting depth limits.
 * - Safe UI: remote content rendered strictly via textContent.
 */

import * as cheerio from 'cheerio';
import { config } from '../config/index.js';

export class StructuredExtractionError extends Error {
  /**
   * @param {string} message
   * @param {string} [code='EXTRACTION_FAILED']
   * @param {Object} [details={}]
   */
  constructor(message, code = 'EXTRACTION_FAILED', details = {}) {
    super(message);
    this.name = 'StructuredExtractionError';
    this.code = code;
    this.details = details;
  }
}

export const EXTRACTION_TYPES = Object.freeze({
  METADATA: 'metadata',
  HEADINGS: 'headings',
  LINKS: 'links',
  TABLES: 'tables',
  LISTS: 'lists',
  DEFINITIONS: 'definitions',
  RECORDS: 'records'
});

export const ALL_EXTRACTION_TYPES = Object.freeze([
  EXTRACTION_TYPES.METADATA,
  EXTRACTION_TYPES.HEADINGS,
  EXTRACTION_TYPES.LINKS,
  EXTRACTION_TYPES.TABLES,
  EXTRACTION_TYPES.LISTS,
  EXTRACTION_TYPES.DEFINITIONS,
  EXTRACTION_TYPES.RECORDS
]);

/**
 * Normalizes text whitespace conservatively while preserving line structure and Unicode characters.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n|\r/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter((line, idx, arr) => line !== '' || (idx > 0 && arr[idx - 1] !== ''))
    .join('\n')
    .trim();
}

/**
 * Truncates string to a maximum length safely.
 *
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
export function truncate(str, max) {
  if (typeof str !== 'string') return '';
  return str.length > max ? str.slice(0, max) : str;
}

/**
 * Self-contained DOM extraction function executed inside browser page context (via page.evaluate)
 * or with a DOM-compatible document object in tests.
 *
 * NOTE: Must be completely self-contained because Playwright serializes it.
 *
 * @param {Object} [options={}]
 * @returns {Object}
 */
export function extractStructuredDataSnapshot(options = {}) {
  const doc = typeof document !== 'undefined' ? document : options._doc;
  const win = typeof window !== 'undefined' ? window : options._win;

  const limits = options.limits || {};
  const maxRecords = Math.max(1, Number(limits.maxRecords || 500));
  const maxTextChars = Math.max(1, Number(limits.maxTextChars || 200000));
  const maxFieldChars = Math.max(1, Number(limits.maxFieldChars || 4000));
  const maxNestingDepth = Math.max(1, Number(limits.maxNestingDepth || 5));

  const requestedTypes = Array.isArray(options.types) && options.types.length > 0
    ? options.types.map(t => String(t).toLowerCase())
    : ['metadata', 'headings', 'links', 'tables', 'lists', 'definitions', 'records'];

  function innerCleanText(raw) {
    if (typeof raw !== 'string') return '';
    return raw
      .replace(/\r\n|\r/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .split('\n')
      .map(line => line.trim())
      .filter((line, idx, arr) => line !== '' || (idx > 0 && arr[idx - 1] !== ''))
      .join('\n')
      .trim();
  }

  function innerTruncate(str, max) {
    if (typeof str !== 'string') return '';
    return str.length > max ? str.slice(0, max) : str;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return true;

    // Check HTML hidden attribute
    if (el.hasAttribute && el.hasAttribute('hidden')) return false;

    // Check aria-hidden
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;

    // Computed style visibility if available
    if (win && typeof win.getComputedStyle === 'function') {
      try {
        let curr = el;
        while (curr && curr.nodeType === 1 && curr !== doc.documentElement) {
          const style = win.getComputedStyle(curr);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return false;
          }
          if (curr.hasAttribute && curr.hasAttribute('hidden')) return false;
          if (curr.getAttribute && curr.getAttribute('aria-hidden') === 'true') return false;
          curr = curr.parentElement;
        }
      } catch {
        // Fallback to inline style
      }
    }

    // Inline style fallback
    if (el.style) {
      if (el.style.display === 'none' || el.style.visibility === 'hidden') return false;
    }

    return true;
  }

  const result = {
    metadata: null,
    headings: [],
    links: [],
    tables: [],
    lists: [],
    definitions: [],
    records: []
  };

  let recordCounter = 0;
  let textCharsCounter = 0;
  let isTruncated = false;
  let truncationReason = null;

  function checkLimit() {
    if (recordCounter >= maxRecords) {
      isTruncated = true;
      if (!truncationReason) truncationReason = 'MAX_RECORDS';
      return false;
    }
    if (textCharsCounter >= maxTextChars) {
      isTruncated = true;
      if (!truncationReason) truncationReason = 'MAX_TEXT_CHARS';
      return false;
    }
    return true;
  }

  function accountText(str) {
    if (typeof str === 'string') {
      textCharsCounter += str.length;
      if (textCharsCounter >= maxTextChars) {
        isTruncated = true;
        if (!truncationReason) truncationReason = 'MAX_TEXT_CHARS';
      }
    }
  }

  if (!doc) {
    return {
      data: result,
      counts: { headings: 0, links: 0, tables: 0, lists: 0, definitions: 0, records: 0 },
      limits: { maxRecords, maxTextChars, maxFieldChars, maxNestingDepth },
      truncated: false,
      truncationReason: null
    };
  }

  const pageUrl = (win && win.location ? win.location.href : (doc.location ? doc.location.href : '')) || '';
  let pageOrigin = '';
  try {
    if (pageUrl) pageOrigin = new URL(pageUrl).origin;
  } catch {}

  // 1. Metadata
  if (requestedTypes.includes('metadata') && checkLimit()) {
    let title = (doc.title || '').trim();
    title = innerTruncate(title, maxFieldChars);
    accountText(title);

    let language = null;
    if (doc.documentElement && doc.documentElement.lang) {
      language = innerTruncate(doc.documentElement.lang.trim(), 50) || null;
    }

    let canonicalUrl = null;
    const canonicalEl = doc.querySelector('link[rel="canonical"]');
    if (canonicalEl && canonicalEl.getAttribute) {
      const rawCanonical = (canonicalEl.getAttribute('href') || '').trim();
      if (rawCanonical) {
        try {
          canonicalUrl = new URL(rawCanonical, pageUrl).href;
        } catch {
          canonicalUrl = rawCanonical;
        }
        canonicalUrl = innerTruncate(canonicalUrl, maxFieldChars);
        accountText(canonicalUrl);
      }
    }

    let description = null;
    const metaDesc = doc.querySelector('meta[name="description"], meta[property="og:description"]');
    if (metaDesc && metaDesc.getAttribute) {
      description = (metaDesc.getAttribute('content') || '').trim();
      if (description) {
        description = innerTruncate(description, maxFieldChars);
        accountText(description);
      } else {
        description = null;
      }
    }

    result.metadata = {
      title,
      url: innerTruncate(pageUrl, maxFieldChars),
      language,
      canonicalUrl,
      description
    };
  }

  // 2. Headings
  if (requestedTypes.includes('headings') && checkLimit()) {
    const headingEls = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (let i = 0; i < headingEls.length; i++) {
      if (!checkLimit()) break;
      const el = headingEls[i];
      if (!isVisible(el)) continue;

      const tag = (el.tagName || '').toLowerCase();
      const level = parseInt(tag.substring(1), 10) || 1;
      let text = innerCleanText(el.textContent || '');
      text = innerTruncate(text, maxFieldChars);
      accountText(text);

      result.headings.push({ level, text });
      recordCounter++;
    }
  }

  // 3. Links
  if (requestedTypes.includes('links') && checkLimit()) {
    const linkEls = doc.querySelectorAll('a[href]');
    for (let i = 0; i < linkEls.length; i++) {
      if (!checkLimit()) break;
      const el = linkEls[i];
      if (!isVisible(el)) continue;

      const rawHref = (el.getAttribute('href') || '').trim();
      let resolvedHref = rawHref;
      let sameOrigin = false;
      try {
        if (pageUrl) {
          const u = new URL(rawHref, pageUrl);
          resolvedHref = u.href;
          sameOrigin = pageOrigin ? u.origin === pageOrigin : false;
        }
      } catch {
        resolvedHref = rawHref;
      }

      let text = innerCleanText(el.textContent || '');
      text = innerTruncate(text, maxFieldChars);
      accountText(text);

      let accessibleName = null;
      const ariaLabel = el.getAttribute('aria-label');
      const titleAttr = el.getAttribute('title');
      if (ariaLabel && ariaLabel.trim()) {
        accessibleName = innerTruncate(ariaLabel.trim(), maxFieldChars);
      } else if (titleAttr && titleAttr.trim()) {
        accessibleName = innerTruncate(titleAttr.trim(), maxFieldChars);
      }

      result.links.push({
        text,
        accessibleName,
        href: innerTruncate(resolvedHref, maxFieldChars),
        sameOrigin
      });
      recordCounter++;
    }
  }

  // 4. Tables
  if (requestedTypes.includes('tables') && checkLimit()) {
    const tableEls = doc.querySelectorAll('table');
    for (let i = 0; i < tableEls.length; i++) {
      if (!checkLimit()) break;
      const table = tableEls[i];
      if (!isVisible(table)) continue;

      let caption = null;
      const captionEl = table.querySelector('caption');
      if (captionEl && isVisible(captionEl)) {
        caption = innerCleanText(captionEl.textContent || '');
        caption = innerTruncate(caption, maxFieldChars) || null;
        if (caption) accountText(caption);
      }

      let headers = [];
      let isIrregular = false;

      // Extract headers from thead th or first tr th
      const theadThs = table.querySelectorAll('thead th');
      if (theadThs.length > 0) {
        for (let h = 0; h < theadThs.length; h++) {
          const th = theadThs[h];
          let hText = innerCleanText(th.textContent || '');
          hText = innerTruncate(hText, maxFieldChars);
          accountText(hText);
          headers.push(hText);
          if ((th.getAttribute && th.getAttribute('colspan') > 1) || (th.getAttribute && th.getAttribute('rowspan') > 1)) {
            isIrregular = true;
          }
        }
      } else {
        const firstTr = table.querySelector('tr');
        if (firstTr) {
          const firstTrThs = firstTr.querySelectorAll('th');
          if (firstTrThs.length > 0) {
            for (let h = 0; h < firstTrThs.length; h++) {
              const th = firstTrThs[h];
              let hText = innerCleanText(th.textContent || '');
              hText = innerTruncate(hText, maxFieldChars);
              accountText(hText);
              headers.push(hText);
              if ((th.getAttribute && th.getAttribute('colspan') > 1) || (th.getAttribute && th.getAttribute('rowspan') > 1)) {
                isIrregular = true;
              }
            }
          }
        }
      }

      // Extract rows
      const rows = [];
      let trEls = table.querySelectorAll('tbody tr');
      if (trEls.length === 0) {
        trEls = table.querySelectorAll('tr');
      }

      for (let r = 0; r < trEls.length; r++) {
        if (!checkLimit()) break;
        const tr = trEls[r];
        if (!isVisible(tr)) continue;

        // Skip header row if already captured as headers
        if (theadThs.length === 0 && r === 0 && headers.length > 0) {
          continue;
        }

        const cells = [];
        const cellEls = tr.querySelectorAll('th, td');
        for (let c = 0; c < cellEls.length; c++) {
          const cell = cellEls[c];
          let cText = innerCleanText(cell.textContent || '');
          cText = innerTruncate(cText, maxFieldChars);
          accountText(cText);
          cells.push(cText);

          const colSpan = parseInt(cell.getAttribute ? cell.getAttribute('colspan') : 1, 10) || 1;
          const rowSpan = parseInt(cell.getAttribute ? cell.getAttribute('rowspan') : 1, 10) || 1;
          if (colSpan > 1 || rowSpan > 1) {
            isIrregular = true;
          }
        }

        if (headers.length > 0 && cells.length !== headers.length) {
          isIrregular = true;
        }

        rows.push(cells);
        recordCounter++;
      }

      // Verify row length consistency
      if (rows.length > 1) {
        const expectedLen = rows[0].length;
        for (let r = 1; r < rows.length; r++) {
          if (rows[r].length !== expectedLen) {
            isIrregular = true;
            break;
          }
        }
      }

      result.tables.push({
        caption,
        headers,
        rows,
        irregular: isIrregular
      });
      recordCounter++;
    }
  }

  // 5. Lists
  if (requestedTypes.includes('lists') && checkLimit()) {
    function extractListRecursive(listEl, depth = 1) {
      if (!isVisible(listEl)) return null;

      const tag = (listEl.tagName || '').toLowerCase();
      const isOrdered = tag === 'ol';
      const items = [];

      const childItems = [];
      const children = listEl.children || [];
      for (let i = 0; i < children.length; i++) {
        const ch = children[i];
        const cTag = (ch.tagName || '').toLowerCase();
        const role = ch.getAttribute ? ch.getAttribute('role') : null;
        if ((cTag === 'li' || role === 'listitem') && isVisible(ch)) {
          childItems.push(ch);
        }
      }

      for (let i = 0; i < childItems.length; i++) {
        if (!checkLimit()) break;
        const itemEl = childItems[i];

        // Find direct nested list
        let nestedListEl = null;
        const itemChildren = itemEl.children || [];
        for (let j = 0; j < itemChildren.length; j++) {
          const ic = itemChildren[j];
          const icTag = (ic.tagName || '').toLowerCase();
          const icRole = ic.getAttribute ? ic.getAttribute('role') : null;
          if (icTag === 'ul' || icTag === 'ol' || icRole === 'list') {
            nestedListEl = ic;
            break;
          }
        }

        let itemText = '';
        if (nestedListEl) {
          let directText = '';
          const nodes = itemEl.childNodes || [];
          for (let k = 0; k < nodes.length; k++) {
            const node = nodes[k];
            if (node !== nestedListEl) {
              directText += (node.textContent || '') + ' ';
            }
          }
          itemText = innerCleanText(directText);
        } else {
          itemText = innerCleanText(itemEl.textContent || '');
        }

        itemText = innerTruncate(itemText, maxFieldChars);
        accountText(itemText);
        recordCounter++;

        if (nestedListEl && depth < maxNestingDepth) {
          const nested = extractListRecursive(nestedListEl, depth + 1);
          items.push({
            text: itemText,
            nested
          });
        } else {
          items.push(itemText);
        }
      }

      return {
        ordered: isOrdered,
        items
      };
    }

    const allListEls = doc.querySelectorAll('ul, ol, [role="list"]');
    for (let i = 0; i < allListEls.length; i++) {
      if (!checkLimit()) break;
      const listEl = allListEls[i];
      if (!isVisible(listEl)) continue;

      // Only process top-level lists (not contained in another ul/ol/[role="list"])
      let parent = listEl.parentElement;
      let isNested = false;
      while (parent && parent !== doc.documentElement) {
        const pTag = (parent.tagName || '').toLowerCase();
        const pRole = parent.getAttribute ? parent.getAttribute('role') : null;
        if (pTag === 'ul' || pTag === 'ol' || pRole === 'list') {
          isNested = true;
          break;
        }
        parent = parent.parentElement;
      }

      if (!isNested) {
        const listObj = extractListRecursive(listEl, 1);
        if (listObj && listObj.items.length > 0) {
          result.lists.push(listObj);
        }
      }
    }
  }

  // 6. Definitions
  if (requestedTypes.includes('definitions') && checkLimit()) {
    const dlEls = doc.querySelectorAll('dl');
    for (let i = 0; i < dlEls.length; i++) {
      if (!checkLimit()) break;
      const dl = dlEls[i];
      if (!isVisible(dl)) continue;

      const children = dl.children || [];
      let currentKey = null;

      for (let j = 0; j < children.length; j++) {
        if (!checkLimit()) break;
        const el = children[j];
        if (!isVisible(el)) continue;

        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'dt') {
          currentKey = innerCleanText(el.textContent || '');
          currentKey = innerTruncate(currentKey, maxFieldChars);
        } else if (tag === 'dd') {
          let value = innerCleanText(el.textContent || '');
          value = innerTruncate(value, maxFieldChars);
          accountText(currentKey || '');
          accountText(value);

          result.definitions.push({
            key: currentKey || '',
            value
          });
          recordCounter++;
        }
      }
    }
  }

  // 7. Repeated Semantic Records
  if (requestedTypes.includes('records') && checkLimit()) {
    // Select semantic article elements or explicit record containers
    const articleEls = doc.querySelectorAll('article, [role="article"]');
    for (let i = 0; i < articleEls.length; i++) {
      if (!checkLimit()) break;
      const art = articleEls[i];
      if (!isVisible(art)) continue;

      // Extract heading
      let heading = null;
      const headingEl = art.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
      if (headingEl && isVisible(headingEl)) {
        heading = innerCleanText(headingEl.textContent || '');
        heading = innerTruncate(heading, maxFieldChars) || null;
        if (heading) accountText(heading);
      }

      // Extract paragraphs/body text (excluding heading)
      let paragraphs = [];
      const pEls = art.querySelectorAll('p');
      if (pEls.length > 0) {
        for (let p = 0; p < pEls.length; p++) {
          const pel = pEls[p];
          if (!isVisible(pel)) continue;
          let pText = innerCleanText(pel.textContent || '');
          if (pText) paragraphs.push(pText);
        }
      }

      let mainText = paragraphs.join('\n');
      if (!mainText && !heading) {
        mainText = innerCleanText(art.textContent || '');
      }
      mainText = innerTruncate(mainText, maxFieldChars);
      accountText(mainText);

      // Extract links inside record
      const recLinks = [];
      const linkEls = art.querySelectorAll('a[href]');
      for (let l = 0; l < linkEls.length; l++) {
        const link = linkEls[l];
        if (!isVisible(link)) continue;
        const rawHref = (link.getAttribute('href') || '').trim();
        let resolvedHref = rawHref;
        try {
          if (pageUrl) resolvedHref = new URL(rawHref, pageUrl).href;
        } catch {}
        let lText = innerCleanText(link.textContent || '');
        lText = innerTruncate(lText, maxFieldChars);
        recLinks.push({
          text: lText,
          href: innerTruncate(resolvedHref, maxFieldChars)
        });
      }

      // Extract fields (key/value from dl or labeled spans)
      const fields = [];
      const dlEls = art.querySelectorAll('dl');
      for (let d = 0; d < dlEls.length; d++) {
        const dl = dlEls[d];
        const dlChildren = dl.children || [];
        let k = null;
        for (let c = 0; c < dlChildren.length; c++) {
          const ch = dlChildren[c];
          if (!isVisible(ch)) continue;
          const cTag = (ch.tagName || '').toLowerCase();
          if (cTag === 'dt') {
            k = innerCleanText(ch.textContent || '');
          } else if (cTag === 'dd') {
            const v = innerCleanText(ch.textContent || '');
            if (k) {
              fields.push({
                key: innerTruncate(k, maxFieldChars),
                value: innerTruncate(v, maxFieldChars)
              });
            }
          }
        }
      }

      result.records.push({
        tag: (art.tagName || 'article').toLowerCase(),
        heading,
        text: mainText,
        links: recLinks,
        fields
      });
      recordCounter++;
    }
  }

  return {
    data: result,
    counts: {
      headings: result.headings.length,
      links: result.links.length,
      tables: result.tables.length,
      lists: result.lists.length,
      definitions: result.definitions.length,
      records: result.records.length
    },
    limits: {
      maxRecords,
      maxTextChars,
      maxFieldChars,
      maxNestingDepth
    },
    truncated: isTruncated,
    truncationReason
  };
}

/**
 * Deterministically extracts structured data from an HTML string using Cheerio (offline/unit test helper).
 *
 * @param {string} html
 * @param {Object} [options={}]
 * @returns {Object}
 */
export function extractStructuredDataFromHtml(html, options = {}) {
  const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  const limits = {
    maxRecords: options.limits?.maxRecords ?? config.browser?.extractMaxRecords ?? 500,
    maxTextChars: options.limits?.maxTextChars ?? config.browser?.extractMaxTextChars ?? 200000,
    maxFieldChars: options.limits?.maxFieldChars ?? config.browser?.extractMaxFieldChars ?? 4000,
    maxNestingDepth: options.limits?.maxNestingDepth ?? config.browser?.extractMaxNestingDepth ?? 5
  };

  const requestedTypes = Array.isArray(options.types) && options.types.length > 0
    ? options.types.map(t => String(t).toLowerCase())
    : ['metadata', 'headings', 'links', 'tables', 'lists', 'definitions', 'records'];

  const $ = cheerio.load(html || '');
  const pageUrl = options.pageUrl || 'http://127.0.0.1:8080/sample.html';
  let pageOrigin = '';
  try { pageOrigin = new URL(pageUrl).origin; } catch {}

  function isNodeVisible(el) {
    if (!el || el.type !== 'tag') return true;
    const attribs = el.attribs || {};
    if (attribs.hidden !== undefined || attribs['aria-hidden'] === 'true') return false;
    const style = (attribs.style || '').toLowerCase();
    if (style.includes('display:none') || style.includes('display: none') ||
        style.includes('visibility:hidden') || style.includes('visibility: hidden')) {
      return false;
    }
    let parent = el.parent;
    while (parent && parent.type === 'tag') {
      const pAttribs = parent.attribs || {};
      if (pAttribs.hidden !== undefined || pAttribs['aria-hidden'] === 'true') return false;
      const pStyle = (pAttribs.style || '').toLowerCase();
      if (pStyle.includes('display:none') || pStyle.includes('display: none') ||
          pStyle.includes('visibility:hidden') || pStyle.includes('visibility: hidden')) {
        return false;
      }
      parent = parent.parent;
    }
    return true;
  }

  const result = {
    metadata: null,
    headings: [],
    links: [],
    tables: [],
    lists: [],
    definitions: [],
    records: []
  };

  let recordCounter = 0;
  let textCharsCounter = 0;
  let isTruncated = false;
  let truncationReason = null;

  function checkLimit() {
    if (recordCounter >= limits.maxRecords) {
      isTruncated = true;
      if (!truncationReason) truncationReason = 'MAX_RECORDS';
      return false;
    }
    if (textCharsCounter >= limits.maxTextChars) {
      isTruncated = true;
      if (!truncationReason) truncationReason = 'MAX_TEXT_CHARS';
      return false;
    }
    return true;
  }

  function accountText(str) {
    if (typeof str === 'string') {
      textCharsCounter += str.length;
      if (textCharsCounter >= limits.maxTextChars) {
        isTruncated = true;
        if (!truncationReason) truncationReason = 'MAX_TEXT_CHARS';
      }
    }
  }

  // 1. Metadata
  if (requestedTypes.includes('metadata') && checkLimit()) {
    let title = cleanText($('title').first().text() || '');
    title = truncate(title, limits.maxFieldChars);
    accountText(title);

    let language = null;
    const langAttr = $('html').attr('lang');
    if (langAttr && langAttr.trim()) {
      language = truncate(langAttr.trim(), 50);
    }

    let canonicalUrl = null;
    const rawCanonical = ($('link[rel="canonical"]').attr('href') || '').trim();
    if (rawCanonical) {
      try {
        canonicalUrl = new URL(rawCanonical, pageUrl).href;
      } catch {
        canonicalUrl = rawCanonical;
      }
      canonicalUrl = truncate(canonicalUrl, limits.maxFieldChars);
      accountText(canonicalUrl);
    }

    let description = null;
    const rawDesc = ($('meta[name="description"], meta[property="og:description"]').attr('content') || '').trim();
    if (rawDesc) {
      description = truncate(rawDesc, limits.maxFieldChars);
      accountText(description);
    }

    result.metadata = {
      title,
      url: truncate(pageUrl, limits.maxFieldChars),
      language,
      canonicalUrl,
      description
    };
  }

  // 2. Headings
  if (requestedTypes.includes('headings') && checkLimit()) {
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      if (!checkLimit()) return false;
      if (!isNodeVisible(el)) return;
      const tag = (el.name || '').toLowerCase();
      const level = parseInt(tag.substring(1), 10) || 1;
      let text = cleanText($(el).text() || '');
      text = truncate(text, limits.maxFieldChars);
      accountText(text);
      result.headings.push({ level, text });
      recordCounter++;
    });
  }

  // 3. Links
  if (requestedTypes.includes('links') && checkLimit()) {
    $('a[href]').each((_, el) => {
      if (!checkLimit()) return false;
      if (!isNodeVisible(el)) return;
      const rawHref = ($(el).attr('href') || '').trim();
      let resolvedHref = rawHref;
      let sameOrigin = false;
      try {
        if (pageUrl) {
          const u = new URL(rawHref, pageUrl);
          resolvedHref = u.href;
          sameOrigin = pageOrigin ? u.origin === pageOrigin : false;
        }
      } catch {
        resolvedHref = rawHref;
      }

      let text = cleanText($(el).text() || '');
      text = truncate(text, limits.maxFieldChars);
      accountText(text);

      let accessibleName = null;
      const ariaLabel = $(el).attr('aria-label');
      const titleAttr = $(el).attr('title');
      if (ariaLabel && ariaLabel.trim()) {
        accessibleName = truncate(ariaLabel.trim(), limits.maxFieldChars);
      } else if (titleAttr && titleAttr.trim()) {
        accessibleName = truncate(titleAttr.trim(), limits.maxFieldChars);
      }

      result.links.push({
        text,
        accessibleName,
        href: truncate(resolvedHref, limits.maxFieldChars),
        sameOrigin
      });
      recordCounter++;
    });
  }

  // 4. Tables
  if (requestedTypes.includes('tables') && checkLimit()) {
    $('table').each((_, table) => {
      if (!checkLimit()) return false;
      if (!isNodeVisible(table)) return;

      let caption = null;
      const captionEl = $(table).find('caption').first();
      if (captionEl.length > 0 && isNodeVisible(captionEl[0])) {
        caption = cleanText(captionEl.text() || '');
        caption = truncate(caption, limits.maxFieldChars) || null;
        if (caption) accountText(caption);
      }

      let headers = [];
      let isIrregular = false;

      const theadThs = $(table).find('thead th');
      if (theadThs.length > 0) {
        theadThs.each((_, th) => {
          let hText = cleanText($(th).text() || '');
          hText = truncate(hText, limits.maxFieldChars);
          accountText(hText);
          headers.push(hText);
          const colSpan = parseInt($(th).attr('colspan') || 1, 10) || 1;
          const rowSpan = parseInt($(th).attr('rowspan') || 1, 10) || 1;
          if (colSpan > 1 || rowSpan > 1) isIrregular = true;
        });
      } else {
        const firstTr = $(table).find('tr').first();
        if (firstTr.length > 0) {
          const firstThs = firstTr.find('th');
          if (firstThs.length > 0) {
            firstThs.each((_, th) => {
              let hText = cleanText($(th).text() || '');
              hText = truncate(hText, limits.maxFieldChars);
              accountText(hText);
              headers.push(hText);
              const colSpan = parseInt($(th).attr('colspan') || 1, 10) || 1;
              const rowSpan = parseInt($(th).attr('rowspan') || 1, 10) || 1;
              if (colSpan > 1 || rowSpan > 1) isIrregular = true;
            });
          }
        }
      }

      const rows = [];
      let trEls = $(table).find('tbody tr');
      if (trEls.length === 0) {
        trEls = $(table).find('tr');
      }

      trEls.each((rIdx, tr) => {
        if (!checkLimit()) return false;
        if (!isNodeVisible(tr)) return;

        if (theadThs.length === 0 && rIdx === 0 && headers.length > 0) {
          return;
        }

        const cells = [];
        $(tr).find('th, td').each((_, cell) => {
          let cText = cleanText($(cell).text() || '');
          cText = truncate(cText, limits.maxFieldChars);
          accountText(cText);
          cells.push(cText);

          const colSpan = parseInt($(cell).attr('colspan') || 1, 10) || 1;
          const rowSpan = parseInt($(cell).attr('rowspan') || 1, 10) || 1;
          if (colSpan > 1 || rowSpan > 1) isIrregular = true;
        });

        if (headers.length > 0 && cells.length !== headers.length) {
          isIrregular = true;
        }

        rows.push(cells);
        recordCounter++;
      });

      if (rows.length > 1) {
        const expectedLen = rows[0].length;
        for (let r = 1; r < rows.length; r++) {
          if (rows[r].length !== expectedLen) {
            isIrregular = true;
            break;
          }
        }
      }

      result.tables.push({
        caption,
        headers,
        rows,
        irregular: isIrregular
      });
      recordCounter++;
    });
  }

  // 5. Lists
  if (requestedTypes.includes('lists') && checkLimit()) {
    function parseList(listEl, depth = 1) {
      if (!isNodeVisible(listEl)) return null;
      const tag = (listEl.name || '').toLowerCase();
      const isOrdered = tag === 'ol';
      const items = [];

      $(listEl).children('li, [role="listitem"]').each((_, itemEl) => {
        if (!checkLimit()) return false;
        if (!isNodeVisible(itemEl)) return;

        const nestedListEl = $(itemEl).children('ul, ol, [role="list"]').first();
        let itemText = '';
        if (nestedListEl.length > 0) {
          const clone = $(itemEl).clone();
          clone.children('ul, ol, [role="list"]').remove();
          itemText = cleanText(clone.text() || '');
        } else {
          itemText = cleanText($(itemEl).text() || '');
        }

        itemText = truncate(itemText, limits.maxFieldChars);
        accountText(itemText);
        recordCounter++;

        if (nestedListEl.length > 0 && depth < limits.maxNestingDepth) {
          const nested = parseList(nestedListEl[0], depth + 1);
          items.push({ text: itemText, nested });
        } else {
          items.push(itemText);
        }
      });

      return { ordered: isOrdered, items };
    }

    $('ul, ol, [role="list"]').each((_, listEl) => {
      if (!checkLimit()) return false;
      if (!isNodeVisible(listEl)) return;

      const isNested = $(listEl).parents('ul, ol, [role="list"]').length > 0;
      if (!isNested) {
        const listObj = parseList(listEl, 1);
        if (listObj && listObj.items.length > 0) {
          result.lists.push(listObj);
        }
      }
    });
  }

  // 6. Definitions
  if (requestedTypes.includes('definitions') && checkLimit()) {
    $('dl').each((_, dl) => {
      if (!checkLimit()) return false;
      if (!isNodeVisible(dl)) return;

      let currentKey = null;
      $(dl).children('dt, dd').each((_, el) => {
        if (!checkLimit()) return false;
        if (!isNodeVisible(el)) return;

        const tag = (el.name || '').toLowerCase();
        if (tag === 'dt') {
          currentKey = cleanText($(el).text() || '');
          currentKey = truncate(currentKey, limits.maxFieldChars);
        } else if (tag === 'dd') {
          let value = cleanText($(el).text() || '');
          value = truncate(value, limits.maxFieldChars);
          accountText(currentKey || '');
          accountText(value);

          result.definitions.push({
            key: currentKey || '',
            value
          });
          recordCounter++;
        }
      });
    });
  }

  // 7. Repeated Semantic Records
  if (requestedTypes.includes('records') && checkLimit()) {
    $('article, [role="article"]').each((_, art) => {
      if (!checkLimit()) return false;
      if (!isNodeVisible(art)) return;

      let heading = null;
      const headingEl = $(art).find('h1, h2, h3, h4, h5, h6, [role="heading"]').first();
      if (headingEl.length > 0 && isNodeVisible(headingEl[0])) {
        heading = cleanText(headingEl.text() || '');
        heading = truncate(heading, limits.maxFieldChars) || null;
        if (heading) accountText(heading);
      }

      const paragraphs = [];
      $(art).find('p').each((_, p) => {
        if (isNodeVisible(p)) {
          const pt = cleanText($(p).text() || '');
          if (pt) paragraphs.push(pt);
        }
      });

      let mainText = paragraphs.join('\n');
      if (!mainText && !heading) {
        mainText = cleanText($(art).text() || '');
      }
      mainText = truncate(mainText, limits.maxFieldChars);
      accountText(mainText);

      const recLinks = [];
      $(art).find('a[href]').each((_, l) => {
        if (!isNodeVisible(l)) return;
        const rawHref = ($(l).attr('href') || '').trim();
        let resolvedHref = rawHref;
        try { if (pageUrl) resolvedHref = new URL(rawHref, pageUrl).href; } catch {}
        let lText = cleanText($(l).text() || '');
        lText = truncate(lText, limits.maxFieldChars);
        recLinks.push({
          text: lText,
          href: truncate(resolvedHref, limits.maxFieldChars)
        });
      });

      const fields = [];
      $(art).find('dl').each((_, dl) => {
        let k = null;
        $(dl).children('dt, dd').each((_, el) => {
          if (!isNodeVisible(el)) return;
          const tag = (el.name || '').toLowerCase();
          if (tag === 'dt') {
            k = cleanText($(el).text() || '');
          } else if (tag === 'dd') {
            const v = cleanText($(el).text() || '');
            if (k) {
              fields.push({
                key: truncate(k, limits.maxFieldChars),
                value: truncate(v, limits.maxFieldChars)
              });
            }
          }
        });
      });

      result.records.push({
        tag: (art.name || 'article').toLowerCase(),
        heading,
        text: mainText,
        links: recLinks,
        fields
      });
      recordCounter++;
    });
  }

  const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  return {
    success: true,
    data: result,
    counts: {
      headings: result.headings.length,
      links: result.links.length,
      tables: result.tables.length,
      lists: result.lists.length,
      definitions: result.definitions.length,
      records: result.records.length
    },
    limits,
    truncated: isTruncated,
    truncationReason,
    durationMs: Math.max(0.001, Number((endTime - startTime).toFixed(3)))
  };
}

/**
 * Extracts structured data from a real Playwright Page or mock page (Brick 38).
 *
 * @param {Object} page - Playwright Page instance
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
export async function extractStructuredData(page, options = {}) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    throw new StructuredExtractionError('Page is closed or unavailable.', 'PAGE_CLOSED');
  }

  const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  const limits = {
    maxRecords: options.limits?.maxRecords ?? config.browser?.extractMaxRecords ?? 500,
    maxTextChars: options.limits?.maxTextChars ?? config.browser?.extractMaxTextChars ?? 200000,
    maxFieldChars: options.limits?.maxFieldChars ?? config.browser?.extractMaxFieldChars ?? 4000,
    maxNestingDepth: options.limits?.maxNestingDepth ?? config.browser?.extractMaxNestingDepth ?? 5
  };

  const evaluateOptions = {
    types: options.types,
    limits,
    _doc: options._doc,
    _win: options._win
  };

  let snapshot;
  if (typeof options.evaluator === 'function') {
    snapshot = await options.evaluator(page, evaluateOptions);
  } else if (typeof page.evaluate === 'function') {
    snapshot = await page.evaluate(extractStructuredDataSnapshot, evaluateOptions);
  } else if (typeof page.content === 'function') {
    const html = await page.content();
    snapshot = extractStructuredDataFromHtml(html, { ...evaluateOptions, pageUrl: typeof page.url === 'function' ? page.url() : '' });
  } else {
    throw new StructuredExtractionError('Page evaluate method not available.', 'BROWSER_ERROR');
  }

  const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  const durationMs = Math.max(0.001, Number((endTime - startTime).toFixed(3)));

  return {
    success: true,
    data: snapshot?.data || {
      metadata: null,
      headings: [],
      links: [],
      tables: [],
      lists: [],
      definitions: [],
      records: []
    },
    counts: snapshot?.counts || {
      headings: 0,
      links: 0,
      tables: 0,
      lists: 0,
      definitions: 0,
      records: 0
    },
    limits: snapshot?.limits || limits,
    truncated: Boolean(snapshot?.truncated),
    truncationReason: snapshot?.truncationReason || null,
    durationMs
  };
}
