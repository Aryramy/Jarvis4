import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/web/server.js';
import { BrowserManager } from '../../src/browser/browserManager.js';
import { ConversationSession } from '../../src/core/conversationSession.js';

function createMockBrowserEnvironment() {
  const pageListeners = new Map();
  let currentUrl = 'https://example.com/';
  let currentTitle = 'Example Domain';

  const page = {
    gotoCalls: [],
    reloadCalls: [],
    title: async () => currentTitle,
    url: () => currentUrl,
    evaluate: async () => ({
      visibleText: 'This domain is for use in illustrative examples in documents.',
      textTruncated: false,
      elements: [
        { kind: 'heading', tag: 'h1', text: 'Example Domain' },
        { kind: 'link', tag: 'a', text: 'More information...', href: 'https://example.com/more' },
        { kind: 'input', tag: 'input', inputType: 'text', name: 'search', placeholder: 'Search...' }
      ],
      returnedElementCount: 3,
      totalEligibleElementCount: 3,
      elementsTruncated: false
    }),
    close: async () => {
      page.closed = true;
      const cbs = pageListeners.get('close') || [];
      for (const cb of cbs) cb();
    },
    waitForLoadState: async () => {},
    closed: false,
    isClosed: () => page.closed,
    on: (event, cb) => {
      if (!pageListeners.has(event)) pageListeners.set(event, []);
      pageListeners.get(event).push(cb);
    },
    context: () => context
  };

  const context = {
    pages: () => [page].filter(p => !p.closed),
    newPage: async () => page,
    close: async () => {}
  };

  const browser = {
    newContext: async () => context,
    on: () => {},
    isConnected: () => true,
    close: async () => {}
  };

  return { browser, context, page };
}

describe('Browser Inspect Page Endpoint Integration Tests (Brick 28)', () => {
  let server;
  let port;
  let browserManager;
  let session;
  let mockEnv;

  before(async () => {
    mockEnv = createMockBrowserEnvironment();
    browserManager = new BrowserManager({
      launcher: async () => mockEnv.browser
    });
    session = new ConversationSession();

    server = createServer({ browserManager, session });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('66. BROWSER_NOT_RUNNING when browser is stopped', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/inspect-page`);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'BROWSER_NOT_RUNNING');
    assert.equal(data.code, 'BROWSER_NOT_RUNNING');
  });

  test('71. POST method rejected with 405 Method Not Allowed', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/inspect-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selector: 'h1' })
    });
    assert.equal(res.status, 405);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Method Not Allowed');
  });

  test('65, 67-70. success while browser is running with full metadata and privacy', async () => {
    // Launch browser
    await browserManager.launch();

    const initialMessages = session.getMessages().length;

    const res = await fetch(`http://127.0.0.1:${port}/api/browser/inspect-page`);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.state, 'running');
    assert.equal(data.url, 'https://example.com/');
    assert.equal(data.title, 'Example Domain');
    assert.ok(data.visibleText.includes('illustrative examples'));
    assert.equal(data.textTruncated, false);
    assert.equal(data.returnedElementCount, 3);
    assert.equal(data.elementsTruncated, false);
    assert.ok(typeof data.inspectionDurationMs === 'number');

    // Element inventory assertions
    const inputEl = data.elements.find(e => e.kind === 'input');
    assert.ok(inputEl);
    assert.strictEqual(inputEl.value, undefined, '70. Input values must be omitted');

    // 72. No conversation changes
    assert.equal(session.getMessages().length, initialMessages, '72. Session must remain untouched');

    // 74. No navigation side effects
    assert.equal(mockEnv.page.gotoCalls.length, 0, '74. Inspection must not cause navigation');
  });

  test('Section 22: transient execution-context replaced on attempt 1, retry succeeds -> HTTP 200 normal result', async () => {
    let callCount = 0;
    const origEvaluate = mockEnv.page.evaluate;
    mockEnv.page.evaluate = async (fn, args) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
      }
      return await origEvaluate(fn, args);
    };

    const res = await fetch(`http://127.0.0.1:${port}/api/browser/inspect-page`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(callCount, 2, 'evaluated twice via bounded recovery');
    assert.ok(data.visibleText.includes('illustrative examples'));

    // restore
    mockEnv.page.evaluate = origEvaluate;
  });

  test('Section 22: persistent transient execution-context instability -> HTTP 503 BROWSER_PAGE_BUSY with zero raw error text', async () => {
    const origEvaluate = mockEnv.page.evaluate;
    mockEnv.page.evaluate = async () => {
      throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation at /internal/pw.js:99');
    };

    const res = await fetch(`http://127.0.0.1:${port}/api/browser/inspect-page`);
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'BROWSER_PAGE_BUSY');
    assert.equal(data.code, 'BROWSER_PAGE_BUSY');
    assert.equal(data.message, 'The page is still changing or loading. Try inspection again shortly.');
    assert.ok(!JSON.stringify(data).includes('page.evaluate'));
    assert.ok(!JSON.stringify(data).includes('Execution context was destroyed'));
    assert.ok(!JSON.stringify(data).includes('pw.js'));

    // restore
    mockEnv.page.evaluate = origEvaluate;
  });

  test('Section 22: generic evaluation failure -> HTTP 500 BROWSER_INSPECTION_FAILED with sanitized message', async () => {
    const origEvaluate = mockEnv.page.evaluate;
    mockEnv.page.evaluate = async () => {
      throw new Error('TypeError: internal v8 engine failure at C:\\internal\\playwright.js:12:34');
    };

    const res = await fetch(`http://127.0.0.1:${port}/api/browser/inspect-page`);
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'BROWSER_INSPECTION_FAILED');
    assert.equal(data.code, 'BROWSER_INSPECTION_FAILED');
    assert.equal(data.message, 'Page inspection could not be completed.');
    assert.ok(!JSON.stringify(data).includes('TypeError'));
    assert.ok(!JSON.stringify(data).includes('playwright.js'));
    assert.ok(!JSON.stringify(data).includes('C:\\internal'));

    // restore
    mockEnv.page.evaluate = origEvaluate;
  });
});
