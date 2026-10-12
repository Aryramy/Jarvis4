import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideBrowserEscalation,
  BrowserEscalationError,
  REASON_CODES,
  REASON_DESCRIPTIONS,
  evaluateStaticOutcome,
  MAX_BROWSER_REQUEST_LENGTH
} from '../../src/routing/browserEscalation.js';

describe('Browser Escalation Policy - Unit Tests (Brick 25)', () => {
  describe('Input Validation', () => {
    test('rejects missing or undefined request', () => {
      assert.throws(() => decideBrowserEscalation({}), {
        name: 'BrowserEscalationError',
        code: 'INVALID_REQUEST'
      });
      assert.throws(() => decideBrowserEscalation({ request: null }), {
        name: 'BrowserEscalationError',
        code: 'INVALID_REQUEST'
      });
    });

    test('rejects non-string request', () => {
      assert.throws(() => decideBrowserEscalation({ request: 12345 }), {
        name: 'BrowserEscalationError',
        code: 'INVALID_REQUEST'
      });
      assert.throws(() => decideBrowserEscalation({ request: {} }), {
        name: 'BrowserEscalationError',
        code: 'INVALID_REQUEST'
      });
      assert.throws(() => decideBrowserEscalation({ request: true }), {
        name: 'BrowserEscalationError',
        code: 'INVALID_REQUEST'
      });
    });

    test('rejects empty or whitespace-only request', () => {
      assert.throws(() => decideBrowserEscalation({ request: '' }), {
        name: 'BrowserEscalationError',
        code: 'INVALID_REQUEST'
      });
      assert.throws(() => decideBrowserEscalation({ request: '   \n\t  ' }), {
        name: 'BrowserEscalationError',
        code: 'INVALID_REQUEST'
      });
    });

    test('rejects over-limit request without silent truncation', () => {
      const longRequest = 'a'.repeat(MAX_BROWSER_REQUEST_LENGTH + 1);
      assert.throws(() => decideBrowserEscalation({ request: longRequest }), {
        name: 'BrowserEscalationError',
        code: 'REQUEST_TOO_LONG'
      });
    });
  });

  describe('Section 37: Basic Routing', () => {
    test('1. "What is Power BI?" → static', () => {
      const result = decideBrowserEscalation({ request: 'What is Power BI?' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_CONTENT_SUFFICIENT);
      assert.equal(result.source, 'request-intent');
    });

    test('2. "Search the web for Microsoft Fabric news" → static', () => {
      const result = decideBrowserEscalation({ request: 'Search the web for Microsoft Fabric news' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_SEARCH_SUFFICIENT);
      assert.equal(result.source, 'request-intent');
    });

    test('3. "Summarize https://example.com/" → static', () => {
      const result = decideBrowserEscalation({ request: 'Summarize https://example.com/' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_PAGE_READ_SUFFICIENT);
      assert.equal(result.source, 'request-intent');
    });

    test('4. "Click the Login button" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Click the Login button' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_CLICK);
      assert.equal(result.source, 'request-intent');
      assert.ok(result.matchedSignals.includes(REASON_CODES.INTERACTIVE_CLICK));
    });

    test('5. "Fill this registration form" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Fill this registration form' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_FORM_ENTRY);
      assert.equal(result.source, 'request-intent');
    });

    test('6. "Submit the form" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Submit the form' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_FORM_SUBMIT);
      assert.equal(result.source, 'request-intent');
    });

    test('7. "Log into Outlook" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Log into Outlook' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_AUTHENTICATION);
      assert.equal(result.source, 'request-intent');
    });

    test('8. "Upload this file" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Upload this file' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_FILE_UPLOAD);
      assert.equal(result.source, 'request-intent');
    });

    test('9. "Download the report from the portal" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Download the report from the portal' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_FILE_DOWNLOAD);
      assert.equal(result.source, 'request-intent');
    });

    test('10. "Select Qatar from the dropdown" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Select Qatar from the dropdown' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_CONTROL_SELECTION);
      assert.equal(result.source, 'request-intent');
    });

    test('11. "Check the checkbox" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Check the checkbox' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_CONTROL_SELECTION);
      assert.equal(result.source, 'request-intent');
    });

    test('12. "Scroll down" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Scroll down' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_SCROLL_OR_HOVER);
      assert.equal(result.source, 'request-intent');
    });

    test('13. "Open the menu and choose Settings" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Open the menu and choose Settings' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_PAGE_NAVIGATION);
      assert.equal(result.source, 'request-intent');
    });

    test('14. "Use Chrome to open this website" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Use Chrome to open this website' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.EXPLICIT_BROWSER_REQUEST);
      assert.equal(result.source, 'request-intent');
    });
  });

  describe('Section 38: False Positives (Explanations & Definitions)', () => {
    test('15. "What does click-through rate mean?" → static', () => {
      const result = decideBrowserEscalation({ request: 'What does click-through rate mean?' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_CONTENT_SUFFICIENT);
    });

    test('16. "What is a login page?" → static', () => {
      const result = decideBrowserEscalation({ request: 'What is a login page?' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_CONTENT_SUFFICIENT);
    });

    test('17. "Explain HTML form submission" → static', () => {
      const result = decideBrowserEscalation({ request: 'Explain HTML form submission' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_CONTENT_SUFFICIENT);
    });

    test('18. "What is browser automation?" → static', () => {
      const result = decideBrowserEscalation({ request: 'What is browser automation?' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_CONTENT_SUFFICIENT);
    });

    test('19. "What is file upload?" → static', () => {
      const result = decideBrowserEscalation({ request: 'What is file upload?' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_CONTENT_SUFFICIENT);
    });

    test('20. "What is a dropdown?" → static', () => {
      const result = decideBrowserEscalation({ request: 'What is a dropdown?' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_CONTENT_SUFFICIENT);
    });
  });

  describe('Section 39: Open Ambiguity', () => {
    test('21. "Open https://example.com/ and summarize it" → static', () => {
      const result = decideBrowserEscalation({ request: 'Open https://example.com/ and summarize it' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_PAGE_READ_SUFFICIENT);
    });

    test('22. "Open https://example.com/ in Chrome" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Open https://example.com/ in Chrome' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.EXPLICIT_BROWSER_REQUEST);
    });

    test('23. "Open example.com and click More Information" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Open example.com and click More Information' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_CLICK);
    });

    test('24. "Read https://example.com/" → static', () => {
      const result = decideBrowserEscalation({ request: 'Read https://example.com/' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_PAGE_READ_SUFFICIENT);
    });
  });

  describe('Section 40: Static Outcome Input', () => {
    test('25. NO_READABLE_CONTENT → browser candidate', () => {
      const result = decideBrowserEscalation({
        request: 'What does this page say?',
        staticOutcome: { success: false, stage: 'page-read', errorCode: 'NO_READABLE_CONTENT' }
      });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_NO_READABLE_CONTENT);
      assert.equal(result.source, 'static-outcome');
    });

    test('26. HTTP 401 structured outcome → browser candidate', () => {
      const result = decideBrowserEscalation({
        request: 'Read this account dashboard',
        staticOutcome: { success: false, stage: 'page-read', statusCode: 401 }
      });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.AUTHENTICATION_REQUIRED);
      assert.equal(result.source, 'static-outcome');
    });

    test('27. HTTP 403 structured outcome → browser candidate with neutral reason', () => {
      const result = decideBrowserEscalation({
        request: 'What is on this portal?',
        staticOutcome: { success: false, stage: 'page-read', statusCode: 403 }
      });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_ACCESS_CANDIDATE);
      assert.equal(result.source, 'static-outcome');
    });

    test('28. UNSUPPORTED_CONTENT_TYPE → no automatic browser escalation', () => {
      const result = decideBrowserEscalation({
        request: 'What is in this document?',
        staticOutcome: { success: false, stage: 'page-read', errorCode: 'UNSUPPORTED_CONTENT_TYPE' }
      });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.UNSUPPORTED_STATIC_FAILURE);
      assert.equal(result.source, 'static-outcome');
    });

    test('29. LOCAL_OR_PRIVATE_HOST_BLOCKED → no browser escalation', () => {
      const result = decideBrowserEscalation({
        request: 'What is at http://127.0.0.1/admin?',
        staticOutcome: { success: false, stage: 'page-read', errorCode: 'LOCAL_OR_PRIVATE_HOST_BLOCKED' }
      });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.UNSUPPORTED_STATIC_FAILURE);
      assert.equal(result.source, 'static-outcome');
    });

    test('30. INSECURE_REDIRECT_DOWNGRADE → no browser escalation', () => {
      const result = decideBrowserEscalation({
        request: 'What does this page say?',
        staticOutcome: { success: false, stage: 'page-read', errorCode: 'INSECURE_REDIRECT_DOWNGRADE' }
      });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.UNSUPPORTED_STATIC_FAILURE);
      assert.equal(result.source, 'static-outcome');
    });

    test('31. INVALID_URL → no browser escalation', () => {
      const result = decideBrowserEscalation({
        request: 'Check this link',
        staticOutcome: { success: false, stage: 'page-read', errorCode: 'INVALID_URL' }
      });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.UNSUPPORTED_STATIC_FAILURE);
      assert.equal(result.source, 'static-outcome');
    });

    test('32. DNS_RESOLUTION_FAILED → no browser escalation', () => {
      const result = decideBrowserEscalation({
        request: 'Summarize this page',
        staticOutcome: { success: false, stage: 'page-read', errorCode: 'DNS_RESOLUTION_FAILED' }
      });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.UNSUPPORTED_STATIC_FAILURE);
      assert.equal(result.source, 'static-outcome');
    });

    test('33. PAGE_TOO_LARGE → no browser escalation', () => {
      const result = decideBrowserEscalation({
        request: 'Summarize this massive page',
        staticOutcome: { success: false, stage: 'page-read', errorCode: 'PAGE_TOO_LARGE' }
      });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.UNSUPPORTED_STATIC_FAILURE);
      assert.equal(result.source, 'static-outcome');
    });

    test('34. FETCH_TIMEOUT → no browser escalation', () => {
      const result = decideBrowserEscalation({
        request: 'Summarize this slow page',
        staticOutcome: { success: false, stage: 'page-read', errorCode: 'FETCH_TIMEOUT' }
      });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.UNSUPPORTED_STATIC_FAILURE);
      assert.equal(result.source, 'static-outcome');
    });
  });

  describe('Section 41: Intent Priority', () => {
    test('35. explicit click + static success → browser', () => {
      const result = decideBrowserEscalation({
        request: 'Click the Continue button',
        staticOutcome: { success: true, page: { title: 'Some Page' } }
      });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_CLICK);
      assert.equal(result.source, 'request-intent');
    });

    test('36. explicit login + unsupported PDF → browser because request intent wins', () => {
      const result = decideBrowserEscalation({
        request: 'Log into Outlook and view recent messages',
        staticOutcome: { success: false, errorCode: 'UNSUPPORTED_CONTENT_TYPE' }
      });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_AUTHENTICATION);
      assert.equal(result.source, 'request-intent');
    });

    test('37. explicit browser request + DNS failure → browser decision based on explicit request', () => {
      const result = decideBrowserEscalation({
        request: 'Use Chrome to navigate to internal-wiki',
        staticOutcome: { success: false, errorCode: 'DNS_RESOLUTION_FAILED' }
      });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.EXPLICIT_BROWSER_REQUEST);
      assert.equal(result.source, 'request-intent');
    });

    test('38. ordinary informational request + static success → static', () => {
      const result = decideBrowserEscalation({
        request: 'What are the key points of NIST AI RMF?',
        staticOutcome: { success: true, page: { title: 'NIST AI RMF' } }
      });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_CONTENT_SUFFICIENT);
      assert.equal(result.source, 'request-intent');
    });
  });

  describe('Section 42: Multilingual Tests — Urdu', () => {
    test('39. "اس بٹن پر کلک کریں" → browser', () => {
      const result = decideBrowserEscalation({ request: 'اس بٹن پر کلک کریں' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_CLICK);
      assert.equal(result.source, 'request-intent');
    });

    test('40. "فارم بھریں" → browser', () => {
      const result = decideBrowserEscalation({ request: 'فارم بھریں' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_FORM_ENTRY);
      assert.equal(result.source, 'request-intent');
    });

    test('41. "Outlook میں لاگ ان کریں" → browser', () => {
      const result = decideBrowserEscalation({ request: 'Outlook میں لاگ ان کریں' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_AUTHENTICATION);
      assert.equal(result.source, 'request-intent');
    });

    test('42. "Microsoft Fabric کیا ہے؟" → static', () => {
      const result = decideBrowserEscalation({ request: 'Microsoft Fabric کیا ہے؟' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_CONTENT_SUFFICIENT);
      assert.equal(result.source, 'request-intent');
    });

    test('43. "Microsoft Fabric کی تازہ ترین خبریں تلاش کریں" → static/search-capable', () => {
      const result = decideBrowserEscalation({ request: 'Microsoft Fabric کی تازہ ترین خبریں تلاش کریں' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_SEARCH_SUFFICIENT);
      assert.equal(result.source, 'request-intent');
    });
  });

  describe('Section 43: Multilingual Tests — Arabic', () => {
    test('44. "انقر على زر تسجيل الدخول" → browser', () => {
      const result = decideBrowserEscalation({ request: 'انقر على زر تسجيل الدخول' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_CLICK);
      assert.equal(result.source, 'request-intent');
    });

    test('45. "املأ النموذج" → browser', () => {
      const result = decideBrowserEscalation({ request: 'املأ النموذج' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_FORM_ENTRY);
      assert.equal(result.source, 'request-intent');
    });

    test('46. "سجل الدخول إلى Outlook" → browser', () => {
      const result = decideBrowserEscalation({ request: 'سجل الدخول إلى Outlook' });
      assert.equal(result.browserRequired, true);
      assert.equal(result.route, 'browser');
      assert.equal(result.reasonCode, REASON_CODES.INTERACTIVE_AUTHENTICATION);
      assert.equal(result.source, 'request-intent');
    });

    test('47. "ما هو Microsoft Fabric؟" → static', () => {
      const result = decideBrowserEscalation({ request: 'ما هو Microsoft Fabric؟' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_CONTENT_SUFFICIENT);
      assert.equal(result.source, 'request-intent');
    });

    test('48. "ابحث عن أحدث أخبار Microsoft Fabric" → static/search-capable', () => {
      const result = decideBrowserEscalation({ request: 'ابحث عن أحدث أخبار Microsoft Fabric' });
      assert.equal(result.browserRequired, false);
      assert.equal(result.route, 'static');
      assert.equal(result.reasonCode, REASON_CODES.STATIC_SEARCH_SUFFICIENT);
      assert.equal(result.source, 'request-intent');
    });
  });
});
