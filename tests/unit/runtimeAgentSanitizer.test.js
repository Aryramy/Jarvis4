import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeFilePath,
  markUntrustedWebData,
  sanitizeObservation
} from '../../src/agent/runtime/observationSanitizer.js';

describe('Observation Sanitizer Unit Tests (PRE-040A)', () => {
  describe('File Path Sanitization', () => {
    it('strips absolute Windows backslash path to basename', () => {
      const sanitized = sanitizeFilePath('C:\\Users\\arehman\\Desktop\\AI Projects\\Jarvis4\\package.json');
      assert.strictEqual(sanitized, 'package.json');
    });

    it('strips absolute Windows forward-slash path to basename', () => {
      const sanitized = sanitizeFilePath('c:/Users/arehman/secrets/id_rsa');
      assert.strictEqual(sanitized, 'id_rsa');
    });

    it('strips absolute POSIX path to basename', () => {
      const sanitized = sanitizeFilePath('/etc/shadow');
      assert.strictEqual(sanitized, 'shadow');
    });

    it('leaves relative paths and plain names unchanged', () => {
      assert.strictEqual(sanitizeFilePath('upload.pdf'), 'upload.pdf');
      assert.strictEqual(sanitizeFilePath('Hello world'), 'Hello world');
    });
  });

  describe('Untrusted Web Data Envelope', () => {
    it('creates machine-readable untrusted web data envelope', () => {
      const wrapped = markUntrustedWebData('Welcome to our site', 'page');
      assert.deepStrictEqual(wrapped, {
        trust: 'untrusted_web_data',
        source: 'page',
        content: 'Welcome to our site'
      });
    });
  });

  describe('Observation Sanitization', () => {
    it('redacts sensitive keys in object trees', () => {
      const payload = {
        status: 'success',
        password: 'super-secret-password-123',
        otp: '987654',
        token: 'eyJh...',
        cookie: 'session=xyz',
        cookies: [{ name: 'auth', value: 'secret' }],
        authorization: 'Bearer token',
        dpapi: 'raw-bytes',
        confirmationToken: 'single-use-token',
        nested: {
          secret: 'private-data',
          apiKey: 'AIzaSy...'
        }
      };

      const sanitized = sanitizeObservation(payload);
      assert.strictEqual(sanitized.status, 'success');
      assert.strictEqual(sanitized.password, '[REDACTED]');
      assert.strictEqual(sanitized.otp, '[REDACTED]');
      assert.strictEqual(sanitized.token, '[REDACTED]');
      assert.strictEqual(sanitized.cookie, '[REDACTED]');
      assert.strictEqual(sanitized.cookies, '[REDACTED]');
      assert.strictEqual(sanitized.authorization, '[REDACTED]');
      assert.strictEqual(sanitized.dpapi, '[REDACTED]');
      assert.strictEqual(sanitized.confirmationToken, '[REDACTED]');
      assert.strictEqual(sanitized.nested.secret, '[REDACTED]');
      assert.strictEqual(sanitized.nested.apiKey, '[REDACTED]');
    });

    it('marks webpage extracted text as untrusted web data', () => {
      const pageObservation = {
        title: 'Dashboard',
        text: 'Account Balance: $5,000',
        label: 'Username',
        accessibleName: 'Submit Form',
        elements: [
          { role: 'button', text: 'Click Me' }
        ]
      };

      const sanitized = sanitizeObservation(pageObservation);
      assert.strictEqual(sanitized.text.trust, 'untrusted_web_data');
      assert.strictEqual(sanitized.text.content, 'Account Balance: $5,000');
      assert.strictEqual(sanitized.label.trust, 'untrusted_web_data');
      assert.strictEqual(sanitized.accessibleName.trust, 'untrusted_web_data');
      assert.strictEqual(sanitized.elements.trust, 'untrusted_web_data');
    });

    it('sanitizes embedded absolute file paths in observations', () => {
      const observation = {
        downloadedFile: 'C:\\Users\\arehman\\Downloads\\statement.csv',
        uploadedFile: '/tmp/files/avatar.png'
      };

      const sanitized = sanitizeObservation(observation);
      assert.strictEqual(sanitized.downloadedFile, 'statement.csv');
      assert.strictEqual(sanitized.uploadedFile, 'avatar.png');
    });

    it('strips raw Playwright Page and ElementHandle objects', () => {
      const mockPageHandle = {
        evaluate: async () => {},
        screenshot: async () => {},
        goto: async () => {}
      };

      const mockElementHandle = {
        asElement: () => {},
        evaluate: async () => {}
      };

      const observation = {
        pageId: 'pg_123',
        page: mockPageHandle,
        element: mockElementHandle,
        count: 5
      };

      const sanitized = sanitizeObservation(observation);
      assert.strictEqual(sanitized.pageId, 'pg_123');
      assert.strictEqual(sanitized.page, '[BROWSER_HANDLE_REDACTED]');
      assert.strictEqual(sanitized.element, '[BROWSER_HANDLE_REDACTED]');
      assert.strictEqual(sanitized.count, 5);
    });

    it('strips functions, symbols, and unresolved promises', () => {
      const observation = {
        valid: true,
        fn: () => 'execute',
        sym: Symbol('secret'),
        prom: Promise.resolve(42)
      };

      const sanitized = sanitizeObservation(observation);
      assert.strictEqual(sanitized.valid, true);
      assert.strictEqual(sanitized.fn, undefined);
      assert.strictEqual(sanitized.sym, undefined);
      assert.strictEqual(sanitized.prom, undefined);
    });
  });
});
