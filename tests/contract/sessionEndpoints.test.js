import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../../src/web/server.js';
import { BrowserManager } from '../../src/browser/browserManager.js';
import { SessionVault, MemoryProtectionProvider, UnavailableProtectionProvider } from '../../src/browser/sessionVault.js';

describe('Browser Sessions HTTP API Contract Tests (Brick 35)', () => {
  let tempDir;
  let server;
  let baseUrl;
  let vault;
  let browserManager;

  function createMockLauncher(options = {}) {
    const contextState = options.initialStorageState || {
      cookies: [{ name: 'test_session', value: 'secret_session_token', domain: 'example.com', path: '/', secure: true }],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'auth_user', value: 'secret_user_id' }] }]
    };
    let capturedNewContextOptions = null;
    let contextClosed = false;
    let browserClosed = false;

    const mockPage = {
      isClosed: () => false,
      close: async () => {},
      url: () => 'about:blank',
      title: async () => 'Mock Page',
      evaluate: async () => null,
      on: () => {},
      removeListener: () => {}
    };

    const mockContext = {
      isClosed: () => contextClosed,
      close: async () => { contextClosed = true; },
      on: () => {},
      removeListener: () => {},
      newPage: async () => mockPage,
      storageState: async () => contextState
    };

    const mockBrowser = {
      isConnected: () => !browserClosed,
      close: async () => { browserClosed = true; },
      on: () => {},
      removeListener: () => {},
      newContext: async (contextOpts) => {
        capturedNewContextOptions = contextOpts;
        return mockContext;
      }
    };

    return {
      launcher: async () => mockBrowser,
      mockBrowser,
      mockContext,
      mockPage,
      getCapturedContextOptions: () => capturedNewContextOptions
    };
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-session-api-'));
    vault = new SessionVault({
      vaultDir: tempDir,
      protectionProvider: new MemoryProtectionProvider()
    });

    const mock = createMockLauncher();
    browserManager = new BrowserManager({
      sessionVault: vault,
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
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe('GET /api/browser/sessions', () => {
    it('returns empty session list initially with safe metadata structure', async () => {
      const res = await fetch(`${baseUrl}/api/browser/sessions`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(data.success, true);
      assert.deepStrictEqual(data.sessions, []);
      assert.strictEqual(data.selectedSessionId, null);
      assert.strictEqual(data.loadedSessionId, null);
      assert.strictEqual(data.sessionProfileLoaded, false);
      assert.strictEqual(data.sessionStateRestored, false);
    });

    it('returns saved session profiles with safe metadata and 0 secrets', async () => {
      await vault.saveSession({
        name: 'Work Portal',
        storageState: {
          cookies: [{ name: 'auth_cookie', value: 'super_secret_cookie', domain: 'portal.example.com', secure: true }],
          origins: [{ origin: 'https://portal.example.com', localStorage: [{ name: 'jwt', value: 'super_secret_token' }] }]
        }
      });

      const res = await fetch(`${baseUrl}/api/browser/sessions`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(data.success, true);
      assert.strictEqual(data.sessions.length, 1);
      const s = data.sessions[0];
      assert.strictEqual(s.name, 'Work Portal');
      assert.ok(s.sessionId.startsWith('sess_'));
      assert.deepStrictEqual(s.origins, ['https://portal.example.com']);
      assert.ok(s.createdAt);
      assert.ok(s.updatedAt);

      // Verify zero secrets leaked in JSON
      const jsonStr = JSON.stringify(data);
      assert.ok(!jsonStr.includes('super_secret_cookie'));
      assert.ok(!jsonStr.includes('super_secret_token'));
      assert.ok(!jsonStr.includes('cookies'));
      assert.ok(!jsonStr.includes('localStorage'));
    });
  });

  describe('POST /api/browser/sessions/save', () => {
    it('rejects with 400 when browser is not running', async () => {
      const res = await fetch(`${baseUrl}/api/browser/sessions/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Session' })
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(data.code, 'NO_ACTIVE_CONTEXT');
    });

    it('rejects with 400 when session name is missing or empty', async () => {
      await browserManager.launch();

      const res = await fetch(`${baseUrl}/api/browser/sessions/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' })
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(data.code, 'INVALID_SESSION_NAME');
    });

    it('saves running session and returns safe metadata with 0 secrets', async () => {
      await browserManager.launch();

      const res = await fetch(`${baseUrl}/api/browser/sessions/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Production Session' })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(data.success, true);
      assert.strictEqual(data.name, 'Production Session');
      assert.ok(data.sessionId.startsWith('sess_'));
      assert.deepStrictEqual(data.origins, ['https://example.com']);

      // Ensure zero secrets returned
      const jsonStr = JSON.stringify(data);
      assert.ok(!jsonStr.includes('secret_session_token'));
      assert.ok(!jsonStr.includes('secret_user_id'));
      assert.strictEqual(data.cookies, undefined);
      assert.strictEqual(data.storageState, undefined);
    });
  });

  describe('POST /api/browser/sessions/select', () => {
    it('selects session for next launch and deselects with null', async () => {
      const meta = await vault.saveSession({
        name: 'Demo Session',
        storageState: { cookies: [] }
      });

      // Select
      const selectRes = await fetch(`${baseUrl}/api/browser/sessions/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: meta.sessionId })
      });

      assert.strictEqual(selectRes.status, 200);
      const selectData = await selectRes.json();
      assert.strictEqual(selectData.success, true);
      assert.strictEqual(selectData.selectedSessionId, meta.sessionId);

      // Verify in list
      const listRes = await fetch(`${baseUrl}/api/browser/sessions`);
      const listData = await listRes.json();
      assert.strictEqual(listData.selectedSessionId, meta.sessionId);

      // Deselect
      const deselectRes = await fetch(`${baseUrl}/api/browser/sessions/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: null })
      });
      assert.strictEqual(deselectRes.status, 200);
      const deselectData = await deselectRes.json();
      assert.strictEqual(deselectData.selectedSessionId, null);
    });

    it('rejects with 404 if sessionId does not exist', async () => {
      const res = await fetch(`${baseUrl}/api/browser/sessions/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess_123456789_abcdef01' })
      });

      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(data.code, 'SESSION_NOT_FOUND');
    });
  });

  describe('POST /api/browser/sessions/activate', () => {
    it('activates a session in running browser, returning safe status', async () => {
      const meta = await vault.saveSession({
        name: 'Work Portal',
        storageState: { cookies: [{ name: 'auth', value: 'token123', domain: 'portal.com', secure: true }] }
      });

      await browserManager.launch();

      const res = await fetch(`${baseUrl}/api/browser/sessions/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: meta.sessionId })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(data.success, true);
      assert.strictEqual(data.sessionId, meta.sessionId);
      assert.strictEqual(data.sessionProfileLoaded, true);
      assert.strictEqual(data.sessionStateRestored, true);
      assert.ok(data.pageId);
    });

    it('rejects with 404 when activating a non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/browser/sessions/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess_999999999_abcdef01' })
      });

      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(data.code, 'SESSION_NOT_FOUND');
    });
  });

  describe('POST & DELETE /api/browser/sessions/delete', () => {
    it('deletes session via POST /api/browser/sessions/delete', async () => {
      const meta = await vault.saveSession({
        name: 'To Delete',
        storageState: { cookies: [] }
      });

      const res = await fetch(`${baseUrl}/api/browser/sessions/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: meta.sessionId })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.deletedSessionId, meta.sessionId);

      // Verify gone from list
      const listRes = await fetch(`${baseUrl}/api/browser/sessions`);
      const listData = await listRes.json();
      assert.strictEqual(listData.sessions.length, 0);
    });

    it('deletes session via DELETE /api/browser/sessions?sessionId=...', async () => {
      const meta = await vault.saveSession({
        name: 'To Delete Via Query',
        storageState: { cookies: [] }
      });

      const res = await fetch(`${baseUrl}/api/browser/sessions?sessionId=${meta.sessionId}`, {
        method: 'DELETE'
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.deletedSessionId, meta.sessionId);
    });

    it('returns 404 when deleting non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/browser/sessions/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess_123456789_abcdef01' })
      });

      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(data.code, 'SESSION_NOT_FOUND');
    });
  });

  describe('Fail-Closed Provider Status (503)', () => {
    it('returns 503 SESSION_VAULT_UNAVAILABLE when vault provider is unavailable', async () => {
      const unavailVault = new SessionVault({
        vaultDir: tempDir,
        protectionProvider: new UnavailableProtectionProvider()
      });

      const unavailManager = new BrowserManager({
        sessionVault: unavailVault,
        launcher: createMockLauncher().launcher
      });
      await unavailManager.launch();

      const customServer = createServer({ browserManager: unavailManager });
      let customUrl;
      await new Promise((resolve) => {
        customServer.listen(0, '127.0.0.1', () => {
          customUrl = `http://127.0.0.1:${customServer.address().port}`;
          resolve();
        });
      });

      try {
        const res = await fetch(`${customUrl}/api/browser/sessions/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Fail Closed' })
        });

        assert.strictEqual(res.status, 503);
        const data = await res.json();
        assert.strictEqual(data.success, false);
        assert.strictEqual(data.code, 'SESSION_VAULT_UNAVAILABLE');
      } finally {
        await unavailManager.close().catch(() => {});
        await new Promise((resolve) => customServer.close(resolve));
      }
    });
  });
});
