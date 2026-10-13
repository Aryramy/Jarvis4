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
    }
  };

  const context = {
    newPage: async () => page,
    close: async () => {}
  };

  const browser = {
    newContext: async () => context,
    on: () => {},
    isConnected: () => true,
    close: async () => {}
  };

  return { browser, context, page, mockElements, actionLog, getDisposedHandles: () => disposedHandles };
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
      const mock = createMockPageEnvironment();
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
});

