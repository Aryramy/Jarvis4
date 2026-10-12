/**
 * Page Understanding & Inspection module for JARVIS4 (Brick 28).
 * Provides read-only observation of visible page text and structured element inventory.
 *
 * Strict invariants:
 * - Read-only observation only: zero click, zero type, zero navigation, zero reload.
 * - Main document only: no iframe or shadow DOM orchestration.
 * - Input privacy: zero field values returned (no passwords, emails, text values, CSRF tokens).
 * - Safe limits: visible text and element inventory bounded to configured limits.
 * - No actionable selectors: zero CSS/XPath selectors or backend handles exposed.
 * - Untrusted content: webpage contents are treated purely as observational data, never system instructions.
 * - Deterministic: 0 AI calls, 0 search calls.
 */

import * as cheerio from 'cheerio';

/**
 * Normalizes text whitespace conservatively while preserving line structure and Unicode characters.
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
 * Deterministically truncates a string to a maximum character limit.
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
export function truncate(str, max) {
  if (typeof str !== 'string') return '';
  return str.length > max ? str.slice(0, max) : str;
}

/**
 * DOM snapshot extractor designed to execute inside a browser page context (via page.evaluate)
 * or with a DOM-compatible document object.
 *
 * NOTE: This function must be completely self-contained because Playwright serializes it.
 *
 * @param {Object} [limits={}]
 * @param {number} [limits.maxTextChars=12000]
 * @param {number} [limits.maxElements=100]
 * @param {number} [limits.maxElementTextChars=300]
 * @returns {{
 *   visibleText: string,
 *   textTruncated: boolean,
 *   elements: Array<Object>,
 *   returnedElementCount: number,
 *   totalEligibleElementCount: number,
 *   elementsTruncated: boolean
 * }}
 */
export function extractDomSnapshot(limits = {}) {
  const maxTextChars = Math.max(1, Number(limits.maxTextChars || 12000));
  const maxElements = Math.max(1, Number(limits.maxElements || 100));
  const maxElementTextChars = Math.max(1, Number(limits.maxElementTextChars || 300));

  const doc = typeof document !== 'undefined' ? document : (limits && limits._doc);
  const win = typeof window !== 'undefined' ? window : (limits && limits._win);

  if (!doc) {
    return {
      visibleText: '',
      textTruncated: false,
      elements: [],
      returnedElementCount: 0,
      totalEligibleElementCount: 0,
      elementsTruncated: false
    };
  }

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
    if (!el || el.nodeType !== 1) return false;

    const tag = (el.tagName || '').toLowerCase();
    if (['script', 'style', 'template', 'noscript', 'svg', 'canvas'].includes(tag)) {
      return false;
    }

    if (el.hasAttribute && (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true')) {
      return false;
    }

    if (tag === 'input' && el.getAttribute && (el.getAttribute('type') || '').toLowerCase() === 'hidden') {
      return false;
    }

    if (win && typeof win.getComputedStyle === 'function') {
      try {
        const style = win.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
          return false;
        }
      } catch {}
    } else if (el.style) {
      if (el.style.display === 'none' || el.style.visibility === 'hidden' || el.style.visibility === 'collapse') {
        return false;
      }
    }

    // Zero-size non-visible UI check
    if (typeof el.getClientRects === 'function') {
      const rects = el.getClientRects();
      if (rects.length === 0 && el.offsetWidth === 0 && el.offsetHeight === 0) {
        return false;
      }
    } else if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.clientWidth === 0 && el.clientHeight === 0) {
      if (el.hasAttribute && ((el.getAttribute('style') || '').includes('display:none') || (el.getAttribute('style') || '').includes('visibility:hidden'))) {
        return false;
      }
    }

    // Parent visibility check
    let parent = el.parentElement;
    while (parent && parent !== doc.documentElement) {
      const pTag = (parent.tagName || '').toLowerCase();
      if (['template', 'script', 'style', 'noscript'].includes(pTag)) {
        return false;
      }
      if (parent.hasAttribute && (parent.hasAttribute('hidden') || parent.getAttribute('aria-hidden') === 'true')) {
        return false;
      }
      if (win && typeof win.getComputedStyle === 'function') {
        try {
          const pStyle = win.getComputedStyle(parent);
          if (pStyle.display === 'none' || pStyle.visibility === 'hidden') {
            return false;
          }
        } catch {}
      } else if (parent.style) {
        if (parent.style.display === 'none' || parent.style.visibility === 'hidden') {
          return false;
        }
      }
      parent = parent.parentElement;
    }

    return true;
  }

  function findAssociatedLabel(el) {
    if (!el || !doc) return undefined;

    // Check aria-labelledby
    if (el.getAttribute && el.getAttribute('aria-labelledby')) {
      const labelledById = el.getAttribute('aria-labelledby');
      if (doc.getElementById) {
        const labelEl = doc.getElementById(labelledById);
        if (labelEl) {
          const txt = innerCleanText(labelEl.innerText || labelEl.textContent || '');
          if (txt) return innerTruncate(txt, maxElementTextChars);
        }
      }
    }

    // Check <label for="id">
    const id = el.id || (el.getAttribute && el.getAttribute('id'));
    if (id && doc.querySelector) {
      try {
        const labelEl = doc.querySelector(`label[for="${id}"]`);
        if (labelEl) {
          const txt = innerCleanText(labelEl.innerText || labelEl.textContent || '');
          if (txt) return innerTruncate(txt, maxElementTextChars);
        }
      } catch {}
    }

    // Check enclosing <label>
    if (typeof el.closest === 'function') {
      const parentLabel = el.closest('label');
      if (parentLabel) {
        const txt = innerCleanText(parentLabel.innerText || parentLabel.textContent || '');
        if (txt) return innerTruncate(txt, maxElementTextChars);
      }
    }

    return undefined;
  }

  function getVisibleTextFromDom(root) {
    if (!root) return '';
    if (root.nodeType === 3) {
      return root.nodeValue || '';
    }
    if (root.nodeType === 1) {
      if (!isVisible(root)) return '';
      let text = '';
      const children = root.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        text += getVisibleTextFromDom(children[i]) + ' ';
      }
      return text;
    }
    return '';
  }

  // 1. Visible Text Extraction
  let rawText = '';
  if (doc.body && typeof doc.body.innerText === 'string' && doc.body.innerText.length > 0) {
    rawText = doc.body.innerText;
  } else {
    rawText = getVisibleTextFromDom(doc.body || doc.documentElement);
  }

  const cleanedVisibleText = innerCleanText(rawText);
  let visibleText = cleanedVisibleText;
  let textTruncated = false;

  if (visibleText.length > maxTextChars) {
    visibleText = visibleText.slice(0, maxTextChars);
    textTruncated = true;
  }

  // 2. Element Inventory
  const elements = [];
  let totalEligibleElementCount = 0;

  let candidates = [];
  if (typeof doc.querySelectorAll === 'function') {
    candidates = Array.from(doc.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, a, button, input, textarea, select, form, [role="heading"], [role="link"], [role="button"]'
    ));
  }

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (!isVisible(el)) continue;

    const tag = (el.tagName || '').toLowerCase();
    const roleAttr = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();

    let kind = null;
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag) || roleAttr === 'heading') {
      kind = 'heading';
    } else if (tag === 'a' || roleAttr === 'link') {
      kind = 'link';
    } else if (tag === 'button' || roleAttr === 'button') {
      kind = 'button';
    } else if (tag === 'input') {
      kind = 'input';
    } else if (tag === 'textarea') {
      kind = 'textarea';
    } else if (tag === 'select') {
      kind = 'select';
    } else if (tag === 'form') {
      kind = 'form';
    }

    if (!kind) continue;

    const record = { kind, tag };

    if (roleAttr && roleAttr.length > 0) {
      record.role = roleAttr;
    }

    const ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
    if (ariaLabel && ariaLabel.trim().length > 0) {
      record.ariaLabel = innerTruncate(innerCleanText(ariaLabel), maxElementTextChars);
    }

    if (kind === 'heading' || kind === 'link' || kind === 'button') {
      const rawElText = el.innerText || el.textContent || '';
      const cleanedElText = innerCleanText(rawElText);
      if (cleanedElText.length > 0) {
        record.text = innerTruncate(cleanedElText, maxElementTextChars);
      }
    }

    if (kind === 'link') {
      const href = el.getAttribute ? el.getAttribute('href') : null;
      if (typeof href === 'string') {
        record.href = href;
      }
    }

    if (kind === 'button') {
      const isDisabled = Boolean(el.disabled || (el.hasAttribute && el.hasAttribute('disabled')) || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'));
      if (isDisabled) {
        record.disabled = true;
      }
    }

    if (kind === 'input') {
      const inputType = ((el.getAttribute ? el.getAttribute('type') : null) || el.type || 'text').toLowerCase();
      record.inputType = inputType;

      const name = el.getAttribute ? el.getAttribute('name') : null;
      if (name) record.name = name;

      const placeholder = el.getAttribute ? el.getAttribute('placeholder') : null;
      if (placeholder) record.placeholder = placeholder;

      const label = findAssociatedLabel(el);
      if (label) record.label = label;

      const isRequired = Boolean(el.required || (el.hasAttribute && el.hasAttribute('required')) || (el.getAttribute && el.getAttribute('aria-required') === 'true'));
      if (isRequired) record.required = true;

      const isDisabled = Boolean(el.disabled || (el.hasAttribute && el.hasAttribute('disabled')) || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'));
      if (isDisabled) record.disabled = true;

      if (inputType === 'checkbox' || inputType === 'radio') {
        record.checked = Boolean(el.checked || (el.hasAttribute && el.hasAttribute('checked')));
      }
      // STRICT PRIVACY: NEVER RECORD `value`!
    }

    if (kind === 'textarea') {
      const name = el.getAttribute ? el.getAttribute('name') : null;
      if (name) record.name = name;

      const placeholder = el.getAttribute ? el.getAttribute('placeholder') : null;
      if (placeholder) record.placeholder = placeholder;

      const label = findAssociatedLabel(el);
      if (label) record.label = label;

      const isRequired = Boolean(el.required || (el.hasAttribute && el.hasAttribute('required')) || (el.getAttribute && el.getAttribute('aria-required') === 'true'));
      if (isRequired) record.required = true;

      const isDisabled = Boolean(el.disabled || (el.hasAttribute && el.hasAttribute('disabled')) || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'));
      if (isDisabled) record.disabled = true;
      // STRICT PRIVACY: NEVER RECORD `value`!
    }

    if (kind === 'select') {
      const name = el.getAttribute ? el.getAttribute('name') : null;
      if (name) record.name = name;

      const label = findAssociatedLabel(el);
      if (label) record.label = label;

      const isRequired = Boolean(el.required || (el.hasAttribute && el.hasAttribute('required')) || (el.getAttribute && el.getAttribute('aria-required') === 'true'));
      if (isRequired) record.required = true;

      const isDisabled = Boolean(el.disabled || (el.hasAttribute && el.hasAttribute('disabled')) || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'));
      if (isDisabled) record.disabled = true;

      if (el.options && typeof el.selectedIndex === 'number' && el.selectedIndex >= 0 && el.options[el.selectedIndex]) {
        const opt = el.options[el.selectedIndex];
        const optText = innerCleanText(opt.innerText || opt.textContent || opt.text || '');
        if (optText) record.selectedText = innerTruncate(optText, maxElementTextChars);
      }
    }

    if (kind === 'form') {
      const method = ((el.getAttribute ? el.getAttribute('method') : null) || el.method || 'GET').toUpperCase();
      record.method = method;

      const action = (el.getAttribute ? el.getAttribute('action') : null) || (typeof el.action === 'string' ? el.action : undefined);
      if (action) record.action = action;

      let fieldCount = 0;
      if (typeof el.querySelectorAll === 'function') {
        const formFields = el.querySelectorAll('input:not([type="hidden"]), textarea, select, button');
        fieldCount = formFields.length;
      }
      record.fieldCount = fieldCount;
      // STRICT PRIVACY: NEVER RECORD submitted fields or hidden tokens!
    }

    totalEligibleElementCount++;

    if (elements.length < maxElements) {
      elements.push(record);
    }
  }

  return {
    visibleText,
    textTruncated,
    elements,
    returnedElementCount: elements.length,
    totalEligibleElementCount,
    elementsTruncated: totalEligibleElementCount > maxElements
  };
}

/**
 * Inspects a static HTML string using Cheerio for deterministic offline testing.
 * Implements the exact same visible text and element inventory contract.
 *
 * @param {string} html
 * @param {Object} [options={}]
 * @param {number} [options.maxTextChars=12000]
 * @param {number} [options.maxElements=100]
 * @param {number} [options.maxElementTextChars=300]
 * @returns {{
 *   visibleText: string,
 *   textTruncated: boolean,
 *   elements: Array<Object>,
 *   returnedElementCount: number,
 *   totalEligibleElementCount: number,
 *   elementsTruncated: boolean
 * }}
 */
export function inspectHtmlString(html, options = {}) {
  const maxTextChars = Math.max(1, Number(options.maxTextChars || 12000));
  const maxElements = Math.max(1, Number(options.maxElements || 100));
  const maxElementTextChars = Math.max(1, Number(options.maxElementTextChars || 300));

  if (typeof html !== 'string' || html.trim().length === 0) {
    return {
      visibleText: '',
      textTruncated: false,
      elements: [],
      returnedElementCount: 0,
      totalEligibleElementCount: 0,
      elementsTruncated: false
    };
  }

  const $ = cheerio.load(html);

  function isNodeVisible(el) {
    if (!el || el.type !== 'tag') return false;
    const name = el.name.toLowerCase();

    if (['script', 'style', 'template', 'noscript', 'svg', 'canvas'].includes(name)) {
      return false;
    }

    const attribs = el.attribs || {};
    if (attribs.hidden !== undefined || attribs['aria-hidden'] === 'true') {
      return false;
    }

    if (name === 'input' && (attribs.type || '').toLowerCase() === 'hidden') {
      return false;
    }

    const style = (attribs.style || '').toLowerCase();
    if (style.includes('display:none') || style.includes('display: none') ||
        style.includes('visibility:hidden') || style.includes('visibility: hidden') ||
        style.includes('visibility:collapse') || style.includes('visibility: collapse') ||
        style.includes('width:0;height:0') || style.includes('width: 0; height: 0')) {
      return false;
    }

    // Check ancestor visibility
    let parent = el.parent;
    while (parent && parent.type === 'tag') {
      const pName = (parent.name || '').toLowerCase();
      if (['template', 'script', 'style', 'noscript'].includes(pName)) {
        return false;
      }
      const pAttribs = parent.attribs || {};
      if (pAttribs.hidden !== undefined || pAttribs['aria-hidden'] === 'true') {
        return false;
      }
      const pStyle = (pAttribs.style || '').toLowerCase();
      if (pStyle.includes('display:none') || pStyle.includes('display: none') ||
          pStyle.includes('visibility:hidden') || pStyle.includes('visibility: hidden')) {
        return false;
      }
      parent = parent.parent;
    }

    return true;
  }

  // 1. Visible Text
  const cloned$ = cheerio.load(html);
  cloned$('script, style, template, noscript, svg, canvas, textarea').remove();
  cloned$('[hidden], [aria-hidden="true"]').remove();
  cloned$('input[type="hidden"]').remove();
  cloned$('*').each((_, el) => {
    const s = (el.attribs?.style || '').toLowerCase();
    if (s.includes('display:none') || s.includes('display: none') ||
        s.includes('visibility:hidden') || s.includes('visibility: hidden')) {
      cloned$(el).remove();
    }
  });

  const rawText = cloned$('body').length > 0 ? cloned$('body').text() : cloned$.root().text();
  const cleanedVisibleText = cleanText(rawText);
  let visibleText = cleanedVisibleText;
  let textTruncated = false;

  if (visibleText.length > maxTextChars) {
    visibleText = visibleText.slice(0, maxTextChars);
    textTruncated = true;
  }

  // 2. Element Inventory
  const elements = [];
  let totalEligibleElementCount = 0;

  // Template, script, style, and noscript elements and their contents are inert/non-rendered
  $('template, script, style, noscript').remove();

  const candidateSelector = 'h1, h2, h3, h4, h5, h6, a, button, input, textarea, select, form, [role="heading"], [role="link"], [role="button"]';
  const $candidates = $(candidateSelector);

  $candidates.each((_, el) => {
    if (!isNodeVisible(el)) return;

    const tag = el.name.toLowerCase();
    const attribs = el.attribs || {};
    const roleAttr = (attribs.role || '').toLowerCase();

    let kind = null;
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag) || roleAttr === 'heading') {
      kind = 'heading';
    } else if (tag === 'a' || roleAttr === 'link') {
      kind = 'link';
    } else if (tag === 'button' || roleAttr === 'button') {
      kind = 'button';
    } else if (tag === 'input') {
      kind = 'input';
    } else if (tag === 'textarea') {
      kind = 'textarea';
    } else if (tag === 'select') {
      kind = 'select';
    } else if (tag === 'form') {
      kind = 'form';
    }

    if (!kind) return;

    const record = { kind, tag };

    if (roleAttr.length > 0) {
      record.role = roleAttr;
    }

    if (attribs['aria-label'] && attribs['aria-label'].trim().length > 0) {
      record.ariaLabel = truncate(cleanText(attribs['aria-label']), maxElementTextChars);
    }

    if (kind === 'heading' || kind === 'link' || kind === 'button') {
      const rawElText = $(el).text();
      const cleanedElText = cleanText(rawElText);
      if (cleanedElText.length > 0) {
        record.text = truncate(cleanedElText, maxElementTextChars);
      }
    }

    if (kind === 'link') {
      if (attribs.href !== undefined) {
        record.href = attribs.href;
      }
    }

    if (kind === 'button') {
      if (attribs.disabled !== undefined || attribs['aria-disabled'] === 'true') {
        record.disabled = true;
      }
    }

    function findLabel() {
      // Check aria-labelledby
      if (attribs['aria-labelledby']) {
        const labelEl = $(`#${attribs['aria-labelledby']}`);
        if (labelEl.length > 0) {
          const t = cleanText(labelEl.text());
          if (t) return truncate(t, maxElementTextChars);
        }
      }
      // Check <label for="...">
      if (attribs.id) {
        const labelEl = $(`label[for="${attribs.id}"]`);
        if (labelEl.length > 0) {
          const t = cleanText(labelEl.text());
          if (t) return truncate(t, maxElementTextChars);
        }
      }
      // Check wrapping <label>
      const parentLabel = $(el).closest('label');
      if (parentLabel.length > 0) {
        const t = cleanText(parentLabel.text());
        if (t) return truncate(t, maxElementTextChars);
      }
      return undefined;
    }

    if (kind === 'input') {
      const inputType = (attribs.type || 'text').toLowerCase();
      record.inputType = inputType;

      if (attribs.name) record.name = attribs.name;
      if (attribs.placeholder) record.placeholder = attribs.placeholder;

      const label = findLabel();
      if (label) record.label = label;

      if (attribs.required !== undefined || attribs['aria-required'] === 'true') {
        record.required = true;
      }
      if (attribs.disabled !== undefined || attribs['aria-disabled'] === 'true') {
        record.disabled = true;
      }
      if (inputType === 'checkbox' || inputType === 'radio') {
        record.checked = attribs.checked !== undefined;
      }
      // STRICT PRIVACY: NEVER RECORD `value`!
    }

    if (kind === 'textarea') {
      if (attribs.name) record.name = attribs.name;
      if (attribs.placeholder) record.placeholder = attribs.placeholder;

      const label = findLabel();
      if (label) record.label = label;

      if (attribs.required !== undefined || attribs['aria-required'] === 'true') {
        record.required = true;
      }
      if (attribs.disabled !== undefined || attribs['aria-disabled'] === 'true') {
        record.disabled = true;
      }
      // STRICT PRIVACY: NEVER RECORD `value`!
    }

    if (kind === 'select') {
      if (attribs.name) record.name = attribs.name;

      const label = findLabel();
      if (label) record.label = label;

      if (attribs.required !== undefined || attribs['aria-required'] === 'true') {
        record.required = true;
      }
      if (attribs.disabled !== undefined || attribs['aria-disabled'] === 'true') {
        record.disabled = true;
      }

      const selectedOpt = $(el).find('option[selected]').first();
      const fallbackOpt = $(el).find('option').first();
      const targetOpt = selectedOpt.length > 0 ? selectedOpt : fallbackOpt;
      if (targetOpt.length > 0) {
        const optText = cleanText(targetOpt.text());
        if (optText) record.selectedText = truncate(optText, maxElementTextChars);
      }
    }

    if (kind === 'form') {
      record.method = (attribs.method || 'GET').toUpperCase();
      if (attribs.action) record.action = attribs.action;

      const formFields = $(el).find('input:not([type="hidden"]), textarea, select, button');
      record.fieldCount = formFields.length;
      // STRICT PRIVACY: NEVER RECORD submitted fields or hidden tokens!
    }

    totalEligibleElementCount++;

    if (elements.length < maxElements) {
      elements.push(record);
    }
  });

  return {
    visibleText,
    textTruncated,
    elements,
    returnedElementCount: elements.length,
    totalEligibleElementCount,
    elementsTruncated: totalEligibleElementCount > maxElements
  };
}

export default {
  cleanText,
  truncate,
  extractDomSnapshot,
  inspectHtmlString
};
