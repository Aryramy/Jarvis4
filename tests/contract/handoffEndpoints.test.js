import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../../src/web/server.js';
import { BrowserManager } from '../../src/browser/browserManager.js';
import { HANDOFF_REASONS, HANDOFF_STATES } from '../../src/browser/humanHandoff.js';

describe('Human Handoff HTTP Endpoints Contract Tests (Brick 36)', () => {
  let server;
  let baseUrl;
  let browserManager;
  let activeUrl = 'https://example.com/login';
  let activeTitle = 'Sign In Barrier';
  let currentElements = [{ id: 'signin-btn', role: 'button', text: 'Sign in' }];
  let currentText = 'Please sign in with your credentials.';

  function createMockLauncher() {
    let contextClosed = false;
    let browserClosed = false;

    const mockPage = {
      isClosed: () => false,
      close: async () => {},
      url: () => activeUrl,
      title: async () => activeTitle,
      evaluate: async () => ({
        visibleText: currentText,
        elements: currentElements,
        returnedElementCount: currentElements.length,
        totalEligibleElementCount: currentElements.length,
        textTruncated: false,
        elementsTruncated: false
      }),
      on: () => {},
      removeListener: () => {}
    };

    const mockContext = {
      isClosed: () => contextClosed,
      close: async () => { contextClosed = true; },
      on: () => {},
      removeListener: () => {},
      newPage: async () => mockPage,
      storageState: async () => ({ cookies: [], origins: [] })
    };

    const mockBrowser = {
      isConnected: () => !browserClosed,
      close: async () => { browserClosed = true; },
      on: () => {},
      removeListener: () => {},
      newContext: async () => mockContext
    };

    return {
      launcher: async () => mockBrowser,
      mockBrowser,
      mockContext,
      mockPage
    };
  }

  beforeEach(async () => {
    activeUrl = 'https://example.com/login';
    activeTitle = 'Sign In Barrier';
    currentElements = [{ id: 'signin-btn', role: 'button', text: 'Sign in' }];
    currentText = 'Please sign in with your credentials.';

    const mock = createMockLauncher();
    browserManager = new BrowserManager({
      launcher: mock.launcher
    });

    server = createServer({ browserManager });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (browserManager) {
      await browserManager.close().catch(() => {});
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('GET /api/browser/handoff/status', () => {
    it('returns IDLE status when no handoff is active', async () => {
      const res = await fetch(`${baseUrl}/api/browser/handoff/status`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.active, false);
      assert.strictEqual(data.status, HANDOFF_STATES.IDLE);
      assert.strictEqual(data.handoff, null);
    });

    it('returns active handoff metadata when handoff is paused', async () => {
      await browserManager.launch();
      const startRes = await browserManager.startHandoff({ reason: HANDOFF_REASONS.LOGIN_REQUIRED });
      assert.strictEqual(startRes.success, true);

      const res = await fetch(`${baseUrl}/api/browser/handoff/status`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.active, true);
      assert.strictEqual(data.handoff.status, HANDOFF_STATES.PAUSED_FOR_HUMAN);
      assert.strictEqual(data.handoff.reason, HANDOFF_REASONS.LOGIN_REQUIRED);
    });
  });

  describe('POST /api/browser/handoff/start', () => {
    it('returns 405 on non-POST method', async () => {
      const res = await fetch(`${baseUrl}/api/browser/handoff/start`, { method: 'GET' });
      assert.strictEqual(res.status, 405);
    });

    it('returns 400 when browser is not running', async () => {
      const res = await fetch(`${baseUrl}/api/browser/handoff/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: HANDOFF_REASONS.LOGIN_REQUIRED })
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(data.error, 'BROWSER_NOT_RUNNING');
    });

    it('returns 400 when reason is invalid', async () => {
      await browserManager.launch();
      const res = await fetch(`${baseUrl}/api/browser/handoff/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'INVALID_REASON' })
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(data.error, 'INVALID_HANDOFF_REASON');
    });

    it('successfully starts human handoff and returns 200 with safe metadata', async () => {
      await browserManager.launch();
      const res = await fetch(`${baseUrl}/api/browser/handoff/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: HANDOFF_REASONS.MFA_REQUIRED,
          verification: { type: 'url-changed' }
        })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.handoff);
      assert.strictEqual(data.handoff.reason, HANDOFF_REASONS.MFA_REQUIRED);
      assert.strictEqual(data.handoff.status, HANDOFF_STATES.PAUSED_FOR_HUMAN);
      assert.match(data.handoff.handoffId, /^handoff_\d+_[a-f0-9]{16}$/);
    });

    it('returns 409 when a handoff is already active', async () => {
      await browserManager.launch();
      await browserManager.startHandoff({ reason: HANDOFF_REASONS.LOGIN_REQUIRED });

      const res = await fetch(`${baseUrl}/api/browser/handoff/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: HANDOFF_REASONS.CAPTCHA_REQUIRED })
      });
      assert.strictEqual(res.status, 409);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(data.error, 'HANDOFF_ALREADY_ACTIVE');
    });
  });

  describe('POST /api/browser/handoff/resume', () => {
    it('returns 405 on non-POST method', async () => {
      const res = await fetch(`${baseUrl}/api/browser/handoff/resume`, { method: 'GET' });
      assert.strictEqual(res.status, 405);
    });

    it('returns 400 when handoffId is missing', async () => {
      const res = await fetch(`${baseUrl}/api/browser/handoff/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.strictEqual(res.status, 400);
    });

    it('returns 404 when handoffId does not exist', async () => {
      const res = await fetch(`${baseUrl}/api/browser/handoff/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoffId: 'handoff_999999_deadbeef' })
      });
      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.error, 'HANDOFF_NOT_FOUND');
    });

    it('returns 200 with NOT_CLEARED when barrier is not cleared', async () => {
      await browserManager.launch();
      const startRes = await browserManager.startHandoff({
        reason: HANDOFF_REASONS.LOGIN_REQUIRED,
        verification: { type: 'url-changed' }
      });

      const res = await fetch(`${baseUrl}/api/browser/handoff/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoffId: startRes.handoff.handoffId })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.verified, false);
      assert.strictEqual(data.status, HANDOFF_STATES.NOT_CLEARED);
      assert.strictEqual(data.code, 'HANDOFF_NOT_CLEARED');
    });

    it('returns 200 with VERIFIED when barrier is cleared', async () => {
      await browserManager.launch();
      const startRes = await browserManager.startHandoff({
        reason: HANDOFF_REASONS.LOGIN_REQUIRED,
        verification: { type: 'url-changed' }
      });

      // Human completes login -> URL navigates to dashboard
      activeUrl = 'https://example.com/dashboard';

      const res = await fetch(`${baseUrl}/api/browser/handoff/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoffId: startRes.handoff.handoffId })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.verified, true);
      assert.strictEqual(data.status, HANDOFF_STATES.VERIFIED);
    });
  });

  describe('POST /api/browser/handoff/cancel', () => {
    it('returns 405 on non-POST method', async () => {
      const res = await fetch(`${baseUrl}/api/browser/handoff/cancel`, { method: 'GET' });
      assert.strictEqual(res.status, 405);
    });

    it('returns 404 when handoffId does not exist', async () => {
      const res = await fetch(`${baseUrl}/api/browser/handoff/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoffId: 'handoff_111111_00000000' })
      });
      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.error, 'HANDOFF_NOT_FOUND');
    });

    it('successfully cancels active handoff', async () => {
      await browserManager.launch();
      const startRes = await browserManager.startHandoff({ reason: HANDOFF_REASONS.LOGIN_REQUIRED });

      const res = await fetch(`${baseUrl}/api/browser/handoff/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoffId: startRes.handoff.handoffId })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.status, HANDOFF_STATES.CANCELLED);

      // Verify status is now idle
      const statusRes = await fetch(`${baseUrl}/api/browser/handoff/status`);
      const statusData = await statusRes.json();
      assert.strictEqual(statusData.active, false);
    });
  });

  describe('Zero Credential Leaks', () => {
    it('verifies all handoff endpoints never return passwords, otp, or secret values', async () => {
      await browserManager.launch();
      const startRes = await browserManager.startHandoff({
        reason: HANDOFF_REASONS.LOGIN_REQUIRED,
        verification: { type: 'url-changed' }
      });

      const statusRes = await fetch(`${baseUrl}/api/browser/handoff/status`);
      const statusText = await statusRes.text();
      assert.strictEqual(statusText.includes('password'), false);
      assert.strictEqual(statusText.includes('secret'), false);
      assert.strictEqual(statusText.includes('cookie'), false);

      const resumeRes = await fetch(`${baseUrl}/api/browser/handoff/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoffId: startRes.handoffId })
      });
      const resumeText = await resumeRes.text();
      assert.strictEqual(resumeText.includes('password'), false);
      assert.strictEqual(resumeText.includes('secret'), false);
      assert.strictEqual(resumeText.includes('cookie'), false);
    });
  });
});
