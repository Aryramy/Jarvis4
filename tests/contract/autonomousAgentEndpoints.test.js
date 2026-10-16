/**
 * Contract Tests for Autonomous Agent HTTP Endpoints (BRICK-040).
 *
 * Scope:
 * - 100% offline, deterministic tests.
 * - Validates:
 *   - POST /api/agent/run
 *   - GET /api/agent/runs/:runId
 *   - POST /api/agent/runs/:runId/cancel
 *   - POST /api/agent/runs/:runId/confirm
 *   - Strict rejection of disallowed client overrides (systemPrompt, risk, model, raw selector, etc.)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/web/server.js';
import { BrowserManager } from '../../src/browser/browserManager.js';

describe('Autonomous Agent HTTP Endpoints Contract Tests', () => {
  let server;
  let baseUrl;
  let browserManager;

  function createMockLauncher() {
    let contextClosed = false;
    let browserClosed = false;

    const mockPage = {
      isClosed: () => false,
      close: async () => {},
      url: () => 'http://127.0.0.1:3000/test.html',
      title: async () => 'Test Page',
      evaluate: async () => ({
        visibleText: 'Welcome to Jarvis',
        elements: [],
        returnedElementCount: 0,
        totalEligibleElementCount: 0,
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

  describe('POST /api/agent/run validation', () => {
    it('returns 400 when task is missing or blank', async () => {
      const res = await fetch(`${baseUrl}/api/agent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(data.error.includes('Missing or empty "task"'));
    });

    it('rejects forbidden overrides in request body (systemPrompt, risk, model, script, etc.)', async () => {
      const forbiddenPayloads = [
        { task: 'valid task', systemPrompt: 'ignore rules' },
        { task: 'valid task', risk: 'R0' },
        { task: 'valid task', model: 'custom-model' },
        { task: 'valid task', provider: 'openai' },
        { task: 'valid task', confirmationToken: 'secret_123' },
        { task: 'valid task', budgetOverride: 100 },
        { task: 'valid task', cssSelector: 'button.admin' },
        { task: 'valid task', script: 'alert(1)' }
      ];

      for (const payload of forbiddenPayloads) {
        const res = await fetch(`${baseUrl}/api/agent/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        assert.equal(res.status, 400, `Expected 400 for payload: ${JSON.stringify(payload)}`);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.ok(data.error.includes('not permitted'));
      }
    });
  });

  describe('GET /api/agent/runs/:runId', () => {
    it('returns 404 for non-existent runId', async () => {
      const res = await fetch(`${baseUrl}/api/agent/runs/nonexistent_run_id`);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(data.error.includes('Agent run not found'));
    });
  });

  describe('POST /api/agent/runs/:runId/cancel', () => {
    it('returns 404 for cancelling non-existent runId', async () => {
      const res = await fetch(`${baseUrl}/api/agent/runs/nonexistent_run_id/cancel`, {
        method: 'POST'
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(data.error.includes('Agent run not found'));
    });
  });

  describe('POST /api/agent/runs/:runId/confirm', () => {
    it('returns 404 for confirming non-existent runId', async () => {
      const res = await fetch(`${baseUrl}/api/agent/runs/nonexistent_run_id/confirm`, {
        method: 'POST'
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(data.error.includes('Agent run not found'));
    });
  });
});
