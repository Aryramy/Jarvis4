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
  let currentUrl = 'about:blank';
  let currentTitle = 'Example Domain';
  const routes = [];

  const page = {
    gotoCalls: [],
    goBackCalls: [],
    goForwardCalls: [],
    reloadCalls: [],
    routes,
    route: async (pattern, handler) => {
      routes.push({ pattern, handler });
    },
    unroute: async (pattern, handler) => {
      const idx = routes.findIndex(r => r.pattern === pattern && (!handler || r.handler === handler));
      if (idx !== -1) routes.splice(idx, 1);
    },
    goto: async (...args) => {
      page.gotoCalls.push(args);
      const url = args[0];
      currentUrl = url;
      return {
        status: () => 200,
        request: () => ({
          url: () => url,
          redirectedFrom: () => null
        })
      };
    },
    goBack: async (opts) => {
      page.goBackCalls.push(opts);
      return { status: () => 200 };
    },
    goForward: async (opts) => {
      page.goForwardCalls.push(opts);
      return { status: () => 200 };
    },
    reload: async (opts) => {
      page.reloadCalls.push(opts);
      return { status: () => 200 };
    },
    title: async () => currentTitle,
    setTitle: (t) => { currentTitle = t; },
    url: () => currentUrl,
    setUrl: (u) => { currentUrl = u; },
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
    context: () => context
  };

  const contextListeners = new Map();
  const context = {
    newPageCalls: 0,
    pages: () => [page].filter(p => !p.closed),
    newPage: async () => {
      context.newPageCalls++;
      context.emit('page', page);
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
    },
    emit: (event, data) => {
      const cbs = contextListeners.get(event) || [];
      for (const cb of cbs) cb(data);
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
    reset: () => {
      connected = true;
      closed = false;
      page.closed = false;
      context.closed = false;
      contextListeners.clear();
    },
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
      launcher: async () => {
        mockEnv.browser.reset();
        return mockEnv.browser;
      },
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }]
    });

    testStorePath = resolve(process.cwd(), 'runtime', `.test-browser-store-${Date.now()}.json`);
    testStore = new ConversationStore({ filePath: testStorePath });
    testSession = new ConversationSession();

    server = createServer({
      browserManager: mockManager,
      session: testSession,
      store: testStore,
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }]
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

  // Brick 27: Navigation Endpoints (Section 49)
  describe('Browser Navigation Endpoints (Section 49)', () => {
    test('74. POST /api/browser/navigate while stopped returns BROWSER_NOT_RUNNING', async () => {
      // Ensure browser is stopped
      await fetch(`${baseUrl}/api/browser/close`, { method: 'POST' });

      const res = await fetch(`${baseUrl}/api/browser/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'BROWSER_NOT_RUNNING');
    });

    test('79. GET /api/browser/navigate rejected with 405 Method Not Allowed', async () => {
      const res = await fetch(`${baseUrl}/api/browser/navigate`);
      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Method Not Allowed');
    });

    test('80. GET /api/browser/back rejected with 405 Method Not Allowed', async () => {
      const res = await fetch(`${baseUrl}/api/browser/back`);
      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Method Not Allowed');
    });

    test('81. GET /api/browser/forward rejected with 405 Method Not Allowed', async () => {
      const res = await fetch(`${baseUrl}/api/browser/forward`);
      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Method Not Allowed');
    });

    test('82. GET /api/browser/refresh rejected with 405 Method Not Allowed', async () => {
      const res = await fetch(`${baseUrl}/api/browser/refresh`);
      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Method Not Allowed');
    });

    test('POST /api/browser/page-status rejected with 405 Method Not Allowed', async () => {
      const res = await fetch(`${baseUrl}/api/browser/page-status`, { method: 'POST' });
      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Method Not Allowed');
    });

    test('71 & 83. POST /api/browser/navigate successfully navigates running browser', async () => {
      // Launch browser first
      await fetch(`${baseUrl}/api/browser/launch`, { method: 'POST' });

      const res = await fetch(`${baseUrl}/api/browser/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/endpoint-test' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.requestedUrl, 'https://example.com/endpoint-test');
      assert.equal(data.finalUrl, 'https://example.com/endpoint-test');
      assert.equal(data.title, 'Example Domain');
      assert.equal(data.httpStatus, 200);
      assert.equal(typeof data.navigationDurationMs, 'number');
      assert.equal(data.state, 'running');
    });

    test('72. invalid URL rejected with 400', async () => {
      const res = await fetch(`${baseUrl}/api/browser/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'javascript:alert(1)' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'UNSUPPORTED_PROTOCOL');
    });

    test('73. private URL rejected with 400', async () => {
      const res = await fetch(`${baseUrl}/api/browser/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1/admin' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'LOCAL_OR_PRIVATE_HOST_BLOCKED');
    });

    test('75. GET /api/browser/page-status returns stable running page status', async () => {
      const res = await fetch(`${baseUrl}/api/browser/page-status`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.state, 'running');
      assert.equal(data.pageOpen, true);
      assert.equal(data.url, 'https://example.com/endpoint-test');
      assert.equal(data.title, 'Example Domain');
    });

    test('76. POST /api/browser/back returns stable contract', async () => {
      const res = await fetch(`${baseUrl}/api/browser/back`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.navigated, true);
      assert.equal(data.state, 'running');
    });

    test('77. POST /api/browser/forward returns stable contract', async () => {
      const res = await fetch(`${baseUrl}/api/browser/forward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.navigated, true);
      assert.equal(data.state, 'running');
    });

    test('78. POST /api/browser/refresh returns stable contract', async () => {
      const res = await fetch(`${baseUrl}/api/browser/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.state, 'running');
    });
  });

  // Section 50: Statelessness
  describe('Statelessness & Memory Invariants (Section 50)', () => {
    test('84-89. navigate, back, forward, refresh do not modify conversation session or store', async () => {
      testSession.clear();
      testSession.addUserMessage('Conversation Invariant Prompt');
      const initialMsgs = [...testSession.getMessages()];
      testStore.save(initialMsgs);

      // 84 & 85. navigate
      await fetch(`${baseUrl}/api/browser/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/stateless-check' })
      });
      assert.deepEqual(testSession.getMessages(), initialMsgs);
      assert.deepEqual(testStore.load(), initialMsgs);

      // 86. back
      await fetch(`${baseUrl}/api/browser/back`, { method: 'POST' });
      assert.deepEqual(testSession.getMessages(), initialMsgs);
      assert.deepEqual(testStore.load(), initialMsgs);

      // 87. forward
      await fetch(`${baseUrl}/api/browser/forward`, { method: 'POST' });
      assert.deepEqual(testSession.getMessages(), initialMsgs);
      assert.deepEqual(testStore.load(), initialMsgs);

      // 88. refresh
      await fetch(`${baseUrl}/api/browser/refresh`, { method: 'POST' });
      assert.deepEqual(testSession.getMessages(), initialMsgs);
      assert.deepEqual(testStore.load(), initialMsgs);

      // 89. page-status
      await fetch(`${baseUrl}/api/browser/page-status`);
      assert.deepEqual(testSession.getMessages(), initialMsgs);
      assert.deepEqual(testStore.load(), initialMsgs);

      testSession.clear();
      testStore.clear();
    });
  });

  // Section 51: Regressions
  describe('Regression Safety Across Existing Components (Section 51)', () => {
    test('90-107. previous endpoints and safety logic intact', async () => {
      // 96. browser decision
      const decisionRes = await fetch(`${baseUrl}/api/browser-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: 'Research topic' })
      });
      assert.equal(decisionRes.status, 200);

      // 97-99. browser launch, status, close
      const statusRes = await fetch(`${baseUrl}/api/browser/status`);
      assert.equal(statusRes.status, 200);

      const closeRes = await fetch(`${baseUrl}/api/browser/close`, { method: 'POST' });
      assert.equal(closeRes.status, 200);
    });
  });
});
