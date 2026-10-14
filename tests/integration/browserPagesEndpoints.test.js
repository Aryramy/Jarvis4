import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/web/server.js';
import { BrowserManager } from '../../src/browser/browserManager.js';
import { ConversationSession } from '../../src/core/conversationSession.js';

function createMockPageInstance(initialUrl = 'https://example.com/', initialTitle = 'Example Domain', contextRef = null) {
  const pageListeners = new Map();
  let currentUrl = initialUrl;
  let currentTitle = initialTitle;
  const routes = [];

  const mockElements = [
    { kind: 'heading', tag: 'h1', text: 'Example Domain', accessibleName: 'Example Domain' },
    { kind: 'button', tag: 'button', type: 'button', text: 'Safe Button', accessibleName: 'Safe Button' },
    { kind: 'link', tag: 'a', text: 'Popup Link', accessibleName: 'Popup Link', href: 'https://example.com/popup', target: '_blank' },
    { kind: 'link', tag: 'a', text: 'Unsafe Link', accessibleName: 'Unsafe Link', href: 'http://127.0.0.1/admin', target: '_blank' }
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
    evaluate: async (fn, args) => {
      if (typeof fn === 'function' && fn.name !== 'extractDomSnapshot') {
        try {
          return await fn(args);
        } catch {}
      }
      return {
        visibleText: 'Example Domain content with elements',
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
        pToReturn = createMockPageInstance('https://example.com/', 'Example Domain', context);
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
      const cbs = contextListeners.get(evt) || [];
      for (const cb of cbs) cb(data);
    }
  };
  initialPage.setContext(context);

  const browser = {
    newContext: async () => context,
    on: () => {},
    isConnected: () => true,
    close: async () => {}
  };

  return { browser, context, page: initialPage, createdPages };
}

describe('Browser Pages & Multi-Page Lifecycle Integration Endpoints (Brick 31 Section 67)', () => {
  let server;
  let port;
  let browserManager;
  let mockEnv;
  const safeDns = async () => [{ address: '93.184.216.34', family: 4 }];

  before(async () => {
    mockEnv = createMockBrowserEnvironment();
    browserManager = new BrowserManager({
      launcher: async () => mockEnv.browser,
      dnsLookup: safeDns
    });

    server = createServer({
      browserManager,
      session: new ConversationSession()
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    if (browserManager) {
      await browserManager.close().catch(() => {});
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // 1. Browser Stopped Behavior
  describe('Browser Stopped Behavior', () => {
    test('GET /api/browser/pages returns 400 when stopped', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser/pages`);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'BROWSER_NOT_RUNNING');
    });

    test('POST /api/browser/open-page returns 400 when stopped', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser/open-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'BROWSER_NOT_RUNNING');
    });

    test('POST /api/browser/switch-page returns 400 when stopped', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser/switch-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: 'pg_test' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'BROWSER_NOT_RUNNING');
    });

    test('POST /api/browser/close-page returns 400 when stopped', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser/close-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: 'pg_test' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'BROWSER_NOT_RUNNING');
    });
  });

  // 2. HTTP Method Validations
  describe('Method Validation', () => {
    test('POST /api/browser/pages returns 405 Method Not Allowed', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser/pages`, {
        method: 'POST'
      });
      assert.equal(res.status, 405);
    });

    test('GET /api/browser/open-page returns 405 Method Not Allowed', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser/open-page`);
      assert.equal(res.status, 405);
    });

    test('GET /api/browser/switch-page returns 405 Method Not Allowed', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser/switch-page`);
      assert.equal(res.status, 405);
    });

    test('GET /api/browser/close-page returns 405 Method Not Allowed', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser/close-page`);
      assert.equal(res.status, 405);
    });
  });

  // 3. Multi-Page Lifecycle Operations
  describe('Running Browser Lifecycle Operations', () => {
    let initialPageId;

    before(async () => {
      await browserManager.launch();
      initialPageId = browserManager.activePageId;
    });

    test('GET /api/browser/pages lists initial page', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser/pages`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.activePageId, initialPageId);
      assert.equal(data.pages.length, 1);
      assert.equal(data.pages[0].pageId, initialPageId);
      assert.equal(data.pages[0].active, true);
      assert.equal(data.pages[0].creationType, 'initial');
    });

    test('POST /api/browser/open-page opens and activates second page', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser/open-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/page2' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(data.pageId);
      assert.equal(data.previousActivePageId, initialPageId);
      assert.equal(data.pageCount, 2);

      // Verify listing reflects 2 pages and new active page
      const listRes = await fetch(`http://127.0.0.1:${port}/api/browser/pages`);
      const listData = await listRes.json();
      assert.equal(listData.pages.length, 2);
      assert.equal(listData.activePageId, data.pageId);
    });

    test('POST /api/browser/open-page validates URL safety', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser/open-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1/admin' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'LOCAL_OR_PRIVATE_HOST_BLOCKED');
    });

    test('POST /api/browser/switch-page switches active page back to initial', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser/switch-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: initialPageId })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.activePageId, initialPageId);

      const listRes = await fetch(`http://127.0.0.1:${port}/api/browser/pages`);
      const listData = await listRes.json();
      assert.equal(listData.activePageId, initialPageId);
    });

    test('POST /api/browser/switch-page rejects missing or invalid pageId', async () => {
      const missingRes = await fetch(`http://127.0.0.1:${port}/api/browser/switch-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(missingRes.status, 400);

      const notFoundRes = await fetch(`http://127.0.0.1:${port}/api/browser/switch-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: 'pg_does_not_exist' })
      });
      assert.equal(notFoundRes.status, 400);
      const notFoundData = await notFoundRes.json();
      assert.equal(notFoundData.code, 'PAGE_NOT_FOUND');
    });

    test('POST /api/browser/close-page closes background page', async () => {
      // Find the second page
      const listRes = await fetch(`http://127.0.0.1:${port}/api/browser/pages`);
      const listData = await listRes.json();
      const secondPage = listData.pages.find((p) => p.pageId !== initialPageId);
      assert.ok(secondPage);

      const closeRes = await fetch(`http://127.0.0.1:${port}/api/browser/close-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: secondPage.pageId })
      });
      assert.equal(closeRes.status, 200);
      const closeData = await closeRes.json();
      assert.equal(closeData.success, true);
      assert.equal(closeData.closedPageId, secondPage.pageId);
      assert.equal(closeData.activePageId, initialPageId);

      // Verify count is back to 1
      const postListRes = await fetch(`http://127.0.0.1:${port}/api/browser/pages`);
      const postListData = await postListRes.json();
      assert.equal(postListData.pages.length, 1);
    });

    test('POST /api/browser/close-page rejects missing or invalid pageId', async () => {
      const missingRes = await fetch(`http://127.0.0.1:${port}/api/browser/close-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(missingRes.status, 400);

      const notFoundRes = await fetch(`http://127.0.0.1:${port}/api/browser/close-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: 'pg_invalid_xyz' })
      });
      assert.equal(notFoundRes.status, 400);
      const data = await notFoundRes.json();
      assert.equal(data.code, 'PAGE_NOT_FOUND');
    });
  });

  // 4. Action Endpoint popupPolicy Integration
  describe('Action Endpoint Popup Policy', () => {
    before(async () => {
      if (browserManager.state === 'stopped') {
        await browserManager.launch();
      }
    });

    test('POST /api/browser/action rejects invalid popupPolicy', async () => {
      const inspectRes = await fetch(`http://127.0.0.1:${port}/api/browser/inspect-page`);
      const inspectData = await inspectRes.json();

      const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { kind: 'button', name: 'Safe Button' },
          expectedSnapshotToken: inspectData.snapshotToken,
          popupPolicy: 'allow-all' // Invalid
        })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'INVALID_POPUP_POLICY');
    });

    test('POST /api/browser/action with popupPolicy allow-single adopts popup', async () => {
      const activePage = browserManager.page;
      activePage.onClick = async (p) => {
        const popup = createMockPageInstance('https://example.com/popup', 'Popup Title', browserManager.context);
        p.emit('popup', popup);
      };

      const inspectRes = await fetch(`http://127.0.0.1:${port}/api/browser/inspect-page`);
      const inspectData = await inspectRes.json();

      const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { kind: 'link', name: 'Popup Link' },
          expectedSnapshotToken: inspectData.snapshotToken,
          popupPolicy: 'allow-single'
        })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.popupCreated, true);
      assert.equal(data.newPageCreated, true);
      assert.equal(data.currentUrl, data.url);
      assert.equal(data.title, data.newTitle);
      assert.ok(data.newPageId);
      assert.equal(data.activePageId, data.newPageId);
      assert.equal(data.pageCount, 2);
    });

    test('POST /api/browser/action cross-page snapshot is rejected with TARGET_STALE', async () => {
      // After previous test, active page is the popup page
      const popupPageId = browserManager.activePageId;

      // Inspect active popup page to get its snapshot token
      const inspectRes = await fetch(`http://127.0.0.1:${port}/api/browser/inspect-page`);
      const inspectData = await inspectRes.json();
      const popupSnapshotToken = inspectData.snapshotToken;

      // Switch back to initial opener page
      const pagesRes = await fetch(`http://127.0.0.1:${port}/api/browser/pages`);
      const pagesData = await pagesRes.json();
      const opener = pagesData.pages.find((p) => p.pageId !== popupPageId);

      await fetch(`http://127.0.0.1:${port}/api/browser/switch-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: opener.pageId })
      });

      // Now active page is opener. Try using popup's snapshot token:
      const actionRes = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { kind: 'button', name: 'Safe Button' },
          expectedSnapshotToken: popupSnapshotToken // Token from popup page!
        })
      });

      assert.equal(actionRes.status, 400);
      const actionData = await actionRes.json();
      assert.equal(actionData.code, 'TARGET_STALE');
    });
  });
});
