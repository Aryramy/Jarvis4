import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/web/server.js';
import { BrowserManager } from '../../src/browser/browserManager.js';
import { ConversationSession } from '../../src/core/conversationSession.js';

function createMockPageInstance(initialUrl = 'https://example.com/', initialTitle = 'Dynamic SPA Test Page', contextRef = null) {
  const pageListeners = new Map();
  let currentUrl = initialUrl;
  let currentTitle = initialTitle;
  const routes = [];

  let mockElements = [
    { kind: 'heading', tag: 'h1', text: 'Dynamic App', accessibleName: 'Dynamic App' },
    { kind: 'button', tag: 'button', type: 'button', text: 'Submit Query', accessibleName: 'Submit Query' },
    { kind: 'button', tag: 'button', type: 'button', text: 'Save Preferences', accessibleName: 'Save Preferences' },
    { kind: 'link', tag: 'a', text: 'Dashboard', accessibleName: 'Dashboard', href: 'https://example.com/dash' }
  ];

  const p = {
    url: () => currentUrl,
    setUrl: (u) => { currentUrl = u; },
    title: async () => currentTitle,
    setTitle: (t) => { currentTitle = t; },
    bringToFrontCalls: 0,
    bringToFront: async () => { p.bringToFrontCalls++; },
    goto: async (url) => {
      currentUrl = url;
      return { status: () => 200 };
    },
    setMockElements: (els) => { mockElements = els; },
    getMockElements: () => mockElements,
    evaluate: async (fn, args) => {
      if (typeof fn === 'function' && fn.name !== 'extractDomSnapshot') {
        try {
          return await fn(args);
        } catch {}
      }
      return {
        visibleText: 'Dynamic App Content',
        textTruncated: false,
        elements: mockElements,
        returnedElementCount: mockElements.length,
        totalEligibleElementCount: mockElements.length,
        elementsTruncated: false
      };
    },
    evaluateHandle: async (fn, args) => {
      const handle = {
        asElement: () => handle,
        click: async (opts) => {
          if (p.onClick) await p.onClick(p);
        },
        isDisabled: async () => false,
        isConnected: async () => true,
        isVisible: async () => true,
        dispose: async () => {}
      };
      return handle;
    },
    close: async () => {
      p.closed = true;
      const cbs = pageListeners.get('close') || [];
      for (const cb of cbs) cb();
    },
    closed: false,
    isClosed: () => p.closed,
    on: (evt, cb) => {
      if (!pageListeners.has(evt)) pageListeners.set(evt, []);
      pageListeners.get(evt).push(cb);
    },
    off: (evt, cb) => {
      const arr = pageListeners.get(evt) || [];
      const idx = arr.indexOf(cb);
      if (idx !== -1) arr.splice(idx, 1);
    },
    removeListener: (evt, cb) => p.off(evt, cb),
    emit: (evt, data) => {
      const arr = pageListeners.get(evt) || [];
      for (const cb of arr) cb(data);
    },
    route: async (pattern, handler) => { routes.push({ pattern, handler }); },
    unroute: async (pattern, handler) => {
      const idx = routes.findIndex(r => r.pattern === pattern);
      if (idx !== -1) routes.splice(idx, 1);
    },
    waitForURL: async () => {},
    context: () => contextRef,
    setContext: (ctx) => { contextRef = ctx; }
  };
  return p;
}

function createMockBrowserEnvironment() {
  let context;
  const initialPage = createMockPageInstance();
  const createdPages = [initialPage];
  const contextListeners = new Map();

  context = {
    newPageCalls: 0,
    createdPages,
    pages: () => createdPages.filter(p => !p.closed),
    newPage: async () => {
      context.newPageCalls++;
      let pToReturn;
      if (context.newPageCalls === 1) {
        pToReturn = initialPage;
      } else {
        pToReturn = createMockPageInstance('https://example.com/', 'Dynamic App', context);
        createdPages.push(pToReturn);
      }
      context.emit('page', pToReturn);
      return pToReturn;
    },
    close: async () => {
      context.closed = true;
      const cbs = contextListeners.get('close') || [];
      for (const cb of cbs) cb();
    },
    closed: false,
    on: (evt, cb) => {
      if (!contextListeners.has(evt)) contextListeners.set(evt, []);
      contextListeners.get(evt).push(cb);
    },
    off: (evt, cb) => {
      const arr = contextListeners.get(evt) || [];
      const idx = arr.indexOf(cb);
      if (idx !== -1) arr.splice(idx, 1);
    },
    removeListener: (evt, cb) => context.off(evt, cb),
    emit: (evt, data) => {
      const arr = contextListeners.get(evt) || [];
      for (const cb of arr) cb(data);
    }
  };
  initialPage.setContext(context);

  const browserListeners = new Map();
  const browser = {
    newContext: async () => context,
    close: async () => {
      browser.closed = true;
      const cbs = browserListeners.get('disconnected') || [];
      for (const cb of cbs) cb();
    },
    isConnected: () => !browser.closed,
    closed: false,
    on: (evt, cb) => {
      if (!browserListeners.has(evt)) browserListeners.set(evt, []);
      browserListeners.get(evt).push(cb);
    },
    off: (evt, cb) => {
      const arr = browserListeners.get(evt) || [];
      const idx = arr.indexOf(cb);
      if (idx !== -1) arr.splice(idx, 1);
    },
    removeListener: (evt, cb) => browser.off(evt, cb)
  };

  return { browser, context, initialPage, createdPages };
}

describe('Dynamic Sites & SPAs Integration Endpoints (Brick 32 Section 70)', () => {
  let server;
  let baseUrl;
  let browserManager;
  let mockEnv;
  let conversationSession;

  before(async () => {
    mockEnv = createMockBrowserEnvironment();
    browserManager = new BrowserManager({
      launcher: async () => mockEnv.browser
    });
    conversationSession = new ConversationSession();

    server = createServer({
      browserManager,
      conversationSession
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (browserManager && browserManager.isSessionActive()) {
      await browserManager.close();
    }
    await new Promise((resolve) => server.close(resolve));
  });

  describe('POST /api/browser/wait-for-stable endpoint', () => {
    test('rejects with 405 for GET on /api/browser/wait-for-stable', async () => {
      const res = await fetch(`${baseUrl}/api/browser/wait-for-stable`, { method: 'GET' });
      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.error, 'Method Not Allowed');
    });

    test('rejects with 400 when browser is not running', async () => {
      const res = await fetch(`${baseUrl}/api/browser/wait-for-stable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeoutMs: 1000 })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'BROWSER_NOT_RUNNING');
    });

    test('successfully settles and returns fresh dynamic metadata when browser is running', async () => {
      await browserManager.launch();
      const res = await fetch(`${baseUrl}/api/browser/wait-for-stable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeoutMs: 2000, quietMs: 100 })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.settled, true);
      assert.equal(typeof data.pageId, 'string');
      assert.equal(typeof data.semanticRevision, 'number');
      assert.equal(typeof data.quietForMs, 'number');
      assert.equal(typeof data.waitDurationMs, 'number');
      assert.equal(typeof data.snapshotToken, 'string');
    });
  });

  describe('POST /api/browser/wait-for-target endpoint', () => {
    test('rejects with 405 for GET on /api/browser/wait-for-target', async () => {
      const res = await fetch(`${baseUrl}/api/browser/wait-for-target`, { method: 'GET' });
      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.error, 'Method Not Allowed');
    });

    test('rejects with 400 when missing target in body', async () => {
      const res = await fetch(`${baseUrl}/api/browser/wait-for-target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeoutMs: 1000 })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'INVALID_TARGET_QUERY');
    });

    test('rejects with 400 when target contains CSS selector or XPath', async () => {
      const res = await fetch(`${baseUrl}/api/browser/wait-for-target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: { selector: '#btn-submit' } })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'INVALID_TARGET_QUERY');
    });

    test('successfully resolves unique/high semantic target', async () => {
      const res = await fetch(`${baseUrl}/api/browser/wait-for-target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: { kind: 'button', name: 'Save Preferences' },
          timeoutMs: 2000
        })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.resolution, 'unique');
      assert.equal(data.confidence, 'high');
      assert.equal(typeof data.target, 'object');
      assert.equal(data.target.accessibleName, 'Save Preferences');
      assert.equal(typeof data.snapshotToken, 'string');
    });

    test('rejects with TARGET_NOT_READY when target does not appear within timeout', async () => {
      const res = await fetch(`${baseUrl}/api/browser/wait-for-target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: { kind: 'button', name: 'Nonexistent Button' },
          timeoutMs: 150
        })
      });
      assert.equal(res.status, 408);
      const data = await res.json();
      assert.equal(data.code, 'TARGET_NOT_READY');
    });
  });

  describe('Dynamic integration with existing browser endpoints', () => {
    test('GET /api/browser/page-status exposes dynamic metadata', async () => {
      const res = await fetch(`${baseUrl}/api/browser/page-status`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(typeof data.semanticRevision, 'number');
      assert.equal(typeof data.spaRouteVersion, 'number');
      assert.equal(typeof data.lastRelevantMutationAgeMs, 'number');
    });

    test('POST /api/browser/action rejects with TARGET_STALE after semantic mutation', async () => {
      // 1. Get current page snapshot token
      const statusRes = await fetch(`${baseUrl}/api/browser/wait-for-stable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeoutMs: 1000, quietMs: 100 })
      });
      const { snapshotToken } = await statusRes.json();
      assert.ok(snapshotToken);

      // 2. Trigger semantic mutation on the active page
      browserManager.recordSemanticMutation();

      // 3. Attempt action using stale snapshot
      const actRes = await fetch(`${baseUrl}/api/browser/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { kind: 'button', name: 'Save Preferences' },
          expectedSnapshotToken: snapshotToken
        })
      });

      assert.equal(actRes.status, 400);
      const actData = await actRes.json();
      assert.equal(actData.code, 'TARGET_STALE');
    });

    test('POST /api/browser/action rejects with TARGET_STALE after SPA route change', async () => {
      // 1. Get fresh snapshot token
      const stableRes = await fetch(`${baseUrl}/api/browser/wait-for-stable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeoutMs: 1000, quietMs: 100 })
      });
      const { snapshotToken } = await stableRes.json();

      // 2. Record SPA route change
      browserManager.recordSpaRoute('https://example.com/client-route-b');

      // 3. Attempt action with previous route's snapshot
      const actRes = await fetch(`${baseUrl}/api/browser/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { kind: 'button', name: 'Save Preferences' },
          expectedSnapshotToken: snapshotToken
        })
      });

      assert.equal(actRes.status, 400);
      const actData = await actRes.json();
      assert.equal(actData.code, 'TARGET_STALE');
    });

    test('error sanitization never exposes raw file paths or stacks', async () => {
      const res = await fetch(`${baseUrl}/api/browser/wait-for-target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: { kind: 'button', name: 'Random Missing' },
          timeoutMs: 120
        })
      });
      const data = await res.json();
      const rawText = JSON.stringify(data);
      assert.equal(rawText.includes('C:\\'), false);
      assert.equal(rawText.includes('/Users/'), false);
      assert.equal(rawText.includes('MutationObserver'), false);
    });
  });
});
