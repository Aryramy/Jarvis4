import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/web/server.js';
import { BrowserManager } from '../../src/browser/browserManager.js';
import { ConversationSession } from '../../src/core/conversationSession.js';
import { ConversationStore } from '../../src/core/conversationStore.js';
import { resolve } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

function createMockBrowserEnvironment() {
  const pageListeners = new Map();
  const page = {
    gotoCalls: [],
    goto: async (...args) => { page.gotoCalls.push(args); },
    close: async () => {
      page.closed = true;
      const cbs = pageListeners.get('close') || [];
      for (const cb of cbs) cb();
    },
    closed: false,
    isClosed: () => page.closed,
    on: (event, cb) => {
      if (!pageListeners.has(event)) pageListeners.set(event, []);
      pageListeners.get(event).push(cb);
    },
    simulateClose: () => {
      page.closed = true;
      const cbs = pageListeners.get('close') || [];
      for (const cb of cbs) cb();
    },
    url: () => 'about:blank'
  };

  const contextListeners = new Map();
  const context = {
    newPageCalls: 0,
    newPage: async () => {
      context.newPageCalls++;
      return page;
    },
    close: async () => {
      context.closed = true;
      const cbs = contextListeners.get('close') || [];
      for (const cb of cbs) cb();
    },
    closed: false,
    on: (event, cb) => {
      if (!contextListeners.has(event)) contextListeners.set(event, []);
      contextListeners.get(event).push(cb);
    }
  };

  const browserListeners = new Map();
  let connected = true;
  let closed = false;

  const browser = {
    newContextCalls: 0,
    newContext: async () => {
      browser.newContextCalls++;
      return context;
    },
    on: (event, cb) => {
      if (!browserListeners.has(event)) browserListeners.set(event, []);
      browserListeners.get(event).push(cb);
    },
    isConnected: () => connected && !closed,
    close: async () => {
      closed = true;
      connected = false;
      const cbs = browserListeners.get('disconnected') || [];
      for (const cb of cbs) cb();
    }
  };

  return { browser, context, page };
}

describe('Browser Lifecycle Endpoints (Brick 26)', () => {
  let server;
  let baseUrl;
  let mockEnv;
  let mockManager;
  let testStorePath;
  let testStore;
  let testSession;

  before(async () => {
    mockEnv = createMockBrowserEnvironment();
    mockManager = new BrowserManager({
      launcher: async () => mockEnv.browser
    });

    testStorePath = resolve(process.cwd(), 'runtime', `.test-browser-store-${Date.now()}.json`);
    testStore = new ConversationStore({ filePath: testStorePath });
    testSession = new ConversationSession();

    server = createServer({
      browserManager: mockManager,
      session: testSession,
      store: testStore
    });

    await new Promise((resolvePromise) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolvePromise();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
    if (existsSync(testStorePath)) {
      try { unlinkSync(testStorePath); } catch {}
    }
  });

  // Section 47: Endpoints
  describe('HTTP Endpoints (Section 47)', () => {
    test('53. GET /api/browser/status returns stopped state initially', async () => {
      const res = await fetch(`${baseUrl}/api/browser/status`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/json');

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.state, 'stopped');
      assert.equal(data.browserConnected, false);
      assert.equal(data.contextOpen, false);
      assert.equal(data.pageOpen, false);
      assert.equal(data.channel, 'msedge');
      assert.equal(data.currentUrl, null);
    });

    test('55. GET /api/browser/launch rejected with 405 Method Not Allowed', async () => {
      const res = await fetch(`${baseUrl}/api/browser/launch`);
      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Method Not Allowed');
    });

    test('56. GET /api/browser/close rejected with 405 Method Not Allowed', async () => {
      const res = await fetch(`${baseUrl}/api/browser/close`);
      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Method Not Allowed');
    });

    test('POST /api/browser/status rejected with 405 Method Not Allowed', async () => {
      const res = await fetch(`${baseUrl}/api/browser/status`, { method: 'POST' });
      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Method Not Allowed');
    });

    test('52 & 57. POST /api/browser/launch launches browser and returns stable contract', async () => {
      const res = await fetch(`${baseUrl}/api/browser/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.state, 'running');
      assert.equal(data.browserConnected, true);
      assert.equal(data.channel, 'msedge');
      assert.equal(data.headless, false);
      assert.equal(data.alreadyRunning, false);
      assert.equal(data.contextOpen, true);
      assert.equal(data.pageOpen, true);
      assert.equal(data.currentUrl, 'about:blank');
    });

    test('61. duplicate POST /api/browser/launch returns alreadyRunning: true without second launch', async () => {
      const res = await fetch(`${baseUrl}/api/browser/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.state, 'running');
      assert.equal(data.alreadyRunning, true);
      assert.equal(data.browserConnected, true);
    });

    test('58. GET /api/browser/status returns stable running contract', async () => {
      const res = await fetch(`${baseUrl}/api/browser/status`);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.state, 'running');
      assert.equal(data.browserConnected, true);
      assert.equal(data.contextOpen, true);
      assert.equal(data.pageOpen, true);
      assert.equal(data.channel, 'msedge');
      assert.equal(data.headless, false);
      assert.equal(data.currentUrl, 'about:blank');
    });

    test('54 & 59. POST /api/browser/close closes browser and returns stable contract', async () => {
      const res = await fetch(`${baseUrl}/api/browser/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.state, 'stopped');
      assert.equal(data.alreadyStopped, false);

      // Verify status is now stopped
      const statusRes = await fetch(`${baseUrl}/api/browser/status`);
      const statusData = await statusRes.json();
      assert.equal(statusData.state, 'stopped');
      assert.equal(statusData.browserConnected, false);
    });

    test('second POST /api/browser/close returns alreadyStopped: true safely', async () => {
      const res = await fetch(`${baseUrl}/api/browser/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.state, 'stopped');
      assert.equal(data.alreadyStopped, true);
    });

    test('60. launch failure produces controlled 500 response with BROWSER_LAUNCH_FAILED', async () => {
      const failingManager = new BrowserManager({
        launcher: async () => {
          throw new Error('Channel msedge unavailable');
        }
      });

      const failingServer = createServer({ browserManager: failingManager });
      await new Promise((r) => failingServer.listen(0, '127.0.0.1', r));
      const failPort = failingServer.address().port;

      try {
        const res = await fetch(`http://127.0.0.1:${failPort}/api/browser/launch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        assert.equal(res.status, 500);

        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.code, 'BROWSER_LAUNCH_FAILED');
        assert.match(data.message, /Channel msedge unavailable/);
      } finally {
        await new Promise((r) => failingServer.close(r));
      }
    });

    test('endpoint live fix: simulated manual page close reconciles status to stopped and allows fresh launch', async () => {
      // 1. Launch browser via endpoint
      const launchRes = await fetch(`${baseUrl}/api/browser/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(launchRes.status, 200);
      const launchData = await launchRes.json();
      assert.equal(launchData.success, true);
      assert.equal(launchData.state, 'running');

      // 2. Simulate user closing the Edge window (managed page)
      mockEnv.page.simulateClose();

      // 3. GET /api/browser/status must actively report stopped
      const statusRes = await fetch(`${baseUrl}/api/browser/status`);
      assert.equal(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.equal(statusData.state, 'stopped');
      assert.equal(statusData.browserConnected, false);
      assert.equal(statusData.contextOpen, false);
      assert.equal(statusData.pageOpen, false);
      assert.equal(statusData.currentUrl, null);

      // Reset mockEnv page closed flag for fresh launch
      mockEnv.page.closed = false;

      // 4. POST /api/browser/launch creates a fresh session (alreadyRunning: false)
      const freshLaunchRes = await fetch(`${baseUrl}/api/browser/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(freshLaunchRes.status, 200);
      const freshData = await freshLaunchRes.json();
      assert.equal(freshData.success, true);
      assert.equal(freshData.state, 'running');
      assert.equal(freshData.alreadyRunning, false);

      // Clean up
      await fetch(`${baseUrl}/api/browser/close`, { method: 'POST' });
    });
  });

  // Section 48: Statelessness
  describe('Statelessness & Memory Invariants (Section 48)', () => {
    test('62-66. browser operations do not modify ConversationSession or ConversationStore', async () => {
      // Record initial session state
      testSession.clear();
      testSession.addUserMessage('Existing prompt');
      const initialMsgs = [...testSession.getMessages()];
      testStore.save(initialMsgs);

      // 62. Launch
      await fetch(`${baseUrl}/api/browser/launch`, { method: 'POST' });
      assert.deepEqual(testSession.getMessages(), initialMsgs);
      assert.deepEqual(testStore.load(), initialMsgs);

      // 64. Status
      await fetch(`${baseUrl}/api/browser/status`);
      assert.deepEqual(testSession.getMessages(), initialMsgs);
      assert.deepEqual(testStore.load(), initialMsgs);

      // 65. Close
      await fetch(`${baseUrl}/api/browser/close`, { method: 'POST' });
      assert.deepEqual(testSession.getMessages(), initialMsgs);
      assert.deepEqual(testStore.load(), initialMsgs);

      // Clean up
      testSession.clear();
      testStore.clear();
    });
  });

  // Section 49: Regressions
  describe('Existing Endpoints Unmodified (Section 49)', () => {
    test('73. POST /api/browser-decision remains decision-only and does not launch browser', async () => {
      const res = await fetch(`${baseUrl}/api/browser-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: 'Log into Outlook' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.browserRequired, true);
      assert.equal(data.route, 'browser');

      // Verify browser manager state is still stopped
      const statusRes = await fetch(`${baseUrl}/api/browser/status`);
      const statusData = await statusRes.json();
      assert.equal(statusData.state, 'stopped');
    });
  });
});
