/**
 * Observation Sanitizer for JARVIS4 Runtime Agent Harness (PRE-040A).
 * Sanitizes all browser results before they can be observed by the caller or model.
 *
 * Invariants:
 * - Redacts passwords, OTPs, cookies, tokens, auth headers, DPAPI keys, API keys.
 * - Sanitizes absolute Windows/file paths to safe basenames.
 * - Strips raw Playwright objects (Page, ElementHandle, Browser).
 * - Encloses extracted page text and element data inside machine-readable untrusted data wrappers:
 *   { trust: 'untrusted_web_data', source: 'page', content: ... }
 */

import path from 'node:path';

const SENSITIVE_KEYS = Object.freeze(new Set([
  'password',
  'pass',
  'pwd',
  'otp',
  'cookie',
  'cookies',
  'token',
  'tokens',
  'storagestate',
  'authorization',
  'auth',
  'apikey',
  'dpapi',
  'confirmationtoken',
  'privatekey',
  'secret'
]));

const UNTRUSTED_KEYS = Object.freeze(new Set([
  'visibletext',
  'text',
  'label',
  'accessiblename',
  'placeholder',
  'heading',
  'description',
  'extracteddata',
  'elements',
  'tables',
  'lists',
  'records',
  'definitions'
]));

/**
 * Strips Windows or POSIX absolute file paths, leaving only the safe file basename.
 * Example: "C:\Users\arehman\Documents\report.pdf" -> "report.pdf"
 *
 * @param {string} str
 * @returns {string}
 */
export function sanitizeFilePath(str) {
  if (typeof str !== 'string') return str;
  // Match Windows drive paths (e.g. C:\... or C:/...) or absolute POSIX paths (/...)
  if (/^[a-zA-Z]:[/\\]/.test(str) || str.startsWith('/') || str.startsWith('\\')) {
    try {
      return path.basename(str);
    } catch {
      return '[SANITIZED_PATH]';
    }
  }
  return str;
}

/**
 * Explicitly wraps passive web data in a machine-readable untrusted envelope.
 *
 * @param {*} content
 * @param {string} [source='page']
 * @returns {Object}
 */
export function markUntrustedWebData(content, source = 'page') {
  return {
    trust: 'untrusted_web_data',
    source,
    content
  };
}

/**
 * Deeply sanitizes an arbitrary result payload.
 *
 * @param {*} val
 * @param {string} [keyName='']
 * @returns {*}
 */
export function sanitizeObservation(val, keyName = '') {
  if (val === null || val === undefined) {
    return val;
  }

  // Handle primitives
  if (typeof val === 'string') {
    return sanitizeFilePath(val);
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return val;
  }

  // Strip functions, promises, symbols
  if (typeof val === 'function' || typeof val === 'symbol' || (typeof val === 'object' && typeof val.then === 'function')) {
    return undefined;
  }

  // Handle arrays
  if (Array.isArray(val)) {
    const sanitizedArr = [];
    for (let i = 0; i < val.length; i++) {
      const item = sanitizeObservation(val[i], keyName);
      if (item !== undefined) {
        sanitizedArr.push(item);
      }
    }
    return sanitizedArr;
  }

  // Handle Playwright internal handles
  if (typeof val.evaluate === 'function' || typeof val.asElement === 'function' || (typeof val.screenshot === 'function' && typeof val.goto === 'function')) {
    return '[BROWSER_HANDLE_REDACTED]';
  }

  // Handle objects
  const sanitizedObj = {};
  for (const rawKey of Object.keys(val)) {
    const lowerKey = rawKey.toLowerCase().replace(/[^a-z0-9]/g, '');

    // 1. Redact sensitive credential keys
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitizedObj[rawKey] = '[REDACTED]';
      continue;
    }

    // 2. Mark untrusted page content keys
    if (UNTRUSTED_KEYS.has(lowerKey)) {
      const cleaned = sanitizeObservation(val[rawKey], rawKey);
      if (cleaned && typeof cleaned === 'object' && cleaned.trust === 'untrusted_web_data') {
        sanitizedObj[rawKey] = cleaned;
      } else {
        sanitizedObj[rawKey] = markUntrustedWebData(cleaned, 'page');
      }
      continue;
    }

    const cleanedVal = sanitizeObservation(val[rawKey], rawKey);
    if (cleanedVal !== undefined) {
      sanitizedObj[rawKey] = cleanedVal;
    }
  }

  return sanitizedObj;
}
