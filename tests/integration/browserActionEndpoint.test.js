import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/web/server.js';
import { BrowserManager } from '../../src/browser/browserManager.js';
import { ConversationSession } from '../../src/core/conversationSession.js';

function createMockBrowserEnvironment() {
  const pageListeners = new Map();
  let currentUrl = 'https://example.com/';
  let currentTitle = 'Example Domain';

  const actionLog = [];
  let lastFilledVal = '';
  let lastCheckedState = false;
  let lastSelectedText = 'One';

  const mockElements = [
    { kind: 'heading', tag: 'h1', text: 'Example Domain', accessibleName: 'Example Domain' },
    { kind: 'input', tag: 'input', inputType: 'text', name: 'my-text', accessibleName: 'Text input', label: 'Text input' },
    { kind: 'input', tag: 'input', inputType: 'checkbox', name: 'my-check', accessibleName: 'Default checkbox', label: 'Default checkbox', checked: false },
    { kind: 'input', tag: 'input', inputType: 'checkbox', name: 'my-check-on', accessibleName: 'Checked checkbox', label: 'Checked checkbox', checked: true },
    { kind: 'select', tag: 'select', name: 'my-select', accessibleName: 'Dropdown (select)', label: 'Dropdown (select)', selectedText: 'One' },
    { kind: 'button', tag: 'button', type: 'button', text: 'Safe Button', accessibleName: 'Safe Button' },
    { kind: 'input', tag: 'input', inputType: 'password', name: 'my-pwd', accessibleName: 'Password', label: 'Password' },
    { kind: 'input', tag: 'input', inputType: 'file', name: 'my-file', accessibleName: 'File input', label: 'File input' },
    { kind: 'button', tag: 'button', type: 'submit', text: 'Submit', accessibleName: 'Submit', formAction: '/post' },
    { kind: 'input', tag: 'input', inputType: 'text', name: 'dis-input', accessibleName: 'Disabled input', label: 'Disabled input', disabled: true },
    { kind: 'button', tag: 'button', text: 'Tied Button', accessibleName: 'Tied Button' },
    { kind: 'button', tag: 'button', text: 'Tied Button', accessibleName: 'Tied Button' },
    { kind: 'link', tag: 'a', text: 'Partial Long Named Target Link Element', accessibleName: 'Partial Long Named Target Link Element', href: 'https://example.com/part' }
  ];

  const page = {
    actionLog,
    title: async () => currentTitle,
    url: () => currentUrl,
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
          actionLog.push({ type: 'click', opts });
        },
        fill: async (val, opts) => {
          actionLog.push({ type: 'fill', val, opts });
          lastFilledVal = val;
        },
        check: async (opts) => {
          actionLog.push({ type: 'check', opts });
          lastCheckedState = true;
          page._lastCheckedState = true;
        },
        uncheck: async (opts) => {
          actionLog.push({ type: 'uncheck', opts });
          lastCheckedState = false;
          page._lastCheckedState = false;
        },
        selectOption: async (opt, opts) => {
          actionLog.push({ type: 'selectOption', opt, opts });
          lastSelectedText = opt?.label || opt;
          page._lastSelectedText = lastSelectedText;
        },
        getSelectedText: async () => lastSelectedText,
        inputValue: async () => lastFilledVal,
        isChecked: async () => lastCheckedState,
        isDisabled: async () => false,
        dispose: async () => {}
      };
      return handle;
    },
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
    off: (event, cb) => {
      const arr = pageListeners.get(event) || [];
      const idx = arr.indexOf(cb);
      if (idx !== -1) arr.splice(idx, 1);
    },
    removeListener: (event, cb) => page.off(event, cb),
    route: async () => {},
    unroute: async () => {},
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

  return { browser, context, page, mockElements, actionLog };
}

describe('Browser Action Endpoint Integration Tests (Brick 30 Section 63)', () => {
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

    await browserManager.launch();
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function getSnapshotToken() {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/inspect-page`);
    const data = await res.json();
    return data.snapshotToken;
  }

  test('88. valid fill', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'fill',
        target: { kind: 'input', name: 'Text input' },
        expectedSnapshotToken: token,
        value: 'Hello Integration'
      })
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.action, 'fill');
    assert.deepEqual(data.verification, { valueMatchesRequested: true });
    assert.ok(!JSON.stringify(data).includes('Hello Integration'));
  });

  test('89. valid check', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'check',
        target: { kind: 'input', name: 'Default checkbox' },
        expectedSnapshotToken: token
      })
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.deepEqual(data.verification, { checked: true });
  });

  test('90. valid uncheck', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'uncheck',
        target: { kind: 'input', name: 'Checked checkbox' },
        expectedSnapshotToken: token
      })
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.deepEqual(data.verification, { checked: false });
  });

  test('91. valid select', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'select',
        target: { kind: 'select', name: 'Dropdown (select)' },
        expectedSnapshotToken: token,
        option: { label: 'Two' }
      })
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.deepEqual(data.verification, { selectedText: 'Two' });
  });

  test('92. valid safe click', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'click',
        target: { kind: 'button', name: 'Safe Button' },
        expectedSnapshotToken: token
      })
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.deepEqual(data.verification, { completed: true });
  });

  test('93. TARGET_STALE', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'click',
        target: { kind: 'button', name: 'Safe Button' },
        expectedSnapshotToken: 'snap_v0_invalid'
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.code, 'TARGET_STALE');
  });

  test('94. TARGET_AMBIGUOUS', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'click',
        target: { kind: 'button', name: 'Tied Button' },
        expectedSnapshotToken: token
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.code, 'TARGET_AMBIGUOUS');
  });

  test('95. TARGET_NOT_FOUND', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'click',
        target: { kind: 'button', name: 'Definitely Does Not Exist' },
        expectedSnapshotToken: token
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.code, 'TARGET_NOT_FOUND');
  });

  test('96. TARGET_CONFIDENCE_TOO_LOW', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'click',
        target: { kind: 'link', name: 'Partial Long' },
        expectedSnapshotToken: token
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.code, 'TARGET_CONFIDENCE_TOO_LOW');
  });

  test('97. TARGET_DISABLED', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'fill',
        target: { kind: 'input', name: 'Disabled input' },
        expectedSnapshotToken: token,
        value: 'test'
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.code, 'TARGET_DISABLED');
  });

  test('98. password blocked', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'fill',
        target: { kind: 'input', name: 'Password' },
        expectedSnapshotToken: token,
        value: 'secretpass'
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.code, 'PASSWORD_INTERACTION_NOT_AUTHORIZED');
  });

  test('99. file input blocked', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'fill',
        target: { kind: 'input', name: 'File input' },
        expectedSnapshotToken: token,
        value: 'test.txt'
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.code, 'FILE_INTERACTION_NOT_AUTHORIZED');
  });

  test('100. form submission blocked', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'click',
        target: { kind: 'button', name: 'Submit' },
        expectedSnapshotToken: token
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.code, 'FORM_SUBMISSION_NOT_AUTHORIZED');
  });

  test('101. browser stopped', async () => {
    const stoppedBm = new BrowserManager({ launcher: async () => mockEnv.browser });
    const stoppedServer = createServer({ browserManager: stoppedBm });
    let sPort;
    await new Promise((resolve) => {
      stoppedServer.listen(0, '127.0.0.1', () => {
        sPort = stoppedServer.address().port;
        resolve();
      });
    });

    try {
      const res = await fetch(`http://127.0.0.1:${sPort}/api/browser/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { kind: 'button', name: 'Safe Button' },
          expectedSnapshotToken: 'snap_v1_123'
        })
      });
      const data = await res.json();
      assert.equal(res.status, 400);
      assert.equal(data.success, false);
      assert.equal(data.code, 'BROWSER_NOT_RUNNING');
    } finally {
      await new Promise((resolve) => stoppedServer.close(resolve));
    }
  });

  test('102. invalid action rejected', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'invalid_action_xyz',
        target: { kind: 'button', name: 'Safe Button' },
        expectedSnapshotToken: token
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.code, 'INVALID_ACTION');
  });

  test('103. missing target rejected', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'click',
        expectedSnapshotToken: token
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.code, 'INVALID_TARGET_QUERY');
  });

  test('104. missing expected snapshot rejected', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'click',
        target: { kind: 'button', name: 'Safe Button' }
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.code, 'MISSING_SNAPSHOT_TOKEN');
  });

  test('105. GET endpoint rejected', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'GET'
    });
    assert.equal(res.status, 405);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Method Not Allowed');
  });

  test('106. raw Playwright errors sanitized', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'click',
        target: { kind: 'button', name: 'Definitely Does Not Exist' },
        expectedSnapshotToken: token
      })
    });
    const data = await res.json();
    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes('at '));
    assert.ok(!serialized.includes('node:'));
    assert.ok(!serialized.includes('\\Users\\'));
  });

  test('107. conversation state unchanged', async () => {
    const initialSessionLength = session.size;
    const token = await getSnapshotToken();
    await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'click',
        target: { kind: 'button', name: 'Safe Button' },
        expectedSnapshotToken: token
      })
    });
    assert.equal(session.size, initialSessionLength, 'conversation state was not mutated');
  });

  test('108. one action only', async () => {
    const token = await getSnapshotToken();
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actions: [
          { action: 'click', target: { kind: 'button', name: 'Safe Button' } }
        ],
        expectedSnapshotToken: token
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.code, 'MULTI_ACTION_NOT_SUPPORTED');
  });
});
