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
    title: async () => currentTitle,
    url: () => currentUrl,
    goto: async (url) => {
      page.gotoCalls.push(url);
      currentUrl = url;
      return { status: () => 200 };
    },
    evaluate: async () => ({
      visibleText: 'Example Domain content with Submit button',
      textTruncated: false,
      elements: [
        { kind: 'heading', tag: 'h1', text: 'Example Domain', accessibleName: 'Example Domain' },
        { kind: 'button', tag: 'button', text: 'Submit', accessibleName: 'Submit' },
        { kind: 'button', tag: 'button', text: 'Duplicate', accessibleName: 'Duplicate' },
        { kind: 'button', tag: 'button', text: 'Duplicate', accessibleName: 'Duplicate' },
        { kind: 'input', tag: 'input', inputType: 'password', name: 'pwd', label: 'Password', accessibleName: 'Password' }
      ],
      returnedElementCount: 5,
      totalEligibleElementCount: 5,
      elementsTruncated: false
    }),
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

describe('Browser Resolve Target Endpoint Integration Tests (Brick 29 Section 53)', () => {
  let server;
  let port;
  let browserManager;
  let session;
  let mockEnv;
  let aiCallCount = 0;

  before(async () => {
    mockEnv = createMockBrowserEnvironment();
    browserManager = new BrowserManager({
      launcher: async () => mockEnv.browser
    });
    session = new ConversationSession();

    const mockAiProvider = {
      name: 'mock',
      call: async () => {
        aiCallCount++;
        return { response: 'AI response' };
      }
    };

    server = createServer({
      browserManager,
      session,
      provider: mockAiProvider
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    if (browserManager && browserManager.state === 'running') {
      await browserManager.close();
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('69. BROWSER_NOT_RUNNING when browser is stopped', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/resolve-target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'button', name: 'Submit' } })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'BROWSER_NOT_RUNNING');
    assert.equal(data.code, 'BROWSER_NOT_RUNNING');
  });

  test('72. GET rejected if endpoint is POST-only (405 Method Not Allowed)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/resolve-target`);
    assert.equal(res.status, 405);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Method Not Allowed');
  });

  test('70. invalid request rejected with 400', async () => {
    const resBadJson = await fetch(`http://127.0.0.1:${port}/api/browser/resolve-target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid-json{'
    });
    assert.equal(resBadJson.status, 400);

    const resForbiddenSelector = await fetch(`http://127.0.0.1:${port}/api/browser/resolve-target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { selector: 'button.btn-primary' } })
    });
    assert.equal(resForbiddenSelector.status, 400);
    const data = await resForbiddenSelector.json();
    assert.equal(data.code, 'INVALID_TARGET_QUERY');
  });

  test('71. unsupported kind rejected with 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/resolve-target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'unsupported_widget', name: 'Test' } })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, 'UNSUPPORTED_TARGET_KIND');
  });

  test('66. success unique target', async () => {
    await browserManager.launch();

    const res = await fetch(`http://127.0.0.1:${port}/api/browser/resolve-target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'button', name: 'Submit' } })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.resolution, 'unique');
    assert.equal(data.confidence, 'high');
    assert.equal(data.candidateCount, 1);
    assert.equal(data.match.kind, 'button');
    assert.equal(data.match.accessibleName, 'Submit');
    assert.ok(data.snapshotToken);
    assert.ok(typeof data.resolutionDurationMs === 'number');
  });

  test('67. TARGET_AMBIGUOUS when multiple elements match equally', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/resolve-target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'button', name: 'Duplicate' } })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.resolution, 'ambiguous');
    assert.equal(data.error, 'TARGET_AMBIGUOUS');
    assert.equal(data.code, 'TARGET_AMBIGUOUS');
    assert.equal(data.candidateCount, 2);
    assert.equal(data.candidates.length, 2);
  });

  test('68. TARGET_NOT_FOUND when no elements match', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/resolve-target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'button', name: 'Missing' } })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.resolution, 'not_found');
    assert.equal(data.error, 'TARGET_NOT_FOUND');
    assert.equal(data.code, 'TARGET_NOT_FOUND');
    assert.equal(data.candidateCount, 0);
  });

  test('73. raw Playwright errors sanitized', async () => {
    const originalEval = mockEnv.page.evaluate;
    mockEnv.page.evaluate = async () => {
      throw new Error('Playwright error at C:\\Users\\secret\\pw\\core.js: execution context destroyed');
    };

    const res = await fetch(`http://127.0.0.1:${port}/api/browser/resolve-target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'button', name: 'Submit' } })
    });

    mockEnv.page.evaluate = originalEval;

    assert.ok(res.status >= 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(!JSON.stringify(data).includes('C:\\Users'));
  });

  test('74. no conversation state changes during target resolution', async () => {
    const initialTurnCount = session.turns?.length || 0;

    await fetch(`http://127.0.0.1:${port}/api/browser/resolve-target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'button', name: 'Submit' } })
    });

    const finalTurnCount = session.turns?.length || 0;
    assert.equal(finalTurnCount, initialTurnCount);
  });

  test('75. zero AI calls during target resolution', () => {
    assert.equal(aiCallCount, 0);
  });

  test('76-77. zero navigation and zero interaction caused by resolve-target', () => {
    assert.equal(mockEnv.page.gotoCalls.length, 0);
    assert.equal(browserManager.getStatus().currentUrl, 'https://example.com/');
  });
});
