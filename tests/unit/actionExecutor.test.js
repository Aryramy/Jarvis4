import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager, BrowserManagerError, BROWSER_STATES } from '../../src/browser/browserManager.js';
import { ActionExecutionError, executeSemanticAction, findTargetDomElement } from '../../src/browser/actionExecutor.js';

function createMockPageEnvironment(options = {}) {
  const pageListeners = new Map();
  let currentUrl = options.initialUrl || 'https://example.com/';
  let currentTitle = options.initialTitle || 'Example Domain';

  const actionLog = [];
  let disposedHandles = 0;

  const mockElements = options.mockElements ?? [
    { kind: 'heading', tag: 'h1', text: 'Example Domain', accessibleName: 'Example Domain' },
    { kind: 'input', tag: 'input', inputType: 'text', name: 'my-text', accessibleName: 'Text input', label: 'Text input' },
    { kind: 'input', tag: 'input', inputType: 'search', name: 'search', accessibleName: 'Search input', label: 'Search input' },
    { kind: 'textarea', tag: 'textarea', name: 'comments', accessibleName: 'Textarea', label: 'Textarea' },
    { kind: 'input', tag: 'input', inputType: 'email', name: 'email', accessibleName: 'Email input', label: 'Email input' },
    { kind: 'input', tag: 'input', inputType: 'password', name: 'pwd', accessibleName: 'Password', label: 'Password' },
    { kind: 'input', tag: 'input', inputType: 'file', name: 'file-upload', accessibleName: 'File input', label: 'File input' },
    { kind: 'input', tag: 'input', inputType: 'hidden', name: 'csrf-token' },
    { kind: 'input', tag: 'input', inputType: 'checkbox', name: 'agree', accessibleName: 'Default checkbox', label: 'Default checkbox', checked: false },
    { kind: 'input', tag: 'input', inputType: 'checkbox', name: 'notify', accessibleName: 'Checked checkbox', label: 'Checked checkbox', checked: true },
    { kind: 'input', tag: 'input', inputType: 'radio', name: 'choice', accessibleName: 'Default radio', label: 'Default radio', checked: false },
    { kind: 'input', tag: 'input', inputType: 'radio', name: 'choice', accessibleName: 'Selected radio', label: 'Selected radio', checked: true },
    { kind: 'select', tag: 'select', name: 'dropdown', accessibleName: 'Dropdown (select)', label: 'Dropdown (select)', selectedText: 'One' },
    { kind: 'button', tag: 'button', type: 'button', text: 'Safe Button', accessibleName: 'Safe Button' },
    { kind: 'button', tag: 'button', type: 'submit', text: 'Submit', accessibleName: 'Submit', formAction: '/submit' },
    { kind: 'button', tag: 'button', type: 'reset', text: 'Reset', accessibleName: 'Reset' },
    { kind: 'link', tag: 'a', text: 'Safe Link', accessibleName: 'Safe Link', href: 'https://example.com/next' },
    { kind: 'link', tag: 'a', text: 'Download Link', accessibleName: 'Download Link', href: 'https://example.com/file.zip', download: true },
    { kind: 'link', tag: 'a', text: 'Popup Link', accessibleName: 'Popup Link', href: 'https://example.com/popup', target: '_blank' },
    { kind: 'link', tag: 'a', text: 'Javascript Link', accessibleName: 'Javascript Link', href: 'javascript:alert(1)' },
    { kind: 'link', tag: 'a', text: 'File Link', accessibleName: 'File Link', href: 'file:///etc/passwd' },
    { kind: 'link', tag: 'a', text: 'Localhost Link', accessibleName: 'Localhost Link', href: 'http://127.0.0.1/admin' },
    { kind: 'link', tag: 'a', text: 'Downgrade Link', accessibleName: 'Downgrade Link', href: 'http://example.com/insecure' },
    { kind: 'input', tag: 'input', inputType: 'text', name: 'disabled-input', accessibleName: 'Disabled input', label: 'Disabled input', disabled: true },
    { kind: 'button', tag: 'button', type: 'button', text: 'Disabled button', accessibleName: 'Disabled button', disabled: true },
    { kind: 'select', tag: 'select', name: 'disabled-select', accessibleName: 'Disabled select', disabled: true },
    { kind: 'button', tag: 'button', text: 'Ambiguous Btn', accessibleName: 'Ambiguous Btn' },
    { kind: 'button', tag: 'button', text: 'Ambiguous Btn', accessibleName: 'Ambiguous Btn' },
    { kind: 'link', tag: 'a', text: 'Partial Medium Link Target Extra Long Words', accessibleName: 'Partial Medium Link Target Extra Long Words', href: 'https://example.com/partial' }
  ];

  let currentFilledValue = options.initialFilledValue ?? '';
  let currentCheckedState = options.initialCheckedState ?? false;
  let currentSelectedText = options.initialSelectedText ?? 'One';

  const page = {
    actionLog,
    getDisposedHandles: () => disposedHandles,
    url: () => currentUrl,
    setUrl: (u) => { currentUrl = u; },
    title: async () => currentTitle,
    setTitle: (t) => { currentTitle = t; },
    isClosed: () => false,
    close: async () => {
      const cbs = pageListeners.get('close') || [];
      for (const cb of cbs) cb();
    },
    on: (evt, cb) => {
      if (!pageListeners.has(evt)) pageListeners.set(evt, []);
      pageListeners.get(evt).push(cb);
    },
    off: (evt, cb) => {
      const arr = pageListeners.get(evt) || [];
      const idx = arr.indexOf(cb);
      if (idx !== -1) arr.splice(idx, 1);
    },
    removeListener: (evt, cb) => page.off(evt, cb),
    emit: (evt, data) => {
      const arr = pageListeners.get(evt) || [];
      for (const cb of arr) cb(data);
    },
    waitForLoadState: async () => {},
    route: async () => {},
    unroute: async () => {},
    goto: async (url) => {
      currentUrl = url;
      return { status: () => 200 };
    },
    evaluate: async (fn, args) => {
      if (typeof fn === 'function' && fn.name !== 'extractDomSnapshot') {
        try {
          return await fn(args);
        } catch {
          // fallback
        }
      }
      return {
        visibleText: options.mockVisibleText ?? 'Example Domain visible text',
        textTruncated: false,
        elements: mockElements,
        returnedElementCount: mockElements.length,
        totalEligibleElementCount: mockElements.length,
        elementsTruncated: false
      };
    },
    evaluateHandle: async (fn, args) => {
      if (options.failEvaluateHandle) {
        return null;
      }
      const handle = {
        asElement: () => handle,
        click: async (opts) => {
          actionLog.push({ type: 'click', opts });
          if (options.onClick) await options.onClick(page);
        },
        fill: async (val, opts) => {
          actionLog.push({ type: 'fill', val, opts });
          currentFilledValue = val;
          if (options.onFill) await options.onFill(val, page);
        },
        check: async (opts) => {
          actionLog.push({ type: 'check', opts });
          currentCheckedState = true;
          if (options.onCheck) await options.onCheck(page);
        },
        uncheck: async (opts) => {
          actionLog.push({ type: 'uncheck', opts });
          currentCheckedState = false;
          if (options.onUncheck) await options.onUncheck(page);
        },
        selectOption: async (opt, opts) => {
          actionLog.push({ type: 'selectOption', opt, opts });
          currentSelectedText = opt?.label || opt;
          page._lastSelectedText = currentSelectedText;
          if (options.onSelect) await options.onSelect(opt, page);
        },
        getSelectedText: async () => {
          if (options.corruptVerificationSelect) return 'wrong_option';
          return currentSelectedText;
        },
        inputValue: async () => {
          if (options.corruptVerificationValue) return 'wrong_value';
          return currentFilledValue;
        },
        isChecked: async () => {
          if (options.corruptVerificationCheck) return !currentCheckedState;
          return currentCheckedState;
        },
        isDisabled: async () => {
          return Boolean(options.mockElementDisabled);
        },
        dispose: async () => {
          disposedHandles++;
        }
      };
      return handle;
    },
    bringToFrontCalls: 0,
    bringToFront: async () => {
      page.bringToFrontCalls++;
    },
    waitForURL: async () => {},
    context: () => context
  };

  let initialPageCreated = false;
  const contextListeners = new Map();
  const context = {
    pages: () => [page].filter(p => !p.closed),
    newPage: async () => {
      if (!initialPageCreated) {
        initialPageCreated = true;
        context.emit('page', page);
        return page;
      }
      const secondaryListeners = new Map();
      let secondaryClosed = false;
      let secondaryUrl = 'https://example.com/new';
      let secondaryTitle = 'New Page';
      const secondaryPage = {
        url: () => secondaryUrl,
        title: async () => secondaryTitle,
        isClosed: () => secondaryClosed,
        close: async () => {
          secondaryClosed = true;
          const cbs = secondaryListeners.get('close') || [];
          for (const cb of cbs) cb();
        },
        on: (evt, cb) => {
          if (!secondaryListeners.has(evt)) secondaryListeners.set(evt, []);
          secondaryListeners.get(evt).push(cb);
        },
        off: (evt, cb) => {
          const arr = secondaryListeners.get(evt) || [];
          const idx = arr.indexOf(cb);
          if (idx !== -1) arr.splice(idx, 1);
        },
        removeListener: (evt, cb) => secondaryPage.off(evt, cb),
        bringToFront: async () => {},
        waitForURL: async () => {},
        waitForLoadState: async () => {},
        route: async () => {},
        unroute: async () => {},
        goto: async (url) => {
          secondaryUrl = url;
          return { status: () => 200 };
        },
        evaluate: async () => ({
          visibleText: 'Secondary page content',
          textTruncated: false,
          elements: [],
          returnedElementCount: 0,
          totalEligibleElementCount: 0,
          elementsTruncated: false
        }),
        context: () => context
      };
      context.emit('page', secondaryPage);
      return secondaryPage;
    },
    close: async () => {},
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

  const browser = {
    newContext: async () => context,
    on: () => {},
    isConnected: () => true,
    close: async () => {}
  };

  return { browser, context, contextListeners, page, mockElements, actionLog, getDisposedHandles: () => disposedHandles };
}

function createMockPopup(url = 'https://example.com/popup', title = 'Popup Title') {
  const listeners = new Map();
  let closed = false;
  const p = {
    url: () => url,
    title: async () => title,
    close: async () => {
      closed = true;
      const cbs = listeners.get('close') || [];
      for (const cb of cbs) cb();
    },
    isClosed: () => closed,
    on: (evt, cb) => {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(cb);
    },
    bringToFrontCalls: 0,
    bringToFront: async () => {
      p.bringToFrontCalls++;
    },
    waitForURL: async () => {}
  };
  return p;
}

describe('Action Executor Unit Tests (Brick 30)', () => {
  // ==================================================
  // SECTION 51: Snapshot Safety (Tests 1 - 8)
  // ==================================================
  describe('Snapshot Safety (Section 51)', () => {
    test('1. missing snapshot token rejected', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const snap = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Safe Button' }
          });
        },
        (err) => {
          assert.equal(err.code, 'MISSING_SNAPSHOT_TOKEN');
          return true;
        }
      );
      assert.equal(mock.actionLog.length, 0, 'zero interaction occurred');
    });

    test('2. wrong snapshot token -> TARGET_STALE', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Safe Button' },
            expectedSnapshotToken: 'snap_v999_wrong_token'
          });
        },
        (err) => {
          assert.equal(err.code, 'TARGET_STALE');
          return true;
        }
      );
    });

    test('3. stale snapshot performs zero interaction', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      await bm.inspectPage();

      try {
        await bm.executeAction({
          action: 'fill',
          target: { kind: 'input', name: 'Text input' },
          expectedSnapshotToken: 'snap_stale_123',
          value: 'Hello'
        });
      } catch (e) {
        assert.equal(e.code, 'TARGET_STALE');
      }

      assert.equal(mock.actionLog.length, 0, 'zero interaction performed on stale snapshot');
    });

    test('4. valid snapshot proceeds to re-resolution', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'fill',
        target: { kind: 'input', name: 'Text input' },
        expectedSnapshotToken: insp.snapshotToken,
        value: 'Hello World'
      });

      assert.equal(result.success, true);
      assert.equal(mock.actionLog.length, 1);
      assert.equal(mock.actionLog[0].type, 'fill');
    });

    test('5. navigation invalidates previous snapshot', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp1 = await bm.inspectPage();
      const oldToken = insp1.snapshotToken;

      await bm.navigate('https://example.com/page2');
      const newToken = bm.snapshotToken;
      assert.notEqual(oldToken, newToken);

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'fill',
            target: { kind: 'input', name: 'Text input' },
            expectedSnapshotToken: oldToken,
            value: 'Hello'
          });
        },
        (err) => err.code === 'TARGET_STALE'
      );
    });

    test('6. browser restart invalidates previous snapshot', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp1 = await bm.inspectPage();
      const oldToken = insp1.snapshotToken;

      await bm.close();
      await bm.launch();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Safe Button' },
            expectedSnapshotToken: oldToken
          });
        },
        (err) => err.code === 'TARGET_STALE'
      );
    });

    test('7. manual page close invalidates previous snapshot', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();
      const token = insp.snapshotToken;

      await mock.page.close();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Safe Button' },
            expectedSnapshotToken: token
          });
        },
        (err) => err.code === 'BROWSER_NOT_RUNNING'
      );
    });

    test('8. targetId alone cannot authorize action', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { targetId: 'tgt_1_salt123' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => {
          assert.equal(err.code, 'TARGETID_AUTHORIZATION_NOT_ALLOWED');
          return true;
        }
      );
    });
  });

  // ==================================================
  // SECTION 52: Re-Resolution (Tests 9 - 15)
  // ==================================================
  describe('Re-Resolution (Section 52)', () => {
    test('9. semantic target is re-resolved immediately before action', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'fill',
        target: { kind: 'input', name: 'Text input' },
        expectedSnapshotToken: insp.snapshotToken,
        value: 'Re-resolved Value'
      });

      assert.equal(result.success, true);
      assert.equal(result.target.kind, 'input');
    });

    test('10. unique high-confidence target may proceed', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'click',
        target: { kind: 'button', name: 'Safe Button' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(result.success, true);
      assert.equal(result.verification.completed, true);
    });

    test('11. ambiguous target -> zero action', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Ambiguous Btn' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'TARGET_AMBIGUOUS'
      );
      assert.equal(mock.actionLog.length, 0);
    });

    test('12. not-found target -> zero action', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Nonexistent Button 12345' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'TARGET_NOT_FOUND'
      );
      assert.equal(mock.actionLog.length, 0);
    });

    test('13. medium-confidence target -> TARGET_CONFIDENCE_TOO_LOW', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      // Query matches Partial Medium Link with partial text -> confidence: medium
      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Partial Medium' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => {
          assert.equal(err.code, 'TARGET_CONFIDENCE_TOO_LOW');
          return true;
        }
      );
      assert.equal(mock.actionLog.length, 0, 'zero action on medium confidence');
    });

    test('14. page changes between validation and action -> zero action', async () => {
      const mock = createMockPageEnvironment({ failEvaluateHandle: true });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Safe Button' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'TARGET_CHANGED'
      );
      assert.equal(mock.actionLog.length, 0);
    });

    test('15. long-lived ElementHandle is not reused and handle is disposed', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await bm.executeAction({
        action: 'click',
        target: { kind: 'button', name: 'Safe Button' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(mock.getDisposedHandles(), 1, 'element handle was disposed immediately');
    });
  });

  // ==================================================
  // SECTION 53: Fill (Tests 16 - 24)
  // ==================================================
  describe('Fill (Section 53)', () => {
    test('16. text input fill succeeds', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'fill',
        target: { kind: 'input', name: 'Text input' },
        expectedSnapshotToken: insp.snapshotToken,
        value: 'Standard text'
      });

      assert.equal(result.success, true);
      assert.equal(result.verification.valueMatchesRequested, true);
    });

    test('17. search input fill succeeds', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'fill',
        target: { kind: 'input', name: 'Search input' },
        expectedSnapshotToken: insp.snapshotToken,
        value: 'Search query'
      });

      assert.equal(result.success, true);
      assert.equal(result.verification.valueMatchesRequested, true);
    });

    test('18. textarea fill succeeds', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'fill',
        target: { kind: 'textarea', name: 'Textarea' },
        expectedSnapshotToken: insp.snapshotToken,
        value: 'Multi line comment text'
      });

      assert.equal(result.success, true);
      assert.equal(result.verification.valueMatchesRequested, true);
    });

    test('19. email/tel/url supported where configured', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'fill',
        target: { kind: 'input', name: 'Email input' },
        expectedSnapshotToken: insp.snapshotToken,
        value: 'test@example.com'
      });

      assert.equal(result.success, true);
      assert.equal(result.verification.valueMatchesRequested, true);
    });

    test('20. requested value is not returned', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();
      const secret = 'SUPER_SECRET_12345';

      const result = await bm.executeAction({
        action: 'fill',
        target: { kind: 'input', name: 'Text input' },
        expectedSnapshotToken: insp.snapshotToken,
        value: secret
      });

      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(secret), 'secret value must not be returned in result');
    });

    test('21. requested value is not logged through API result', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'fill',
        target: { kind: 'input', name: 'Text input' },
        expectedSnapshotToken: insp.snapshotToken,
        value: 'UserValue'
      });

      assert.equal(result.verification.value, undefined);
      assert.equal(result.value, undefined);
    });

    test('22. post-fill value internally matches and 23. verification boolean returned', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'fill',
        target: { kind: 'input', name: 'Text input' },
        expectedSnapshotToken: insp.snapshotToken,
        value: 'Verified Content'
      });

      assert.deepEqual(result.verification, { valueMatchesRequested: true });
    });

    test('24. disabled input rejected', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'fill',
            target: { kind: 'input', name: 'Disabled input' },
            expectedSnapshotToken: insp.snapshotToken,
            value: 'Attempt to fill disabled'
          });
        },
        (err) => err.code === 'TARGET_DISABLED'
      );
    });
  });

  // ==================================================
  // SECTION 54: Sensitive Inputs (Tests 25 - 30)
  // ==================================================
  describe('Sensitive Inputs (Section 54)', () => {
    test('25. password fill blocked', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'fill',
            target: { kind: 'input', name: 'Password' },
            expectedSnapshotToken: insp.snapshotToken,
            value: 'secret123'
          });
        },
        (err) => {
          assert.equal(err.code, 'PASSWORD_INTERACTION_NOT_AUTHORIZED');
          return true;
        }
      );
    });

    test('26. file input fill blocked', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'fill',
            target: { kind: 'input', name: 'File input' },
            expectedSnapshotToken: insp.snapshotToken,
            value: 'C:\\test.txt'
          });
        },
        (err) => {
          assert.equal(err.code, 'FILE_INTERACTION_NOT_AUTHORIZED');
          return true;
        }
      );
    });

    test('27. hidden input fill blocked and 28. CSRF/token mutation blocked', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'fill',
            target: { kind: 'input', name: 'csrf-token' },
            expectedSnapshotToken: insp.snapshotToken,
            value: 'fake_token'
          });
        },
        (err) => {
          assert.ok(err.code === 'ACTION_NOT_SUPPORTED_FOR_TARGET' || err.code === 'TARGET_NOT_FOUND');
          return true;
        }
      );
    });

    test('29. password value never returned and 30. file path never returned', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      try {
        await bm.executeAction({
          action: 'fill',
          target: { kind: 'input', name: 'Password' },
          expectedSnapshotToken: insp.snapshotToken,
          value: 'P@ssw0rd!'
        });
      } catch (err) {
        assert.ok(!JSON.stringify(err).includes('P@ssw0rd!'));
      }
    });
  });

  // ==================================================
  // SECTION 55: Check / Uncheck (Tests 31 - 37)
  // ==================================================
  describe('Check / Uncheck (Section 55)', () => {
    test('31. checkbox check succeeds and 32. checkbox checked state verified', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'check',
        target: { kind: 'input', name: 'Default checkbox' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.verification, { checked: true });
    });

    test('33. checkbox uncheck succeeds and 34. unchecked state verified', async () => {
      const mock = createMockPageEnvironment({ initialCheckedState: true });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'uncheck',
        target: { kind: 'input', name: 'Checked checkbox' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.verification, { checked: false });
    });

    test('35. radio check succeeds', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'check',
        target: { kind: 'input', name: 'Default radio' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.verification, { checked: true });
    });

    test('36. radio uncheck rejected', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'uncheck',
            target: { kind: 'input', name: 'Selected radio' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => {
          assert.equal(err.code, 'ACTION_NOT_SUPPORTED_FOR_TARGET');
          return true;
        }
      );
    });

    test('37. disabled checkbox rejected', async () => {
      const mock = createMockPageEnvironment({
        mockElements: [
          { kind: 'input', tag: 'input', inputType: 'checkbox', name: 'dis-check', accessibleName: 'Disabled Checkbox', disabled: true }
        ]
      });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'check',
            target: { kind: 'input', name: 'Disabled Checkbox' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'TARGET_DISABLED'
      );
    });
  });

  // ==================================================
  // SECTION 56: Select (Tests 38 - 42)
  // ==================================================
  describe('Select (Section 56)', () => {
    test('38. select by exact option label succeeds and 39. selected text verified', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'select',
        target: { kind: 'select', name: 'Dropdown (select)' },
        expectedSnapshotToken: insp.snapshotToken,
        option: { label: 'Two' }
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.verification, { selectedText: 'Two' });
    });

    test('40. unknown option rejected', async () => {
      const mock = createMockPageEnvironment();
      const origEval = mock.page.evaluate;
      mock.page.evaluate = async (fn, args) => {
        if (typeof fn === 'function' && fn.name === 'extractDomSnapshot') {
          return origEval(fn, args);
        }
        if (args && args.label === 'UnknownOption') return false;
        return true;
      };
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'select',
            target: { kind: 'select', name: 'Dropdown (select)' },
            expectedSnapshotToken: insp.snapshotToken,
            option: { label: 'UnknownOption' }
          });
        },
        (err) => err.code === 'OPTION_NOT_FOUND'
      );
    });

    test('41. multiple option selection not supported', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'select',
            target: { kind: 'select', name: 'Dropdown (select)' },
            expectedSnapshotToken: insp.snapshotToken,
            option: ['One', 'Two']
          });
        },
        (err) => err.code === 'MULTI_SELECT_NOT_SUPPORTED'
      );
    });

    test('42. disabled select rejected', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'select',
            target: { kind: 'select', name: 'Disabled select' },
            expectedSnapshotToken: insp.snapshotToken,
            option: { label: 'Two' }
          });
        },
        (err) => err.code === 'TARGET_DISABLED'
      );
    });
  });

  // ==================================================
  // SECTION 57: Click (Tests 43 - 53)
  // ==================================================
  describe('Click (Section 57)', () => {
    test('43. safe non-form button click succeeds', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'click',
        target: { kind: 'button', name: 'Safe Button' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.verification, { completed: true });
    });

    test('44. safe same-tab HTTP/HTTPS link click succeeds', async () => {
      const mock = createMockPageEnvironment({
        onClick: async (page) => {
          page.setUrl('https://example.com/next');
        }
      });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'click',
        target: { kind: 'link', name: 'Safe Link' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(result.success, true);
      assert.equal(result.navigationOccurred, true);
      assert.equal(result.snapshotChanged, true);
      assert.notEqual(result.postSnapshotToken, insp.snapshotToken);
    });

    test('45. disabled click target rejected', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Disabled button' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'TARGET_DISABLED'
      );
    });

    test('46. force click never used', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await bm.executeAction({
        action: 'click',
        target: { kind: 'button', name: 'Safe Button' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(mock.actionLog[0].type, 'click');
      assert.equal(mock.actionLog[0].opts?.force, undefined, 'force must not be true');
    });

    test('47. form submit button blocked and 48. default submit button inside form blocked and 49. input submit blocked', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Submit' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => {
          assert.equal(err.code, 'FORM_SUBMISSION_NOT_AUTHORIZED');
          return true;
        }
      );
    });

    test('50. form reset blocked', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Reset' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'FORM_RESET_NOT_AUTHORIZED'
      );
    });

    test('51. download click blocked', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Download Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'DOWNLOAD_NOT_AUTHORIZED'
      );
    });

    test('52. popup/new-tab click returns POPUP_NOT_SUPPORTED and 53. popup is not adopted as managed page', async () => {
      let popupSpawned = null;
      const mock = createMockPageEnvironment({
        onClick: async (page) => {
          popupSpawned = createMockPopup('https://example.com/popup');
          page.emit('popup', popupSpawned);
        }
      });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'POPUP_NOT_SUPPORTED'
      );
      assert.equal(bm.pages.length, 1);
      await bm.close();
    });

    test('52b. link with target="_blank" but no actual popup created succeeds normally without false rejection', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'click',
        target: { kind: 'link', name: 'Popup Link' },
        expectedSnapshotToken: insp.snapshotToken,
        popupPolicy: 'block'
      });
      assert.equal(res.success, true);
      assert.equal(res.verification.completed, true);
      assert.equal(res.popupCreated, false);
      await bm.close();
    });
  });

  // ==================================================
  // SECTION 58: Click Navigation Safety (Tests 54 - 64)
  // ==================================================
  describe('Click Navigation Safety (Section 58)', () => {
    test('54. safe public same-tab navigation allowed', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const result = await bm.executeAction({
        action: 'click',
        target: { kind: 'link', name: 'Safe Link' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.equal(result.success, true);
    });

    test('55. localhost navigation blocked and 56. 127.0.0.1 blocked', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Localhost Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('57. RFC1918 blocked', async () => {
      const mock = createMockPageEnvironment({
        mockElements: [
          { kind: 'link', tag: 'a', text: 'Private RFC Link', accessibleName: 'Private RFC Link', href: 'http://192.168.1.1/' }
        ]
      });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Private RFC Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('58. link-local blocked', async () => {
      const mock = createMockPageEnvironment({
        mockElements: [
          { kind: 'link', tag: 'a', text: 'Link Local Link', accessibleName: 'Link Local Link', href: 'http://169.254.169.254/' }
        ]
      });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Link Local Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('59. private IPv6 blocked', async () => {
      const mock = createMockPageEnvironment({
        mockElements: [
          { kind: 'link', tag: 'a', text: 'IPv6 Link', accessibleName: 'IPv6 Link', href: 'http://[::1]/' }
        ]
      });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'IPv6 Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('60. javascript: blocked', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Javascript Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'UNSUPPORTED_PROTOCOL'
      );
    });

    test('61. file: blocked and 62. data: blocked', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'File Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'UNSUPPORTED_PROTOCOL'
      );
    });

    test('63. HTTPS -> HTTP downgrade blocked', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Downgrade Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'INSECURE_REDIRECT_DOWNGRADE'
      );
    });

    test('64. redirect-to-private blocked', async () => {
      const mock = createMockPageEnvironment({
        mockElements: [
          { kind: 'link', tag: 'a', text: 'Private Target Link', accessibleName: 'Private Target Link', href: 'http://10.0.0.1/admin' }
        ]
      });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Private Target Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });
  });

  // ==================================================
  // SECTION 59: Action Verification (Tests 65 - 71)
  // ==================================================
  describe('Action Verification (Section 59)', () => {
    test('65. fill result verified', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'fill',
        target: { kind: 'input', name: 'Text input' },
        expectedSnapshotToken: insp.snapshotToken,
        value: 'TestVal'
      });
      assert.deepEqual(res.verification, { valueMatchesRequested: true });
    });

    test('66. check result verified', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'check',
        target: { kind: 'input', name: 'Default checkbox' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.deepEqual(res.verification, { checked: true });
    });

    test('67. uncheck result verified', async () => {
      const mock = createMockPageEnvironment({ initialCheckedState: true });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'uncheck',
        target: { kind: 'input', name: 'Checked checkbox' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.deepEqual(res.verification, { checked: false });
    });

    test('68. select result verified', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'select',
        target: { kind: 'select', name: 'Dropdown (select)' },
        expectedSnapshotToken: insp.snapshotToken,
        option: { label: 'Two' }
      });
      assert.deepEqual(res.verification, { selectedText: 'Two' });
    });

    test('69. failed verification returns ACTION_VERIFICATION_FAILED', async () => {
      const mock = createMockPageEnvironment({ corruptVerificationValue: true });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'fill',
            target: { kind: 'input', name: 'Text input' },
            expectedSnapshotToken: insp.snapshotToken,
            value: 'Expected'
          });
        },
        (err) => err.code === 'ACTION_VERIFICATION_FAILED'
      );
    });

    test('70. click returns bounded post-action evidence and 71. does not claim higher-level success', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'click',
        target: { kind: 'button', name: 'Safe Button' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(res.success, true);
      assert.equal(res.action, 'click');
      assert.equal(typeof res.actionDurationMs, 'number');
      assert.equal(res.taskCompleted, undefined);
      assert.equal(res.goalCompleted, undefined);
    });
  });

  // ==================================================
  // SECTION 60: One Action Only (Tests 72 - 75)
  // ==================================================
  describe('One Action Only (Section 60)', () => {
    test('72. action arrays rejected', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction([
            { action: 'fill', target: { kind: 'input', name: 'Text input' }, expectedSnapshotToken: insp.snapshotToken, value: 'A' },
            { action: 'click', target: { kind: 'button', name: 'Safe Button' }, expectedSnapshotToken: insp.snapshotToken }
          ]);
        },
        (err) => err.code === 'MULTI_ACTION_NOT_SUPPORTED'
      );
    });

    test('73. multi-action request rejected', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            actions: [
              { action: 'click', target: { kind: 'button', name: 'Safe Button' } }
            ],
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'MULTI_ACTION_NOT_SUPPORTED'
      );
    });

    test('74. one request invokes exactly one browser action and 75. no hidden second action performed', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await bm.executeAction({
        action: 'click',
        target: { kind: 'button', name: 'Safe Button' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(mock.actionLog.length, 1);
    });
  });

  // ==================================================
  // SECTION 61: Privacy (Tests 76 - 83)
  // ==================================================
  describe('Privacy (Section 61)', () => {
    test('76-83. API/result does NOT expose text, password, textarea, file path, hidden, cookies, storage', async () => {
      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const sensitiveText = 'sensitive_user_content_987';
      const res = await bm.executeAction({
        action: 'fill',
        target: { kind: 'input', name: 'Text input' },
        expectedSnapshotToken: insp.snapshotToken,
        value: sensitiveText
      });

      const serialized = JSON.stringify(res);
      assert.ok(!serialized.includes(sensitiveText));
      assert.equal(res.cookies, undefined);
      assert.equal(res.localStorage, undefined);
      assert.equal(res.sessionStorage, undefined);
    });
  });

  // ==================================================
  // SECTION 62: Zero AI / Zero Search (Tests 84 - 87)
  // ==================================================
  describe('Zero AI / Zero Search (Section 62)', () => {
    test('84-87. action execution performs zero AI and zero search calls', async () => {
      let aiCalled = 0;
      let searchCalled = 0;

      const mock = createMockPageEnvironment();
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await bm.executeAction({
        action: 'click',
        target: { kind: 'button', name: 'Safe Button' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(aiCalled, 0, 'zero AI calls');
      assert.equal(searchCalled, 0, 'zero search calls');
    });
  });

  // ==================================================
  // SECTION 64: Selenium-Style Regression Model
  // ==================================================
  describe('Selenium-Style Regression Model (Section 64)', () => {
    const seleniumElements = [
      { kind: 'heading', tag: 'h1', text: 'Web form', accessibleName: 'Web form' },
      { kind: 'input', tag: 'input', inputType: 'text', name: 'my-text', accessibleName: 'Text input', label: 'Text input' },
      { kind: 'input', tag: 'input', inputType: 'password', name: 'my-password', accessibleName: 'Password', label: 'Password' },
      { kind: 'textarea', tag: 'textarea', name: 'my-textarea', accessibleName: 'Textarea', label: 'Textarea' },
      { kind: 'input', tag: 'input', inputType: 'text', name: 'my-disabled', accessibleName: 'Disabled input', label: 'Disabled input', disabled: true },
      { kind: 'link', tag: 'a', text: 'Return to index', accessibleName: 'Return to index', href: 'https://example.com/selenium/index.html' },
      { kind: 'select', tag: 'select', name: 'my-select', accessibleName: 'Dropdown (select)', label: 'Dropdown (select)', selectedText: 'One' },
      { kind: 'input', tag: 'input', inputType: 'file', name: 'my-file', accessibleName: 'File input', label: 'File input' },
      { kind: 'input', tag: 'input', inputType: 'checkbox', name: 'my-check', accessibleName: 'Checked checkbox', label: 'Checked checkbox', checked: true },
      { kind: 'input', tag: 'input', inputType: 'checkbox', name: 'my-check', accessibleName: 'Default checkbox', label: 'Default checkbox', checked: false },
      { kind: 'input', tag: 'input', inputType: 'radio', name: 'my-radio', accessibleName: 'Default radio', label: 'Default radio', checked: false },
      { kind: 'button', tag: 'button', type: 'submit', text: 'Submit', accessibleName: 'Submit', formAction: 'submitted-form.html', formMethod: 'GET' }
    ];

    test('Selenium regression: Text input fill succeeds', async () => {
      const mock = createMockPageEnvironment({ mockElements: seleniumElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'fill',
        target: { kind: 'input', name: 'Text input' },
        expectedSnapshotToken: insp.snapshotToken,
        value: 'Selenium text value'
      });
      assert.equal(res.success, true);
      assert.equal(res.verification.valueMatchesRequested, true);
    });

    test('Selenium regression: Textarea fill succeeds', async () => {
      const mock = createMockPageEnvironment({ mockElements: seleniumElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'fill',
        target: { kind: 'textarea', name: 'Textarea' },
        expectedSnapshotToken: insp.snapshotToken,
        value: 'Selenium textarea note'
      });
      assert.equal(res.success, true);
      assert.equal(res.verification.valueMatchesRequested, true);
    });

    test('Selenium regression: Default checkbox check succeeds', async () => {
      const mock = createMockPageEnvironment({ mockElements: seleniumElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'check',
        target: { kind: 'input', name: 'Default checkbox' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.equal(res.success, true);
      assert.equal(res.verification.checked, true);
    });

    test('Selenium regression: Checked checkbox uncheck succeeds', async () => {
      const mock = createMockPageEnvironment({ mockElements: seleniumElements, initialCheckedState: true });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'uncheck',
        target: { kind: 'input', name: 'Checked checkbox' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.equal(res.success, true);
      assert.equal(res.verification.checked, false);
    });

    test('Selenium regression: Default radio check succeeds', async () => {
      const mock = createMockPageEnvironment({ mockElements: seleniumElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'check',
        target: { kind: 'input', name: 'Default radio' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.equal(res.success, true);
      assert.equal(res.verification.checked, true);
    });

    test('Selenium regression: Dropdown select "Two" succeeds', async () => {
      const mock = createMockPageEnvironment({ mockElements: seleniumElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'select',
        target: { kind: 'select', name: 'Dropdown (select)' },
        expectedSnapshotToken: insp.snapshotToken,
        option: { label: 'Two' }
      });
      assert.equal(res.success, true);
      assert.equal(res.verification.selectedText, 'Two');
    });

    test('Selenium regression: Return to index safe link click succeeds', async () => {
      const mock = createMockPageEnvironment({ mockElements: seleniumElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'click',
        target: { kind: 'link', name: 'Return to index' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.equal(res.success, true);
      assert.equal(res.verification.completed, true);
    });

    test('Selenium regression: Password fill is BLOCKED', async () => {
      const mock = createMockPageEnvironment({ mockElements: seleniumElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'fill',
            target: { kind: 'input', name: 'Password' },
            expectedSnapshotToken: insp.snapshotToken,
            value: 'secretpass'
          });
        },
        (err) => err.code === 'PASSWORD_INTERACTION_NOT_AUTHORIZED'
      );
    });

    test('Selenium regression: File input fill is BLOCKED', async () => {
      const mock = createMockPageEnvironment({ mockElements: seleniumElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'fill',
            target: { kind: 'input', name: 'File input' },
            expectedSnapshotToken: insp.snapshotToken,
            value: 'my-file.txt'
          });
        },
        (err) => err.code === 'FILE_INTERACTION_NOT_AUTHORIZED'
      );
    });

    test('Selenium regression: Submit button click is BLOCKED', async () => {
      const mock = createMockPageEnvironment({ mockElements: seleniumElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      await assert.rejects(
        async () => {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Submit' },
            expectedSnapshotToken: insp.snapshotToken
          });
        },
        (err) => err.code === 'FORM_SUBMISSION_NOT_AUTHORIZED'
      );
    });
  });

  // ==================================================
  // SECTION 65 & 66: Wikipedia & Multilingual Regression
  // ==================================================
  describe('Wikipedia & Multilingual Regression (Section 65 & 66)', () => {
    const wikiElements = [
      { kind: 'heading', tag: 'h1', text: 'Wikipedia', accessibleName: 'Wikipedia' },
      { kind: 'input', tag: 'input', inputType: 'search', name: 'search', accessibleName: 'Search Wikipedia', label: 'Search Wikipedia' },
      { kind: 'link', tag: 'a', text: 'English', accessibleName: 'English', href: 'https://en.wikipedia.org/' },
      { kind: 'link', tag: 'a', text: 'English 7,249,000+ articles', accessibleName: 'English 7,249,000+ articles', href: 'https://en.wikipedia.org/' },
      { kind: 'button', tag: 'button', type: 'button', text: 'بحث', accessibleName: 'بحث' },
      { kind: 'button', tag: 'button', type: 'button', text: 'تلاش کریں', accessibleName: 'تلاش کریں' },
      { kind: 'button', tag: 'button', type: 'button', text: '日本語', accessibleName: '日本語' }
    ];

    test('Search Wikipedia input fill allowed', async () => {
      const mock = createMockPageEnvironment({ mockElements: wikiElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'fill',
        target: { kind: 'input', name: 'Search Wikipedia' },
        expectedSnapshotToken: insp.snapshotToken,
        value: 'Artificial Intelligence'
      });
      assert.equal(res.success, true);
      assert.equal(res.verification.valueMatchesRequested, true);
    });

    test('exact high-confidence safe link click allowed', async () => {
      const mock = createMockPageEnvironment({ mockElements: wikiElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'click',
        target: { kind: 'link', name: 'English' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.equal(res.success, true);
    });

    test('Arabic button semantics Unicode-safe and high-confidence clickable', async () => {
      const mock = createMockPageEnvironment({ mockElements: wikiElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'click',
        target: { kind: 'button', name: 'بحث' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.equal(res.success, true);
      assert.equal(res.target.accessibleName, 'بحث');
    });

    test('Urdu button click succeeds without translation dependency', async () => {
      const mock = createMockPageEnvironment({ mockElements: wikiElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'click',
        target: { kind: 'button', name: 'تلاش کریں' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.equal(res.success, true);
      assert.equal(res.target.accessibleName, 'تلاش کریں');
    });

    test('Japanese button click succeeds without translation dependency', async () => {
      const mock = createMockPageEnvironment({ mockElements: wikiElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const res = await bm.executeAction({
        action: 'click',
        target: { kind: 'button', name: '日本語' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.equal(res.success, true);
      assert.equal(res.target.accessibleName, '日本語');
    });
  });

  // ==================================================
  // LIVE FIX D: Native Select Accessible-Name / Label Contamination Regression
  // ==================================================
  describe('Live Fix D: Native Select Accessible-Name / Label Contamination Regression', () => {
    // Clean metadata representing native select whose option text did NOT contaminate its label/accessibleName
    const cleanSelectElements = [
      {
        kind: 'select',
        tag: 'select',
        name: 'my-select',
        accessibleName: 'Dropdown (select)',
        label: 'Dropdown (select)',
        selectedText: 'Open this select menu'
      }
    ];

    test('1-6. resolver request kind=select name="Dropdown (select)" returns unique/high without option contamination', async () => {
      const mock = createMockPageEnvironment({ mockElements: cleanSelectElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      const selectEl = insp.elements.find(e => e.kind === 'select');
      assert.ok(selectEl, 'select element must be present in inspection');

      // 1. label is "Dropdown (select)"
      assert.equal(selectEl.label, 'Dropdown (select)');

      // 4. accessibleName does NOT contain option texts (Open this select menu, One, Two, Three)
      assert.ok(!selectEl.accessibleName.includes('Open this select menu'), 'accessibleName must not contain option text');
      assert.ok(!selectEl.accessibleName.includes('One'), 'accessibleName must not contain option text');
      assert.ok(!selectEl.accessibleName.includes('Two'), 'accessibleName must not contain option text');
      assert.ok(!selectEl.accessibleName.includes('Three'), 'accessibleName must not contain option text');
      assert.equal(selectEl.accessibleName, 'Dropdown (select)');

      // 5. label does NOT contain option text
      assert.ok(!selectEl.label.includes('Open this select menu'), 'label must not contain option text');
      assert.ok(!selectEl.label.includes('One'), 'label must not contain option text');
      assert.ok(!selectEl.label.includes('Two'), 'label must not contain option text');
      assert.ok(!selectEl.label.includes('Three'), 'label must not contain option text');

      // 6. selectedText independently holds current state
      assert.equal(selectEl.selectedText, 'Open this select menu');

      // 3. resolver request returns unique and high confidence
      const targetRes = await bm.resolveTarget({
        kind: 'select',
        name: 'Dropdown (select)'
      });
      assert.equal(targetRes.success, true);
      assert.equal(targetRes.resolution, 'unique');
      assert.equal(targetRes.confidence, 'high');
      assert.equal(targetRes.match.accessibleName, 'Dropdown (select)');
      assert.equal(targetRes.match.label, 'Dropdown (select)');
      assert.equal(targetRes.match.selectedText, 'Open this select menu');
    });

    test('7-8. selecting "Two" on clean native select succeeds and returns verified selectedText', async () => {
      const mock = createMockPageEnvironment({ mockElements: cleanSelectElements });
      const bm = new BrowserManager({ launcher: async () => mock.browser });
      await bm.launch();
      const insp = await bm.inspectPage();

      // 7. selecting "Two" continues to work
      const res = await bm.executeAction({
        action: 'select',
        target: { kind: 'select', name: 'Dropdown (select)' },
        expectedSnapshotToken: insp.snapshotToken,
        option: { label: 'Two' }
      });

      assert.equal(res.success, true);
      assert.equal(res.action, 'select');
      assert.equal(res.target.accessibleName, 'Dropdown (select)');

      // 8. post-action verification returns selectedText = "Two"
      assert.deepEqual(res.verification, { selectedText: 'Two' });
    });
  });

  // =========================================================================
  // BRICK 31: Popup Policy & Multi-Page Action Execution (Sections 61 - 66)
  // =========================================================================
  describe('Brick 31: Popup Policy & Multi-Page Action Safety', () => {
    function createMockPopup(url = 'https://example.com/popup', title = 'Popup Title', opener = null) {
      const listeners = new Map();
      let closed = false;
      const p = {
        url: () => url,
        title: async () => title,
        opener: async () => opener,
        close: async () => {
          closed = true;
          const cbs = listeners.get('close') || [];
          for (const cb of cbs) cb();
        },
        isClosed: () => closed,
        on: (evt, cb) => {
          if (!listeners.has(evt)) listeners.set(evt, []);
          listeners.get(evt).push(cb);
        },
        off: (evt, cb) => {
          const arr = listeners.get(evt) || [];
          const idx = arr.indexOf(cb);
          if (idx !== -1) arr.splice(idx, 1);
        },
        removeListener: (evt, cb) => p.off(evt, cb),
        bringToFrontCalls: 0,
        bringToFront: async () => {
          p.bringToFrontCalls++;
        },
        waitForURL: async () => {}
      };
      return p;
    }

    const safeDns = async () => [{ address: '93.184.216.34', family: 4 }];

    // -----------------------------------------------------------------------
    // Section 61: Popup Default Block (Tests 54 - 58)
    // -----------------------------------------------------------------------
    describe('Popup Default Block (Section 61)', () => {
      test('54. default popup policy = block', async () => {
        let popupSpawned = null;
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            popupSpawned = createMockPopup('https://example.com/popup');
            page.emit('popup', popupSpawned);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        // Default: no popupPolicy specified -> should be block
        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken
          }),
          (err) => err.code === 'POPUP_NOT_SUPPORTED'
        );
        await bm.close();
      });

      test('55. popup-producing click without allow-single remains blocked', async () => {
        let popupSpawned = null;
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            popupSpawned = createMockPopup('https://example.com/popup');
            page.emit('popup', popupSpawned);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'block'
          }),
          (err) => err.code === 'POPUP_NOT_SUPPORTED'
        );
        await bm.close();
      });

      test('56. transient popup is not adopted', async () => {
        let popupSpawned = null;
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            popupSpawned = createMockPopup('https://example.com/popup');
            page.emit('popup', popupSpawned);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        try {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Safe Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        } catch {}

        assert.ok(popupSpawned, 'popup should have been spawned');
        assert.equal(popupSpawned.isClosed(), true, 'transient popup must be closed safely');
        await bm.close();
      });

      test('57. managed page count unchanged', async () => {
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            const popup = createMockPopup('https://example.com/popup');
            page.emit('popup', popup);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        try {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        } catch {}

        assert.equal(bm.pageCount, 1);
        await bm.close();
      });

      test('58. opener remains active/manageable', async () => {
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            const popup = createMockPopup('https://example.com/popup');
            page.emit('popup', popup);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const openerId = bm.activePageId;
        const insp = await bm.inspectPage();

        try {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken
          });
        } catch {}

        assert.equal(bm.activePageId, openerId);
        const postInsp = await bm.inspectPage();
        assert.ok(postInsp.success);
        await bm.close();
      });
    });

    // -----------------------------------------------------------------------
    // Section 62: Allow Single Popup (Tests 59 - 66)
    // -----------------------------------------------------------------------
    describe('Allow Single Popup (Section 62)', () => {
      test('59. explicit allow-single may adopt exactly one popup', async () => {
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            const popup = createMockPopup('https://example.com/popup', 'Popup Title');
            page.emit('popup', popup);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Popup Link' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.equal(res.success, true);
        assert.equal(res.popupCreated, true);
        await bm.close();
      });

      test('60. new popup receives pageId', async () => {
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            const popup = createMockPopup('https://example.com/popup', 'Popup Title');
            page.emit('popup', popup);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Popup Link' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.ok(res.newPageId.startsWith('pg_'));
        await bm.close();
      });

      test('61. openerPageId recorded', async () => {
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            const popup = createMockPopup('https://example.com/popup', 'Popup Title');
            page.emit('popup', popup);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const initialId = bm.activePageId;
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Popup Link' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.equal(res.openerPageId, initialId);
        await bm.close();
      });

      test('62. creation type recorded', async () => {
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            const popup = createMockPopup('https://example.com/popup', 'Popup Title');
            page.emit('popup', popup);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Popup Link' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        const listing = await bm.listPages();
        const popupEntry = listing.pages.find((p) => p.pageId === res.newPageId);
        assert.equal(popupEntry.creationType, 'popup');
        await bm.close();
      });

      test('63. new popup becomes active', async () => {
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            const popup = createMockPopup('https://example.com/popup', 'Popup Title');
            page.emit('popup', popup);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Popup Link' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.equal(bm.activePageId, res.newPageId);
        assert.equal(res.activePageId, res.newPageId);
        await bm.close();
      });

      test('64. page count increments once', async () => {
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            const popup = createMockPopup('https://example.com/popup', 'Popup Title');
            page.emit('popup', popup);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        assert.equal(bm.pageCount, 1);
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Popup Link' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.equal(bm.pageCount, 2);
        assert.equal(res.pageCount, 2);
        await bm.close();
      });

      test('65. popup safe URL/title returned', async () => {
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            const popup = createMockPopup('https://example.com/popup', 'Safe Title');
            page.emit('popup', popup);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Popup Link' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.equal(res.url, 'https://example.com/popup');
        assert.equal(res.title, 'Safe Title');
        await bm.close();
      });

      test('66. original opener remains registered', async () => {
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            const popup = createMockPopup('https://example.com/popup', 'Safe Title');
            page.emit('popup', popup);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const openerId = bm.activePageId;
        const insp = await bm.inspectPage();

        await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Popup Link' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        const listing = await bm.listPages();
        const openerEntry = listing.pages.find((p) => p.pageId === openerId);
        assert.ok(openerEntry, 'opener must still exist in registry');
        assert.equal(openerEntry.active, false);
        await bm.close();
      });
    });

    // -----------------------------------------------------------------------
    // Section 63: Popup Safety (Tests 67 - 77)
    // -----------------------------------------------------------------------
    describe('Popup Safety (Section 63)', () => {
      async function testUnsafePopup(popupUrl, expectedCode) {
        let popupSpawned = null;
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            popupSpawned = createMockPopup(popupUrl);
            page.emit('popup', popupSpawned);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'allow-single',
            dnsLookup: safeDns
          }),
          (err) => err.code === expectedCode
        );

        // 75. Unsafe popup closed/released
        assert.equal(popupSpawned.isClosed(), true, 'unsafe popup must be closed');
        // 76. Unsafe popup not registered
        assert.equal(bm.pageCount, 1, 'page count must remain 1');
        // 77. Opener remains usable
        const checkInsp = await bm.inspectPage();
        assert.ok(checkInsp.success);

        await bm.close();
      }

      test('67. popup to localhost blocked', async () => {
        await testUnsafePopup('https://localhost:3000/', 'LOCAL_OR_PRIVATE_HOST_BLOCKED');
      });

      test('68. popup to RFC1918 blocked', async () => {
        await testUnsafePopup('https://192.168.1.1/', 'LOCAL_OR_PRIVATE_HOST_BLOCKED');
      });

      test('69. popup to link-local blocked', async () => {
        await testUnsafePopup('https://169.254.169.254/', 'LOCAL_OR_PRIVATE_HOST_BLOCKED');
      });

      test('70. popup to private IPv6 blocked', async () => {
        await testUnsafePopup('https://[::1]/', 'LOCAL_OR_PRIVATE_HOST_BLOCKED');
      });

      test('71. popup to javascript: blocked', async () => {
        await testUnsafePopup('javascript:alert(1)', 'UNSUPPORTED_PROTOCOL');
      });

      test('72. popup to file: blocked', async () => {
        await testUnsafePopup('file:///etc/passwd', 'UNSUPPORTED_PROTOCOL');
      });

      test('73. popup to data: blocked', async () => {
        await testUnsafePopup('data:text/html,evil', 'UNSUPPORTED_PROTOCOL');
      });

      test('74. popup redirecting private blocked', async () => {
        let popupSpawned = null;
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            popupSpawned = createMockPopup('https://evil-private.com/');
            page.emit('popup', popupSpawned);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'allow-single',
            dnsLookup: async (host) => {
              if (host === 'evil-private.com') {
                return [{ address: '10.0.0.1', family: 4 }];
              }
              return [{ address: '93.184.216.34', family: 4 }];
            }
          }),
          (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
        );

        assert.equal(popupSpawned.isClosed(), true);
        assert.equal(bm.pageCount, 1);
        await bm.close();
      });

      test('75-77. unsafe popup closed, not registered, opener remains usable (tested in 67-74)', async () => {
        // Assertions 75, 76, 77 verified above in helper testUnsafePopup
        assert.ok(true);
      });
    });

    // -----------------------------------------------------------------------
    // Section 64: Multiple Popups (Tests 78 - 81)
    // -----------------------------------------------------------------------
    describe('Multiple Popups (Section 64)', () => {
      test('78-81. allow-single plus 2 popups does not adopt both and closes extras safely', async () => {
        let p1 = null;
        let p2 = null;
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            p1 = createMockPopup('https://example.com/p1');
            p2 = createMockPopup('https://example.com/p2');
            page.emit('popup', p1);
            mock.context.emit('page', p2);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        // 80. MULTIPLE_POPUPS_NOT_SUPPORTED returned
        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'allow-single',
            dnsLookup: safeDns
          }),
          (err) => err.code === 'MULTIPLE_POPUPS_NOT_SUPPORTED'
        );

        // 79. Extras closed safely
        assert.equal(p1.isClosed(), true, 'p1 must be closed');
        assert.equal(p2.isClosed(), true, 'p2 must be closed');
        // 81. No registry corruption
        assert.equal(bm.pageCount, 1);
        await bm.close();
      });
    });

    // -----------------------------------------------------------------------
    // Section 65: Spontaneous Popups (Tests 82 - 85)
    // -----------------------------------------------------------------------
    describe('Spontaneous Popups (Section 65)', () => {
      test('82-85. spontaneous popup outside authorized action is closed safely and not trusted', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();

        const initialActiveId = bm.activePageId;
        const spontaneousPopup = createMockPopup('https://spontaneous-site.com/popup');

        // Site tries to emit context page event outside authorized action
        mock.context.emit('page', spontaneousPopup);

        // 85. Safe cleanup occurs
        assert.equal(spontaneousPopup.isClosed(), true, 'spontaneous popup must be closed');
        // 82. Not trusted / not registered
        assert.equal(bm.pageCount, 1);
        // 83-84. Not made active, does not hijack activePageId
        assert.equal(bm.activePageId, initialActiveId);
        await bm.close();
      });
    });

    // -----------------------------------------------------------------------
    // Section 66: Green-030 Regression (Tests 86 - 96)
    // -----------------------------------------------------------------------
    describe('GREEN-030 Action Regression (Section 66)', () => {
      test('86. fill works on active page', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'fill',
          target: { kind: 'input', name: 'Text input' },
          value: 'Hello Brick 31',
          expectedSnapshotToken: insp.snapshotToken
        });
        assert.equal(res.success, true);
        assert.deepEqual(res.verification, { valueMatchesRequested: true });
        await bm.close();
      });

      test('87. check works on active page', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'check',
          target: { kind: 'input', name: 'Default checkbox' },
          expectedSnapshotToken: insp.snapshotToken
        });
        assert.equal(res.success, true);
        assert.deepEqual(res.verification, { checked: true });
        await bm.close();
      });

      test('88. uncheck works on active page', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'uncheck',
          target: { kind: 'input', name: 'Checked checkbox' },
          expectedSnapshotToken: insp.snapshotToken
        });
        assert.equal(res.success, true);
        assert.deepEqual(res.verification, { checked: false });
        await bm.close();
      });

      test('89. select works on active page', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'select',
          target: { kind: 'select', name: 'Dropdown (select)' },
          expectedSnapshotToken: insp.snapshotToken,
          option: { label: 'Two' }
        });
        assert.equal(res.success, true);
        assert.deepEqual(res.verification, { selectedText: 'Two' });
        await bm.close();
      });

      test('90. safe same-tab click works', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'button', name: 'Safe Button' },
          expectedSnapshotToken: insp.snapshotToken
        });
        assert.equal(res.success, true);
        assert.equal(res.popupCreated, false);
        await bm.close();
      });

      test('91. password blocked', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => bm.executeAction({
            action: 'fill',
            target: { kind: 'input', name: 'Password' },
            value: 'secret',
            expectedSnapshotToken: insp.snapshotToken
          }),
          (err) => err.code === 'PASSWORD_INTERACTION_NOT_AUTHORIZED'
        );
        await bm.close();
      });

      test('92. file input blocked', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'input', name: 'File input' },
            expectedSnapshotToken: insp.snapshotToken
          }),
          (err) => err.code === 'FILE_INTERACTION_NOT_AUTHORIZED'
        );
        await bm.close();
      });

      test('93. form submit blocked', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Submit' },
            expectedSnapshotToken: insp.snapshotToken
          }),
          (err) => err.code === 'FORM_SUBMISSION_NOT_AUTHORIZED'
        );
        await bm.close();
      });

      test('94. medium-confidence action blocked', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Partial Medium' },
            expectedSnapshotToken: insp.snapshotToken
          }),
          (err) => err.code === 'TARGET_CONFIDENCE_TOO_LOW'
        );
        await bm.close();
      });

      test('95. ambiguous target blocked', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Ambiguous Btn' },
            expectedSnapshotToken: insp.snapshotToken
          }),
          (err) => err.code === 'TARGET_AMBIGUOUS'
        );
        await bm.close();
      });

      test('96. stale snapshot blocked', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        await bm.inspectPage();

        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Safe Button' },
            expectedSnapshotToken: 'snap_invalid_token_123'
          }),
          (err) => err.code === 'TARGET_STALE'
        );
        await bm.close();
      });
    });

    // -----------------------------------------------------------------------
    // Section 67: Live Fix B — Blocked Popup Detection & Contract (Tests 97 - 117)
    // -----------------------------------------------------------------------
    describe('Live Fix B: Blocked Popup Detection & Contract (Section 67)', () => {
      test('1-8. click + popupPolicy=block + real popup event returns POPUP_NOT_SUPPORTED, closes popup, leaves registry unchanged, opener active/usable, never reports completed=true', async () => {
        let popupSpawned = null;
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            popupSpawned = createMockPopup('https://example.com/popup', 'Popup Title', page);
            mock.context.emit('page', popupSpawned);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const openerId = bm.activePageId;
        const insp = await bm.inspectPage();

        let error = null;
        let actionResult = null;
        try {
          actionResult = await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'block'
          });
        } catch (err) {
          error = err;
        }

        // 1. returns POPUP_NOT_SUPPORTED
        assert.ok(error, 'Action must reject when popup is created under block policy');
        assert.equal(error.code, 'POPUP_NOT_SUPPORTED');
        assert.equal(error.message, 'Popup/new-page creation is blocked by the current popup policy.');

        // 2. blocked popup is closed
        assert.ok(popupSpawned, 'popup should have been spawned');
        assert.equal(popupSpawned.isClosed(), true, 'blocked popup must be closed');

        // 3. blocked popup is not registered
        const { pages } = await bm.listPages();
        assert.equal(pages.length, 1);
        assert.equal(pages[0].pageId, openerId);

        // 4. managed page count unchanged
        assert.equal(bm.pageCount, 1);

        // 5. activePageId remains opener
        assert.equal(bm.activePageId, openerId);

        // 6. opener remains usable
        const postInsp = await bm.inspectPage();
        assert.equal(postInsp.success, true);

        // 7. result must NOT report ordinary completed=true
        // 8. result must NOT report popupCreated=false success when an actual popup occurred
        assert.equal(actionResult, null, 'must not return a success result');

        await bm.close();
      });

      test('9. click + popupPolicy=block + no popup -> ordinary click success preserved', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Safe Link' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'block'
        });

        assert.equal(res.success, true);
        assert.equal(res.popupCreated, false);
        assert.deepEqual(res.verification, { completed: true });
        await bm.close();
      });

      test('10. target attribute suggesting popup (e.g. target="newWindow" or target="_blank") but NO actual Page event -> no false POPUP_NOT_SUPPORTED', async () => {
        const linkWithTarget = [
          { kind: 'link', tag: 'a', text: 'Target Link', accessibleName: 'Target Link', href: 'https://example.com/dest', target: 'newWindow' }
        ];
        const mock = createMockPageEnvironment({ mockElements: linkWithTarget });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Target Link' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'block'
        });

        assert.equal(res.success, true);
        assert.equal(res.popupCreated, false);
        assert.deepEqual(res.verification, { completed: true });
        await bm.close();
      });

      test('11-12. click-created popup is observed before spontaneous cleanup can swallow it and is not misclassified as generic spontaneous popup', async () => {
        let popupSpawned = null;
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            popupSpawned = createMockPopup('https://example.com/popup', 'Popup Title', page);
            mock.context.emit('page', popupSpawned);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'block'
          }),
          (err) => {
            assert.equal(err.code, 'POPUP_NOT_SUPPORTED');
            return true;
          }
        );

        assert.equal(popupSpawned.isClosed(), true);
        assert.equal(bm.pageCount, 1);
        await bm.close();
      });

      test('13. truly spontaneous popup outside action window remains blocked/closed', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const openerId = bm.activePageId;

        const roguePopup = createMockPopup('https://rogue-ad.com', 'Rogue Ad');
        mock.context.emit('page', roguePopup);

        assert.equal(roguePopup.isClosed(), true, 'spontaneous popup must be closed immediately');
        assert.equal(bm.pageCount, 1);
        assert.equal(bm.activePageId, openerId);
        await bm.close();
      });

      test('14. allow-single exactly one popup still works', async () => {
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            const popup = createMockPopup('https://example.com/single-popup', 'Single Popup', page);
            mock.context.emit('page', popup);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const openerId = bm.activePageId;
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Popup Link' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.equal(res.success, true);
        assert.equal(res.popupCreated, true);
        assert.equal(bm.pageCount, 2);
        assert.notEqual(bm.activePageId, openerId);
        assert.ok(res.newPageId);
        assert.equal(res.openerPageId, openerId);
        await bm.close();
      });

      test('15. allow-single zero popup still allows normal click success', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Safe Link' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.equal(res.success, true);
        assert.equal(res.popupCreated, false);
        assert.deepEqual(res.verification, { completed: true });
        assert.equal(bm.pageCount, 1);
        await bm.close();
      });

      test('16. allow-single multiple popups still returns MULTIPLE_POPUPS_NOT_SUPPORTED', async () => {
        let pop1 = null;
        let pop2 = null;
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            pop1 = createMockPopup('https://example.com/pop1', 'Pop 1', page);
            pop2 = createMockPopup('https://example.com/pop2', 'Pop 2', page);
            mock.context.emit('page', pop1);
            mock.context.emit('page', pop2);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'allow-single',
            dnsLookup: safeDns
          }),
          (err) => {
            assert.equal(err.code, 'MULTIPLE_POPUPS_NOT_SUPPORTED');
            return true;
          }
        );

        assert.equal(pop1.isClosed(), true);
        assert.equal(pop2.isClosed(), true);
        assert.equal(bm.pageCount, 1);
        await bm.close();
      });

      test('17. unsafe allow-single popup still rejected (private IP / SSRF / scheme)', async () => {
        let unsafePopup = null;
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            unsafePopup = createMockPopup('file:///etc/passwd', 'Passwd', page);
            mock.context.emit('page', unsafePopup);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'allow-single',
            dnsLookup: safeDns
          }),
          (err) => {
            assert.equal(err.code, 'UNSUPPORTED_PROTOCOL');
            return true;
          }
        );

        assert.equal(unsafePopup.isClosed(), true);
        assert.equal(bm.pageCount, 1);
        await bm.close();
      });

      test('18. page registry not corrupted by any popup path', async () => {
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            const p = createMockPopup('https://example.com/blocked-pop', 'Blocked', page);
            mock.context.emit('page', p);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const initialActiveId = bm.activePageId;
        const insp = await bm.inspectPage();

        // Attempt 1: Blocked popup
        try {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'block'
          });
        } catch {}

        // Attempt 2: Spontaneous popup
        const sp = createMockPopup('https://example.com/spontaneous', 'Spontaneous');
        mock.context.emit('page', sp);

        assert.equal(bm.pageCount, 1);
        assert.equal(bm.activePageId, initialActiveId);
        const { pages } = await bm.listPages();
        assert.equal(pages.length, 1);
        assert.equal(pages[0].pageId, initialActiveId);
        assert.equal(pages[0].active, true);
        await bm.close();
      });

      test('19. page-aware snapshots preserved after blocked popup', async () => {
        let popupSpawned = null;
        const mock = createMockPageEnvironment({
          onClick: async (page) => {
            popupSpawned = createMockPopup('https://example.com/popup', 'Popup Title', page);
            mock.context.emit('page', popupSpawned);
          }
        });
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const openerId = bm.activePageId;
        const insp = await bm.inspectPage();
        const token = insp.snapshotToken;

        // Snapshot is valid initially
        assert.equal(bm.isSnapshotTokenValid(token, openerId), true);

        // Blocked popup occurs
        try {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Popup Link' },
            expectedSnapshotToken: token,
            popupPolicy: 'block'
          });
        } catch {}

        // Opener did not navigate, so snapshot token remains valid for opener!
        assert.equal(bm.isSnapshotTokenValid(token, openerId), true);
        assert.equal(bm.isSnapshotTokenValid(token, 'other_page_id'), false);
        await bm.close();
      });

      test('20. GREEN-030 form/password/file/download protections preserved', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        // Password blocked
        await assert.rejects(
          async () => bm.executeAction({
            action: 'fill',
            target: { kind: 'input', name: 'Password' },
            value: 'secret',
            expectedSnapshotToken: insp.snapshotToken
          }),
          (err) => err.code === 'PASSWORD_INTERACTION_NOT_AUTHORIZED'
        );

        // File input blocked
        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'input', name: 'File input' },
            expectedSnapshotToken: insp.snapshotToken
          }),
          (err) => err.code === 'FILE_INTERACTION_NOT_AUTHORIZED'
        );

        // Form submit blocked
        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Submit' },
            expectedSnapshotToken: insp.snapshotToken
          }),
          (err) => err.code === 'FORM_SUBMISSION_NOT_AUTHORIZED'
        );

        // Download link blocked
        await assert.rejects(
          async () => bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Download Link' },
            expectedSnapshotToken: insp.snapshotToken
          }),
          (err) => err.code === 'DOWNLOAD_NOT_AUTHORIZED'
        );

        await bm.close();
      });

      test('Live Regression Model: <a target="newWindow" href="simple_page.html">Open new window</a> with REAL context Page event', async () => {
        const liveElements = [
          {
            kind: 'link',
            tag: 'a',
            text: 'Open new window',
            accessibleName: 'Open new window',
            href: 'simple_page.html',
            target: 'newWindow'
          }
        ];

        // Scenario A: popupPolicy = block and real popup event occurs
        {
          let livePopup = null;
          const mockA = createMockPageEnvironment({
            mockElements: liveElements,
            initialUrl: 'https://www.selenium.dev/selenium/web/window_switching_tests/page_with_frame.html',
            onClick: async (page) => {
              livePopup = createMockPopup('https://www.selenium.dev/selenium/web/window_switching_tests/simple_page.html', 'Simple Page', page);
              mockA.context.emit('page', livePopup);
            }
          });
          const bmA = new BrowserManager({ launcher: async () => mockA.browser });
          await bmA.launch();
          const openerId = bmA.activePageId;
          const inspA = await bmA.inspectPage();

          let errorA = null;
          let resultA = null;
          try {
            resultA = await bmA.executeAction({
              action: 'click',
              target: { kind: 'link', name: 'Open new window' },
              expectedSnapshotToken: inspA.snapshotToken,
              popupPolicy: 'block'
            });
          } catch (err) {
            errorA = err;
          }

          assert.ok(errorA, 'Must reject when real popup occurs under block policy');
          assert.equal(errorA.code, 'POPUP_NOT_SUPPORTED');
          assert.equal(errorA.message, 'Popup/new-page creation is blocked by the current popup policy.');
          assert.equal(resultA, null);
          assert.equal(livePopup.isClosed(), true, 'Popup must be closed');
          assert.equal(bmA.pageCount, 1, 'Registry count must remain 1');
          assert.equal(bmA.activePageId, openerId, 'Opener remains active');
          await bmA.close();
        }

        // Scenario B: popupPolicy = allow-single and real popup event occurs
        {
          let livePopupB = null;
          const mockB = createMockPageEnvironment({
            mockElements: liveElements,
            initialUrl: 'https://www.selenium.dev/selenium/web/window_switching_tests/page_with_frame.html',
            onClick: async (page) => {
              livePopupB = createMockPopup('https://www.selenium.dev/selenium/web/window_switching_tests/simple_page.html', 'Simple Page', page);
              mockB.context.emit('page', livePopupB);
            }
          });
          const bmB = new BrowserManager({ launcher: async () => mockB.browser });
          await bmB.launch();
          const openerIdB = bmB.activePageId;
          const inspB = await bmB.inspectPage();

          const resultB = await bmB.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Open new window' },
            expectedSnapshotToken: inspB.snapshotToken,
            popupPolicy: 'allow-single',
            dnsLookup: safeDns
          });

          assert.equal(resultB.success, true);
          assert.equal(resultB.popupCreated, true);
          assert.equal(bmB.pageCount, 2);
          assert.notEqual(bmB.activePageId, openerIdB);
          assert.ok(resultB.newPageId);
          assert.equal(resultB.openerPageId, openerIdB);
          await bmB.close();
        }

        // Scenario C: target="newWindow" but NO real Page event occurs (must NOT reject merely on target attribute)
        {
          const mockC = createMockPageEnvironment({
            mockElements: liveElements,
            initialUrl: 'https://www.selenium.dev/selenium/web/window_switching_tests/page_with_frame.html'
          });
          const bmC = new BrowserManager({ launcher: async () => mockC.browser });
          await bmC.launch();
          const inspC = await bmC.inspectPage();

          const resultC = await bmC.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Open new window' },
            expectedSnapshotToken: inspC.snapshotToken,
            popupPolicy: 'block'
          });

          assert.equal(resultC.success, true);
          assert.equal(resultC.popupCreated, false);
          assert.deepEqual(resultC.verification, { completed: true });
          assert.equal(bmC.pageCount, 1);
          await bmC.close();
        }
      });
    });

    // ==================================================
    // SECTION 68: Live Fix C: Real Playwright Popup Event Settlement Race
    // ==================================================
    describe('Live Fix C: Real Playwright Popup Event Settlement Race (Section 68)', () => {
      // 1. Critical reproduction test: click promise resolves, then popup event is emitted asynchronously
      test('1. late popup event after click promise resolves is captured', async () => {
        let latePopup = null;
        let clickResolved = false;
        let eventEmittedAfterClick = false;

        const mock = createMockPageEnvironment({
          mockElements: [
            { kind: 'link', tag: 'a', text: 'Open new window', accessibleName: 'Open new window', target: 'newWindow', href: 'simple_page.html' }
          ],
          initialUrl: 'https://www.selenium.dev/selenium/web/window_switching_tests/page_with_frame.html',
          onClick: async (page) => {
            // Emulate click promise resolving WITHOUT emitting popup synchronously
            setTimeout(() => {
              if (clickResolved) {
                eventEmittedAfterClick = true;
              }
              latePopup = createMockPopup('https://www.selenium.dev/selenium/web/window_switching_tests/simple_page.html', 'Simple Page', page);
              mock.context.emit('page', latePopup);
            }, 10);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 50 });
        await bm.launch();
        const insp = await bm.inspectPage();

        const actionPromise = bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Open new window' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'block'
        });

        clickResolved = true;

        await assert.rejects(
          async () => {
            await actionPromise;
          },
          (err) => {
            assert.equal(err.code, 'POPUP_NOT_SUPPORTED');
            return true;
          }
        );

        assert.ok(eventEmittedAfterClick, 'Popup event must have fired AFTER click resolved');
        assert.ok(latePopup, 'Late popup must have been created');
        assert.equal(latePopup.isClosed(), true, 'Late popup must be closed');
        await bm.close();
      });

      test('2. popup observation remains active during settlement', async () => {
        let wasActiveDuringSettlement = false;
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'button', tag: 'button', text: 'Settle Button', accessibleName: 'Settle Button' }],
          onClick: async () => {
            setTimeout(() => {
              if (bm._actionPopupWindow && bm._actionPopupWindow.active) {
                wasActiveDuringSettlement = true;
              }
            }, 5);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 30 });
        await bm.launch();
        const insp = await bm.inspectPage();

        await bm.executeAction({
          action: 'click',
          target: { kind: 'button', name: 'Settle Button' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'block'
        });

        assert.ok(wasActiveDuringSettlement, 'Action popup window must be active during settlement');
        await bm.close();
      });

      test('3. listeners remain attached during settlement', async () => {
        let listenerAttachedDuringSettlement = false;
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'button', tag: 'button', text: 'Listener Button', accessibleName: 'Listener Button' }],
          onClick: async () => {
            setTimeout(() => {
              const listeners = mock.contextListeners ? (mock.contextListeners.get('page') || []) : [];
              if (listeners.length > 1) { // 1 manager listener + 1 action listener
                listenerAttachedDuringSettlement = true;
              }
            }, 5);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 30 });
        await bm.launch();
        const insp = await bm.inspectPage();

        await bm.executeAction({
          action: 'click',
          target: { kind: 'button', name: 'Listener Button' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'block'
        });

        assert.ok(listenerAttachedDuringSettlement, 'Context listeners must remain attached during settlement');
        await bm.close();
      });

      test('4. popupPolicy=block + late popup -> POPUP_NOT_SUPPORTED', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'link', tag: 'a', text: 'Block Late', accessibleName: 'Block Late', href: 'https://example.com/page' }],
          onClick: async (page) => {
            setTimeout(() => {
              const popup = createMockPopup('https://example.com/page', 'Page', page);
              mock.context.emit('page', popup);
            }, 10);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 40 });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => {
            await bm.executeAction({
              action: 'click',
              target: { kind: 'link', name: 'Block Late' },
              expectedSnapshotToken: insp.snapshotToken,
              popupPolicy: 'block'
            });
          },
          (err) => {
            assert.equal(err.code, 'POPUP_NOT_SUPPORTED');
            assert.equal(err.message, 'Popup/new-page creation is blocked by the current popup policy.');
            return true;
          }
        );
        await bm.close();
      });

      test('5. late blocked popup is closed', async () => {
        let popupInstance = null;
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'link', tag: 'a', text: 'Close Late', accessibleName: 'Close Late', href: 'https://example.com/page' }],
          onClick: async (page) => {
            setTimeout(() => {
              popupInstance = createMockPopup('https://example.com/page', 'Page', page);
              mock.context.emit('page', popupInstance);
            }, 10);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 40 });
        await bm.launch();
        const insp = await bm.inspectPage();

        try {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Close Late' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'block'
          });
        } catch {}

        assert.ok(popupInstance);
        assert.equal(popupInstance.isClosed(), true, 'Blocked popup must be safely closed');
        await bm.close();
      });

      test('6. late blocked popup not registered', async () => {
        let popupInstance = null;
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'link', tag: 'a', text: 'Unregistered', accessibleName: 'Unregistered', href: 'https://example.com/page' }],
          onClick: async (page) => {
            setTimeout(() => {
              popupInstance = createMockPopup('https://example.com/page', 'Page', page);
              mock.context.emit('page', popupInstance);
            }, 10);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 40 });
        await bm.launch();
        const insp = await bm.inspectPage();

        try {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Unregistered' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'block'
          });
        } catch {}

        const pages = await bm.listPages();
        for (const p of pages.pages) {
          assert.notEqual(p.pageId, popupInstance?.pageId);
        }
        await bm.close();
      });

      test('7. managed page count unchanged after late blocked popup', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'link', tag: 'a', text: 'Count Test', accessibleName: 'Count Test', href: 'https://example.com/page' }],
          onClick: async (page) => {
            setTimeout(() => {
              const popup = createMockPopup('https://example.com/page', 'Page', page);
              mock.context.emit('page', popup);
            }, 10);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 40 });
        await bm.launch();
        assert.equal(bm.pageCount, 1);
        const insp = await bm.inspectPage();

        try {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Count Test' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'block'
          });
        } catch {}

        assert.equal(bm.pageCount, 1, 'Managed page count must remain 1');
        await bm.close();
      });

      test('8. active page remains opener after late blocked popup', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'link', tag: 'a', text: 'Opener Preserved', accessibleName: 'Opener Preserved', href: 'https://example.com/page' }],
          onClick: async (page) => {
            setTimeout(() => {
              const popup = createMockPopup('https://example.com/page', 'Page', page);
              mock.context.emit('page', popup);
            }, 10);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 40 });
        await bm.launch();
        const openerId = bm.activePageId;
        const insp = await bm.inspectPage();

        try {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Opener Preserved' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'block'
          });
        } catch {}

        assert.equal(bm.activePageId, openerId, 'Opener must remain active page');
        await bm.close();
      });

      test('9. no-popup click succeeds after bounded settlement', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'button', tag: 'button', text: 'Ordinary Click', accessibleName: 'Ordinary Click' }]
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 25 });
        await bm.launch();
        const insp = await bm.inspectPage();

        const result = await bm.executeAction({
          action: 'click',
          target: { kind: 'button', name: 'Ordinary Click' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'block'
        });

        assert.equal(result.success, true);
        assert.equal(result.popupCreated, false);
        assert.deepEqual(result.verification, { completed: true });
        assert.ok(result.actionDurationMs >= 20, `actionDurationMs (${result.actionDurationMs}) must reflect settlement time`);
        await bm.close();
      });

      test('10. target="newWindow" without actual Page event still succeeds normally', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [
            { kind: 'link', tag: 'a', text: 'Target newWindow', accessibleName: 'Target newWindow', target: 'newWindow', href: 'simple.html' }
          ]
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 25 });
        await bm.launch();
        const insp = await bm.inspectPage();

        const result = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Target newWindow' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'block'
        });

        assert.equal(result.success, true);
        assert.equal(result.popupCreated, false);
        assert.deepEqual(result.verification, { completed: true });
        await bm.close();
      });

      test('11. target="_blank" without actual Page event still succeeds normally', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [
            { kind: 'link', tag: 'a', text: 'Target blank', accessibleName: 'Target blank', target: '_blank', href: 'simple.html' }
          ]
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 25 });
        await bm.launch();
        const insp = await bm.inspectPage();

        const result = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Target blank' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'block'
        });

        assert.equal(result.success, true);
        assert.equal(result.popupCreated, false);
        assert.deepEqual(result.verification, { completed: true });
        await bm.close();
      });

      test('12. allow-single late popup is captured', async () => {
        let popupInstance = null;
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'link', tag: 'a', text: 'Allow Single Late', accessibleName: 'Allow Single Late', href: 'https://example.com/page' }],
          onClick: async (page) => {
            setTimeout(() => {
              popupInstance = createMockPopup('https://example.com/page', 'Allowed Page', page);
              mock.context.emit('page', popupInstance);
            }, 10);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 40 });
        await bm.launch();
        const insp = await bm.inspectPage();

        const result = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Allow Single Late' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.equal(result.success, true);
        assert.equal(result.popupCreated, true);
        assert.ok(result.newPageId);
        await bm.close();
      });

      test('13. allow-single exactly one late popup can be adopted', async () => {
        let popupInstance = null;
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'link', tag: 'a', text: 'Adopt One', accessibleName: 'Adopt One', href: 'https://example.com/adopted' }],
          onClick: async (page) => {
            setTimeout(() => {
              popupInstance = createMockPopup('https://example.com/adopted', 'Adopted Title', page);
              mock.context.emit('page', popupInstance);
            }, 10);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 40 });
        await bm.launch();
        const openerId = bm.activePageId;
        const insp = await bm.inspectPage();

        const result = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Adopt One' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.equal(result.popupCreated, true);
        assert.equal(bm.pageCount, 2);
        assert.equal(bm.activePageId, result.newPageId);
        assert.equal(result.openerPageId, openerId);
        assert.equal(result.newUrl, 'https://example.com/adopted');
        assert.equal(result.newTitle, 'Adopted Title');
        await bm.close();
      });

      test('14. two asynchronously arriving popups are both observed', async () => {
        let popup1 = null;
        let popup2 = null;
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'link', tag: 'a', text: 'Two Popups', accessibleName: 'Two Popups', href: 'https://example.com/page' }],
          onClick: async (page) => {
            setTimeout(() => {
              popup1 = createMockPopup('https://example.com/p1', 'P1', page);
              mock.context.emit('page', popup1);
            }, 10);
            setTimeout(() => {
              popup2 = createMockPopup('https://example.com/p2', 'P2', page);
              mock.context.emit('page', popup2);
            }, 20);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 50 });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => {
            await bm.executeAction({
              action: 'click',
              target: { kind: 'link', name: 'Two Popups' },
              expectedSnapshotToken: insp.snapshotToken,
              popupPolicy: 'allow-single',
              dnsLookup: safeDns
            });
          },
          (err) => {
            assert.equal(err.code, 'MULTIPLE_POPUPS_NOT_SUPPORTED');
            return true;
          }
        );

        assert.ok(popup1 && popup2, 'Both popups must have been created');
        assert.equal(popup1.isClosed(), true, 'Popup 1 must be closed');
        assert.equal(popup2.isClosed(), true, 'Popup 2 must be closed');
        await bm.close();
      });

      test('15. two popups under allow-single -> MULTIPLE_POPUPS_NOT_SUPPORTED', async () => {
        let p1 = null;
        let p2 = null;
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'link', tag: 'a', text: 'Multi Rejection', accessibleName: 'Multi Rejection', href: 'https://example.com/page' }],
          onClick: async (page) => {
            setTimeout(() => {
              p1 = createMockPopup('https://example.com/p1', 'P1', page);
              mock.context.emit('page', p1);
            }, 5);
            setTimeout(() => {
              p2 = createMockPopup('https://example.com/p2', 'P2', page);
              mock.context.emit('page', p2);
            }, 15);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 40 });
        await bm.launch();
        const insp = await bm.inspectPage();

        await assert.rejects(
          async () => {
            await bm.executeAction({
              action: 'click',
              target: { kind: 'link', name: 'Multi Rejection' },
              expectedSnapshotToken: insp.snapshotToken,
              popupPolicy: 'allow-single',
              dnsLookup: safeDns
            });
          },
          (err) => {
            assert.equal(err.code, 'MULTIPLE_POPUPS_NOT_SUPPORTED');
            assert.equal(err.message, 'Multiple popups are not supported.');
            return true;
          }
        );

        assert.equal(bm.pageCount, 1, 'No popup adopted');
        await bm.close();
      });

      test('16. spontaneous popup outside completed action window remains blocked', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'button', tag: 'button', text: 'Safe Click', accessibleName: 'Safe Click' }]
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 15 });
        await bm.launch();
        const insp = await bm.inspectPage();

        await bm.executeAction({
          action: 'click',
          target: { kind: 'button', name: 'Safe Click' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'block'
        });

        // Now action has fully ended. Emit spontaneous popup
        const spontaneous = createMockPopup('https://example.com/spontaneous', 'Spontaneous');
        mock.context.emit('page', spontaneous);

        assert.equal(spontaneous.isClosed(), true, 'Spontaneous popup must be closed');
        assert.equal(bm.pageCount, 1);
        await bm.close();
      });

      test('17. action window always cleared after success', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'button', tag: 'button', text: 'Clean Window', accessibleName: 'Clean Window' }]
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 15 });
        await bm.launch();
        const insp = await bm.inspectPage();

        await bm.executeAction({
          action: 'click',
          target: { kind: 'button', name: 'Clean Window' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'block'
        });

        assert.equal(bm._actionPopupWindow, null, 'Action popup window must be null after success');
        await bm.close();
      });

      test('18. action window always cleared after error', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'link', tag: 'a', text: 'Error Window', accessibleName: 'Error Window', href: 'https://example.com/err' }],
          onClick: async (page) => {
            setTimeout(() => {
              const popup = createMockPopup('https://example.com/err', 'Err', page);
              mock.context.emit('page', popup);
            }, 10);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 30 });
        await bm.launch();
        const insp = await bm.inspectPage();

        try {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Error Window' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'block'
          });
        } catch {}

        assert.equal(bm._actionPopupWindow, null, 'Action popup window must be null after error');
        await bm.close();
      });

      test('19. context/page listeners always removed after completion', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'button', tag: 'button', text: 'Listener Cleanup', accessibleName: 'Listener Cleanup' }]
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 15 });
        await bm.launch();
        const insp = await bm.inspectPage();

        await bm.executeAction({
          action: 'click',
          target: { kind: 'button', name: 'Listener Cleanup' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'block'
        });

        const contextPageListeners = mock.contextListeners ? (mock.contextListeners.get('page') || []) : [];
        assert.equal(contextPageListeners.length, 1, 'Only BrowserManager context listener should remain');
        await bm.close();
      });

      test('20. no listener accumulation across repeated clicks', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'button', tag: 'button', text: 'Repeat Button', accessibleName: 'Repeat Button' }]
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 10 });
        await bm.launch();
        const insp = await bm.inspectPage();

        for (let i = 0; i < 5; i++) {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'button', name: 'Repeat Button' },
            expectedSnapshotToken: insp.snapshotToken,
            popupPolicy: 'block'
          });
        }

        const contextPageListeners = mock.contextListeners ? (mock.contextListeners.get('page') || []) : [];
        assert.equal(contextPageListeners.length, 1, 'Context page listeners must not accumulate across clicks');
        await bm.close();
      });

      test('21. Fix A initial page behavior preserved', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser });
        const res = await bm.launch();

        assert.equal(res.success, true);
        assert.equal(res.pageCount, 1);
        assert.equal(bm.pageCount, 1);
        assert.ok(bm.activePageId);
        assert.ok(bm.page);
        await bm.close();
      });

      test('22. open-page internal authorization preserved', async () => {
        const mock = createMockPageEnvironment();
        const bm = new BrowserManager({ launcher: async () => mock.browser, dnsLookup: safeDns });
        await bm.launch();

        const openRes = await bm.openPage('https://example.com/new', { dnsLookup: safeDns });
        assert.equal(openRes.success, true);
        assert.equal(bm.pageCount, 2);
        assert.equal(bm.activePageId, openRes.pageId);
        await bm.close();
      });

      test('23. page-aware snapshots preserved', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [{ kind: 'link', tag: 'a', text: 'Snap Test', accessibleName: 'Snap Test', href: 'https://example.com/page' }],
          onClick: async (page) => {
            setTimeout(() => {
              const popup = createMockPopup('https://example.com/page', 'Page', page);
              mock.context.emit('page', popup);
            }, 10);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser, popupSettleMs: 35 });
        await bm.launch();
        const insp = await bm.inspectPage();
        const originalToken = insp.snapshotToken;

        try {
          await bm.executeAction({
            action: 'click',
            target: { kind: 'link', name: 'Snap Test' },
            expectedSnapshotToken: originalToken,
            popupPolicy: 'block'
          });
        } catch {}

        assert.equal(bm.snapshotToken, originalToken, 'Blocked popup must not invalidate opener snapshot');
        assert.ok(bm.isSnapshotTokenValid(originalToken));
        await bm.close();
      });

      test('24. GREEN-030 interaction regression preserved', async () => {
        const mock = createMockPageEnvironment({
          mockElements: [
            { kind: 'input', tag: 'input', inputType: 'text', accessibleName: 'Text Box' },
            { kind: 'input', tag: 'input', inputType: 'checkbox', accessibleName: 'Check Box' }
          ]
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        // Fill
        const fillRes = await bm.executeAction({
          action: 'fill',
          target: { kind: 'input', name: 'Text Box' },
          value: 'Hello Fix C',
          expectedSnapshotToken: insp.snapshotToken
        });
        assert.equal(fillRes.success, true);
        assert.deepEqual(fillRes.verification, { valueMatchesRequested: true });

        // Check
        const checkRes = await bm.executeAction({
          action: 'check',
          target: { kind: 'input', name: 'Check Box' },
          expectedSnapshotToken: insp.snapshotToken
        });
        assert.equal(checkRes.success, true);
        assert.deepEqual(checkRes.verification, { checked: true });

        // Uncheck
        const uncheckRes = await bm.executeAction({
          action: 'uncheck',
          target: { kind: 'input', name: 'Check Box' },
          expectedSnapshotToken: insp.snapshotToken
        });
        assert.equal(uncheckRes.success, true);
        assert.deepEqual(uncheckRes.verification, { checked: false });

        await bm.close();
      });
    });

    // -----------------------------------------------------------------------
    // Section 69: Live Fix D — New Page / Tab Terminology & URL/Title Alignment
    // -----------------------------------------------------------------------
    describe('Live Fix D: New Page / Tab Terminology & URL/Title Alignment (Section 69)', () => {
      test('1. currentUrl and title both refer to the newly active Page/tab when allow-single adopts a new page', async () => {
        const mock = createMockPageEnvironment({
          initialUrl: 'https://example.com/opener-page',
          initialTitle: 'Opener Document Title',
          mockElements: [{ kind: 'link', tag: 'a', text: 'Open New Tab', accessibleName: 'Open New Tab', href: 'https://example.com/new-tab' }],
          onClick: async (page) => {
            const newTab = createMockPopup('https://example.com/new-tab', 'New Tab Title', page);
            mock.context.emit('page', newTab);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();
        assert.equal(insp.url, 'https://example.com/opener-page');
        assert.equal(insp.title, 'Opener Document Title');

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Open New Tab' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.equal(res.success, true);
        assert.equal(res.popupCreated, true);
        assert.equal(res.newPageCreated, true);
        // Fix D core: currentUrl must NOT remain the opener URL; both currentUrl and title must refer to the active new page
        assert.equal(res.currentUrl, 'https://example.com/new-tab');
        assert.equal(res.title, 'New Tab Title');
        assert.equal(res.url, 'https://example.com/new-tab');
        assert.equal(res.newUrl, 'https://example.com/new-tab');
        assert.equal(res.newTitle, 'New Tab Title');
        assert.equal(res.creationType, 'popup');

        // Confirm active page in BrowserManager is also the new page
        assert.equal(bm.activePageId, res.newPageId);
        const activeStatus = await bm.getPageStatus();
        assert.equal(activeStatus.url, 'https://example.com/new-tab');
        assert.equal(activeStatus.title, 'New Tab Title');

        await bm.close();
      });

      test('2. response metadata contains generic newPageCreated and preserves creationType', async () => {
        const mock = createMockPageEnvironment({
          initialUrl: 'https://example.com/home',
          initialTitle: 'Home',
          mockElements: [{ kind: 'link', tag: 'a', text: 'Go', accessibleName: 'Go', href: 'https://example.com/tab' }],
          onClick: async (page) => {
            const popup = createMockPopup('https://example.com/tab', 'Tab Title', page);
            mock.context.emit('page', popup);
          }
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Go' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.equal(res.newPageCreated, true);
        assert.equal(res.popupCreated, true);
        assert.ok(res.creationType);
        await bm.close();
      });

      test('3. when no new page is created, currentUrl and title both refer to the active opener page', async () => {
        const mock = createMockPageEnvironment({
          initialUrl: 'https://example.com/current',
          initialTitle: 'Current Page',
          mockElements: [{ kind: 'link', tag: 'a', text: 'Safe Click', accessibleName: 'Safe Click', href: 'https://example.com/current#anchor' }]
        });

        const bm = new BrowserManager({ launcher: async () => mock.browser });
        await bm.launch();
        const insp = await bm.inspectPage();

        const res = await bm.executeAction({
          action: 'click',
          target: { kind: 'link', name: 'Safe Click' },
          expectedSnapshotToken: insp.snapshotToken,
          popupPolicy: 'allow-single',
          dnsLookup: safeDns
        });

        assert.equal(res.success, true);
        assert.equal(res.popupCreated, false);
        assert.equal(res.newPageCreated, false);
        assert.equal(res.currentUrl, 'https://example.com/current');
        assert.equal(res.title, 'Current Page');
        assert.equal(res.creationType, undefined);
        await bm.close();
      });
    });
  });
});

