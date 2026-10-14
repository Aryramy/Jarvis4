import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserManager, BrowserManagerError, BROWSER_STATES } from '../../src/browser/browserManager.js';
import { SessionVault, MemoryProtectionProvider, generateSessionId } from '../../src/browser/sessionVault.js';
import { registerTestConfirmationToken, getConfirmationToken } from '../../src/browser/formSubmitter.js';

describe('BrowserManager Session Integration Unit Tests (Brick 35)', () => {
  let tempDir;
  let vault;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bm-session-'));
    vault = new SessionVault({
      vaultDir: tempDir,
      protectionProvider: new MemoryProtectionProvider()
    });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  function createMockLauncher(options = {}) {
    const contextState = options.initialStorageState || { cookies: [], origins: [] };
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

  it('selectSession selects a valid session and reflects in status', async () => {
    const meta = await vault.saveSession({
      name: 'Work Portal',
      storageState: { cookies: [{ name: 'auth', value: 'secret', domain: 'example.com', secure: true }] }
    });

    const mock = createMockLauncher();
    const manager = new BrowserManager({
      sessionVault: vault,
      launcher: mock.launcher
    });

    assert.strictEqual(manager.selectedSessionId, null);
    const selectRes = await manager.selectSession(meta.sessionId);
    assert.strictEqual(selectRes.success, true);
    assert.strictEqual(selectRes.selectedSessionId, meta.sessionId);
    assert.strictEqual(manager.selectedSessionId, meta.sessionId);

    const status = manager.getStatus();
    assert.strictEqual(status.selectedSessionId, meta.sessionId);
    assert.strictEqual(status.loadedSessionId, null);
    assert.strictEqual(status.sessionProfileLoaded, false);

    // Deselect
    await manager.selectSession(null);
    assert.strictEqual(manager.selectedSessionId, null);
  });

  it('launch with selectedSessionId loads session state and passes storageState into context', async () => {
    const expectedState = {
      cookies: [{ name: 'session_token', value: 'secret_jwt_xyz', domain: 'example.com', secure: true }],
      origins: []
    };

    const meta = await vault.saveSession({
      name: 'Work Portal',
      storageState: expectedState
    });

    const mock = createMockLauncher();
    const manager = new BrowserManager({
      sessionVault: vault,
      launcher: mock.launcher
    });

    await manager.selectSession(meta.sessionId);
    const launchRes = await manager.launch();

    assert.strictEqual(launchRes.success, true);
    assert.strictEqual(launchRes.selectedSessionId, meta.sessionId);
    assert.strictEqual(launchRes.loadedSessionId, meta.sessionId);
    assert.strictEqual(launchRes.sessionProfileLoaded, true);
    assert.strictEqual(launchRes.sessionStateRestored, true);

    const capturedOpts = mock.getCapturedContextOptions();
    assert.ok(capturedOpts);
    assert.deepStrictEqual(capturedOpts.storageState, expectedState);

    await manager.close();
  });

  it('saveSession captures current context storage state and stores it in vault', async () => {
    const currentContextState = {
      cookies: [{ name: 'logged_in_cookie', value: 'secret_session', domain: 'app.example.com', secure: true }],
      origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'token', value: 'abc' }] }]
    };

    const mock = createMockLauncher({ initialStorageState: currentContextState });
    const manager = new BrowserManager({
      sessionVault: vault,
      launcher: mock.launcher
    });

    await manager.launch();

    const saveRes = await manager.saveSession({ name: 'Saved App Session' });
    assert.strictEqual(saveRes.success, true);
    assert.strictEqual(saveRes.name, 'Saved App Session');
    assert.ok(saveRes.sessionId.startsWith('sess_'));
    assert.deepStrictEqual(saveRes.origins, ['https://app.example.com']);

    // Ensure zero secrets in returned metadata
    assert.strictEqual(saveRes.cookies, undefined);
    assert.strictEqual(saveRes.storageState, undefined);

    // Verify it can be loaded from vault
    const loaded = await vault.loadSession(saveRes.sessionId);
    assert.deepStrictEqual(loaded.storageState, currentContextState);

    await manager.close();
  });

  it('saveSession rejects with NO_ACTIVE_CONTEXT when browser is stopped', async () => {
    const mock = createMockLauncher();
    const manager = new BrowserManager({
      sessionVault: vault,
      launcher: mock.launcher
    });

    await assert.rejects(
      async () => manager.saveSession({ name: 'Test' }),
      (err) => err instanceof BrowserManagerError && err.code === 'NO_ACTIVE_CONTEXT'
    );
  });

  it('activateSession while browser is running replaces context and invalidates old page/tokens', async () => {
    const sessionState = {
      cookies: [{ name: 'session_b', value: 'val_b', domain: 'b.com', secure: true }],
      origins: []
    };
    const metaB = await vault.saveSession({ name: 'Session B', storageState: sessionState });

    const mock = createMockLauncher();
    const manager = new BrowserManager({
      sessionVault: vault,
      launcher: mock.launcher
    });

    // 1. Launch initial clean browser
    const launchRes = await manager.launch();
    const oldPageId = launchRes.activePageId;
    const oldSnapshotToken = manager.snapshotToken;

    // 2. Add an in-memory confirmation token bound to old page
    const testConfToken = 'conf_test_session_invalidation_token';
    registerTestConfirmationToken(testConfToken, {
      pageId: oldPageId,
      snapshotToken: oldSnapshotToken
    });
    assert.ok(getConfirmationToken(testConfToken));

    // 3. Activate session B
    const activateRes = await manager.activateSession(metaB.sessionId);
    assert.strictEqual(activateRes.success, true);
    assert.strictEqual(activateRes.sessionId, metaB.sessionId);
    assert.strictEqual(activateRes.sessionProfileLoaded, true);
    assert.strictEqual(activateRes.sessionStateRestored, true);

    const newPageId = activateRes.pageId;
    assert.notStrictEqual(newPageId, oldPageId);

    // 4. Invalidation Checks (Sections 21 & 22)
    // Old pageId is no longer managed in _pages registry
    assert.strictEqual(manager._pages.has(oldPageId), false);
    await assert.rejects(
      async () => manager.switchPage(oldPageId),
      (err) => err instanceof BrowserManagerError && err.code === 'PAGE_NOT_FOUND'
    );

    // Old snapshot token is no longer valid
    assert.strictEqual(manager.isSnapshotTokenValid(oldSnapshotToken), false);

    // Old form confirmation token was wiped on context replacement
    assert.strictEqual(getConfirmationToken(testConfToken), undefined);

    await manager.close();
  });

  it('session A and session B maintain strict isolation across launches', async () => {
    const stateA = {
      cookies: [{ name: 'user', value: 'alice', domain: 'site.com', secure: true }],
      origins: [{ origin: 'https://site.com', localStorage: [{ name: 'id', value: '1' }] }]
    };
    const stateB = {
      cookies: [{ name: 'user', value: 'bob', domain: 'site.com', secure: true }],
      origins: [{ origin: 'https://site.com', localStorage: [{ name: 'id', value: '2' }] }]
    };

    const metaA = await vault.saveSession({ name: 'Alice Session', storageState: stateA });
    const metaB = await vault.saveSession({ name: 'Bob Session', storageState: stateB });

    const mock = createMockLauncher();
    const manager = new BrowserManager({
      sessionVault: vault,
      launcher: mock.launcher
    });

    // Launch A
    await manager.selectSession(metaA.sessionId);
    await manager.launch();
    assert.deepStrictEqual(mock.getCapturedContextOptions().storageState, stateA);
    await manager.close();

    // Launch B
    await manager.selectSession(metaB.sessionId);
    await manager.launch();
    assert.deepStrictEqual(mock.getCapturedContextOptions().storageState, stateB);
    await manager.close();
  });
});
