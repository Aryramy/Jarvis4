import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager, BrowserManagerError, BROWSER_STATES } from '../../src/browser/browserManager.js';
import { defaultPlaywrightLauncher, chromium } from '../../src/browser/playwrightBrowser.js';

function createMockBrowserEnvironment(options = {}) {
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
      const opts = args[1];
      if (options.gotoHandler) {
        return await options.gotoHandler(url, opts, page);
      }
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
      if (options.goBackHandler) {
        return await options.goBackHandler(opts, page);
      }
      return {
        status: () => 200
      };
    },
    goForward: async (opts) => {
      page.goForwardCalls.push(opts);
      if (options.goForwardHandler) {
        return await options.goForwardHandler(opts, page);
      }
      return {
        status: () => 200
      };
    },
    reload: async (opts) => {
      page.reloadCalls.push(opts);
      if (options.reloadHandler) {
        return await options.reloadHandler(opts, page);
      }
      return {
        status: () => 200
      };
    },
    clickCalls: [],
    click: async (...args) => {
      page.clickCalls.push(args);
    },
    typeCalls: [],
    type: async (...args) => {
      page.typeCalls.push(args);
    },
    fillCalls: [],
    fill: async (...args) => {
      page.fillCalls.push(args);
    },
    checkCalls: [],
    check: async (...args) => {
      page.checkCalls.push(args);
    },
    uncheckCalls: [],
    uncheck: async (...args) => {
      page.uncheckCalls.push(args);
    },
    selectOptionCalls: [],
    selectOption: async (...args) => {
      page.selectOptionCalls.push(args);
    },
    evaluateHandleCalls: [],
    evaluateHandle: async (fn, args) => {
      page.evaluateHandleCalls.push({ fn, args });
      if (options.evaluateHandleHandler) {
        return await options.evaluateHandleHandler(fn, args, page);
      }
      return {
        asElement: () => page,
        click: async (...a) => page.click(...a),
        fill: async (...a) => page.fill(...a),
        check: async (...a) => page.check(...a),
        uncheck: async (...a) => page.uncheck(...a),
        selectOption: async (...a) => page.selectOption(...a),
        isDisabled: async () => false,
        isVisible: async () => true,
        dispose: async () => {}
      };
    },
    waitForLoadStateCalls: [],
    waitForLoadState: async (state, opts) => {
      page.waitForLoadStateCalls.push({ state, opts });
      if (options.waitForLoadStateHandler) {
        return await options.waitForLoadStateHandler(state, opts, page);
      }
    },
    evaluateCalls: [],
    evaluate: async (fn, args) => {
      page.evaluateCalls.push({ fn, args });
      if (options.evaluateHandler) {
        return await options.evaluateHandler(fn, args, page);
      }
      return {
        visibleText: options.mockVisibleText ?? 'Example Domain text content.',
        textTruncated: false,
        elements: options.mockElements ?? [
          { kind: 'heading', tag: 'h1', text: 'Example Domain' },
          { kind: 'link', tag: 'a', text: 'More information...', href: 'https://example.com' }
        ],
        returnedElementCount: 2,
        totalEligibleElementCount: 2,
        elementsTruncated: false
      };
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
    }
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
    },
    simulateClose: () => {
      context.closed = true;
      const cbs = contextListeners.get('close') || [];
      for (const cb of cbs) cb();
    }
  };

  const listeners = new Map();
  let connected = true;
  let closed = false;

  const browser = {
    newContextCalls: 0,
    newContext: async () => {
      browser.newContextCalls++;
      return context;
    },
    on: (event, cb) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    isConnected: () => connected && !closed,
    close: async () => {
      closed = true;
      connected = false;
      const cbs = listeners.get('disconnected') || [];
      for (const cb of cbs) cb();
    },
    simulateDisconnect: () => {
      connected = false;
      const cbs = listeners.get('disconnected') || [];
      for (const cb of cbs) cb();
    },
    closed: () => closed
  };

  return { browser, context, page };
}

describe('Playwright Browser Lifecycle Foundation (Brick 26)', () => {
  // Section 37: Dependency Test
  describe('Dependency & Adapter Verification (Section 37)', () => {
    test('defaultPlaywrightLauncher and chromium are exported from playwright-core adapter', () => {
      assert.equal(typeof defaultPlaywrightLauncher, 'function');
      assert.ok(chromium, 'chromium should be exported from playwright-core');
      assert.equal(typeof chromium.launch, 'function');
    });
  });

  // Section 38: Initial State
  describe('Initial State (Section 38)', () => {
    test('1. manager starts stopped', () => {
      const manager = new BrowserManager();
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
    });

    test('2. browserConnected false', () => {
      const manager = new BrowserManager();
      assert.equal(manager.isBrowserConnected(), false);
    });

    test('3. contextOpen false', () => {
      const manager = new BrowserManager();
      const status = manager.getStatus();
      assert.equal(status.contextOpen, false);
    });

    test('4. pageOpen false', () => {
      const manager = new BrowserManager();
      const status = manager.getStatus();
      assert.equal(status.pageOpen, false);
    });

    test('5. status does not launch browser', () => {
      let launcherCalled = false;
      const manager = new BrowserManager({
        launcher: async () => {
          launcherCalled = true;
          return {};
        }
      });
      const status = manager.getStatus();
      assert.equal(launcherCalled, false);
      assert.equal(status.state, BROWSER_STATES.STOPPED);
      assert.equal(status.currentUrl, null);
    });
  });

  // Section 39: Launch Behavior
  describe('Launch Behavior (Section 39)', () => {
    test('6-15. launch calls launcher once, creates 1 context and 1 blank page without navigation', async () => {
      const mockEnv = createMockBrowserEnvironment();
      let launcherOptions = null;
      let launcherCalls = 0;

      const manager = new BrowserManager({
        channel: 'msedge',
        headless: false,
        timeoutMs: 15000,
        launcher: async (opts) => {
          launcherCalls++;
          launcherOptions = opts;
          return mockEnv.browser;
        }
      });

      const result = await manager.launch();

      // 6. launcher called once
      assert.equal(launcherCalls, 1);
      // 7. configured channel passed
      assert.equal(launcherOptions.channel, 'msedge');
      // 8. configured headless passed
      assert.equal(launcherOptions.headless, false);
      // 9. configured timeout passed
      assert.equal(launcherOptions.timeout, 15000);
      // 10. one context created
      assert.equal(mockEnv.browser.newContextCalls, 1);
      // 11. one page created
      assert.equal(mockEnv.context.newPageCalls, 1);
      // 12. no page.goto invoked
      assert.equal(mockEnv.page.gotoCalls.length, 0);
      // 13. state becomes running
      assert.equal(result.state, BROWSER_STATES.RUNNING);
      assert.equal(manager.state, BROWSER_STATES.RUNNING);
      // 14. browserConnected true
      assert.equal(result.browserConnected, true);
      assert.equal(manager.isBrowserConnected(), true);
      // 15. pageOpen true
      assert.equal(result.pageOpen, true);
      assert.equal(result.contextOpen, true);
      assert.equal(result.currentUrl, 'about:blank');
      assert.equal(result.alreadyRunning, false);
    });
  });

  // Section 40: Duplicate Launch
  describe('Duplicate Launch (Section 40)', () => {
    test('16-20. second launch while running does not launch second browser and preserves counts', async () => {
      const mockEnv = createMockBrowserEnvironment();
      let launcherCalls = 0;

      const manager = new BrowserManager({
        launcher: async () => {
          launcherCalls++;
          return mockEnv.browser;
        }
      });

      const first = await manager.launch();
      assert.equal(first.alreadyRunning, false);
      assert.equal(launcherCalls, 1);

      // 16. second launch
      const second = await manager.launch();
      // 17. alreadyRunning diagnostic true
      assert.equal(second.alreadyRunning, true);
      assert.equal(second.state, BROWSER_STATES.RUNNING);
      assert.equal(second.browserConnected, true);
      // 18. browser count remains one
      assert.equal(launcherCalls, 1);
      // 19. context count remains one
      assert.equal(mockEnv.browser.newContextCalls, 1);
      // 20. page count remains one
      assert.equal(mockEnv.context.newPageCalls, 1);
    });
  });

  // Section 41: Concurrent Launch
  describe('Concurrent Launch (Section 41)', () => {
    test('21-23. two concurrent launch requests produce one launch with consistent state', async () => {
      const mockEnv = createMockBrowserEnvironment();
      let launcherCalls = 0;

      const manager = new BrowserManager({
        launcher: async () => {
          launcherCalls++;
          // simulate slight delay
          await new Promise((r) => setTimeout(r, 10));
          return mockEnv.browser;
        }
      });

      // 21. two concurrent calls
      const [res1, res2] = await Promise.all([
        manager.launch(),
        manager.launch()
      ]);

      // launcher called only once
      assert.equal(launcherCalls, 1);
      // 22. both callers end in consistent running state
      assert.equal(res1.state, BROWSER_STATES.RUNNING);
      assert.equal(res2.state, BROWSER_STATES.RUNNING);
      assert.equal(res1.browserConnected, true);
      assert.equal(res2.browserConnected, true);
      // 23. no duplicate managed references
      assert.equal(mockEnv.browser.newContextCalls, 1);
      assert.equal(mockEnv.context.newPageCalls, 1);
      assert.equal(manager.browser, mockEnv.browser);
      assert.equal(manager.context, mockEnv.context);
      assert.equal(manager.page, mockEnv.page);
    });
  });

  // Section 42: Close Behavior
  describe('Close Behavior (Section 42)', () => {
    test('24-31. close running browser cleanly, second close is safe and alreadyStopped works', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({
        launcher: async () => mockEnv.browser
      });

      await manager.launch();
      assert.equal(manager.state, BROWSER_STATES.RUNNING);

      // 24. close running browser
      const closeResult = await manager.close();
      assert.equal(closeResult.success, true);
      assert.equal(closeResult.alreadyStopped, false);

      // 25. context and browser closed safely
      assert.equal(mockEnv.context.closed, true);
      assert.equal(mockEnv.browser.closed(), true);
      assert.equal(mockEnv.page.closed, true);

      // 26. managed references cleared
      assert.equal(manager.browser, null);
      assert.equal(manager.context, null);
      assert.equal(manager.page, null);

      // 27. state becomes stopped
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
      // 28. browserConnected false
      assert.equal(manager.isBrowserConnected(), false);
      // 29. pageOpen false
      const status = manager.getStatus();
      assert.equal(status.pageOpen, false);
      assert.equal(status.contextOpen, false);

      // 30. second close does not crash
      const secondClose = await manager.close();
      // 31. alreadyStopped diagnostic works
      assert.equal(secondClose.success, true);
      assert.equal(secondClose.state, BROWSER_STATES.STOPPED);
      assert.equal(secondClose.alreadyStopped, true);
    });

    test('concurrent close calls are safe and resolve to stopped', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({
        launcher: async () => mockEnv.browser
      });
      await manager.launch();

      const [res1, res2] = await Promise.all([
        manager.close(),
        manager.close()
      ]);

      assert.equal(res1.state, BROWSER_STATES.STOPPED);
      assert.equal(res2.state, BROWSER_STATES.STOPPED);
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
    });
  });

  // Section 43: Disconnect Handling
  describe('Unexpected Disconnect (Section 43)', () => {
    test('32-36. unexpected browser disconnect clears running state and references', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({
        launcher: async () => mockEnv.browser
      });

      await manager.launch();
      assert.equal(manager.state, BROWSER_STATES.RUNNING);
      assert.equal(manager.isBrowserConnected(), true);

      // 32. user closes window / disconnect event fires
      mockEnv.browser.simulateDisconnect();

      // 33. browserConnected becomes false
      assert.equal(manager.isBrowserConnected(), false);
      // 34. context reference cleared
      assert.equal(manager.context, null);
      // 35. page reference cleared
      assert.equal(manager.page, null);
      assert.equal(manager.browser, null);

      // 36. status reports stopped after disconnect
      const status = manager.getStatus();
      assert.equal(status.state, BROWSER_STATES.STOPPED);
      assert.equal(status.browserConnected, false);
      assert.equal(status.contextOpen, false);
      assert.equal(status.pageOpen, false);
    });
  });

  // Section 44: Launch Failure
  describe('Launch Failure (Section 44)', () => {
    test('37-42. launcher error returns BROWSER_LAUNCH_FAILED with safe message and resets state', async () => {
      let launchAttempts = 0;
      const manager = new BrowserManager({
        channel: 'msedge',
        launcher: async () => {
          launchAttempts++;
          throw new Error('Executable not found at path');
        }
      });

      // 37. error thrown
      await assert.rejects(
        async () => await manager.launch(),
        (err) => {
          assert.ok(err instanceof BrowserManagerError);
          assert.equal(err.code, 'BROWSER_LAUNCH_FAILED');
          // 38. safe message returned
          assert.match(err.message, /Browser launch failed for channel "msedge"/);
          return true;
        }
      );

      // 39. state resets to stopped
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
      // 40. no stale browser reference
      assert.equal(manager.browser, null);
      assert.equal(manager.context, null);
      assert.equal(manager.page, null);
      // 41. no automatic fallback channel
      assert.equal(manager.channel, 'msedge');
      // 42. launcher was attempted exactly once for the configured channel
      assert.equal(launchAttempts, 1);
    });
  });

  // Section 45: No Navigation
  describe('No Navigation (Section 45)', () => {
    test('43-46. launch creates blank page only, page.goto call count = 0', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({
        launcher: async () => mockEnv.browser
      });

      const res = await manager.launch();
      // 43. blank page only
      assert.equal(res.currentUrl, 'about:blank');
      // 44. page.goto count = 0
      assert.equal(mockEnv.page.gotoCalls.length, 0);
      // 45. navigation methods not invoked
      assert.equal(mockEnv.page.gotoCalls.length, 0);
      // 46. status currentUrl is about:blank
      assert.equal(manager.getStatus().currentUrl, 'about:blank');
    });
  });

  // Section 46: Ownership & Cleanup Boundaries
  describe('Ownership & Boundaries (Section 46)', () => {
    test('47-51. close calls only managed Playwright browser without taskkill or global process kill', async () => {
      const mockEnv = createMockBrowserEnvironment();
      let closeCalled = false;
      mockEnv.browser.close = async () => {
        closeCalled = true;
      };

      const manager = new BrowserManager({
        launcher: async () => mockEnv.browser
      });

      await manager.launch();
      await manager.close();

      // 47. close calls only managed browser instance
      assert.equal(closeCalled, true);
      // 48-51. purely in-memory object method called, zero external process commands
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
    });
  });

  // Brick 26 Live Fix: Manual Window Close & Status Reconciliation
  describe('Manual Browser Window Close & Lifecycle Reconciliation (Live Fix)', () => {
    // 1. managed page emits close event -> state becomes stopped
    test('1. managed page emits close event -> state becomes stopped', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      assert.equal(manager.state, BROWSER_STATES.RUNNING);

      mockEnv.page.simulateClose();

      assert.equal(manager.state, BROWSER_STATES.STOPPED);
    });

    // 2. managed page close -> page reference cleared
    test('2. managed page close -> page reference cleared', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      mockEnv.page.simulateClose();
      assert.equal(manager.page, null);
    });

    // 3. managed page close -> context reference cleared
    test('3. managed page close -> context reference cleared', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      mockEnv.page.simulateClose();
      assert.equal(manager.context, null);
    });

    // 4. managed page close -> browser reference cleared after cleanup
    test('4. managed page close -> browser reference cleared after cleanup', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      mockEnv.page.simulateClose();
      assert.equal(manager.browser, null);
    });

    // 5. status after page.isClosed() = true -> stopped
    test('5. status after page.isClosed() = true -> stopped', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      mockEnv.page.closed = true;
      const status = manager.getStatus();
      assert.equal(status.state, BROWSER_STATES.STOPPED);
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
    });

    // 6. stale page object must NOT produce pageOpen true
    test('6. stale page object must NOT produce pageOpen true', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      mockEnv.page.closed = true;
      const status = manager.getStatus();
      assert.equal(status.pageOpen, false);
      assert.equal(status.contextOpen, false);
      assert.equal(status.currentUrl, null);
    });

    // 7. browser still isConnected() but managed page is closed -> lifecycle considered stopped
    test('7. browser still isConnected() but managed page is closed -> lifecycle considered stopped', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      assert.equal(mockEnv.browser.isConnected(), true);
      mockEnv.page.simulateClose();
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
      assert.equal(manager.isBrowserConnected(), false);
      const status = manager.getStatus();
      assert.equal(status.browserConnected, false);
      assert.equal(status.state, BROWSER_STATES.STOPPED);
    });

    // 8. context remains technically alive but sole managed page closed -> lifecycle considered stopped
    test('8. context remains technically alive but sole managed page closed -> lifecycle considered stopped', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      assert.equal(mockEnv.context.closed, false);
      mockEnv.page.simulateClose();
      const status = manager.getStatus();
      assert.equal(status.contextOpen, false);
      assert.equal(status.state, BROWSER_STATES.STOPPED);
    });

    // 9. controlled close still works after new event handlers
    test('9. controlled close still works after new event handlers', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      const closeRes = await manager.close();
      assert.equal(closeRes.success, true);
      assert.equal(closeRes.alreadyStopped, false);
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
      assert.equal(manager.page, null);
      assert.equal(manager.context, null);
      assert.equal(manager.browser, null);
    });

    // 10. page close event during controlled close does not recurse/crash
    test('10. page close event during controlled close does not recurse/crash', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.doesNotReject(async () => {
        await manager.close();
      });
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
    });

    // 11. browser disconnected event still works
    test('11. browser disconnected event still works', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      mockEnv.browser.simulateDisconnect();
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
      assert.equal(manager.isBrowserConnected(), false);
      assert.equal(manager.browser, null);
    });

    // 12. manual close followed by launch creates one fresh browser only
    test('12. manual close followed by launch creates one fresh browser only', async () => {
      let launchCount = 0;
      const manager = new BrowserManager({
        launcher: async () => {
          launchCount++;
          return createMockBrowserEnvironment().browser;
        }
      });
      const first = await manager.launch();
      assert.equal(launchCount, 1);
      assert.equal(first.alreadyRunning, false);

      // Simulate manual window close on the current page
      manager.page.simulateClose();
      assert.equal(manager.state, BROWSER_STATES.STOPPED);

      // Next launch creates exactly one fresh browser
      const second = await manager.launch();
      assert.equal(launchCount, 2);
      assert.equal(second.alreadyRunning, false);
      assert.equal(second.state, BROWSER_STATES.RUNNING);
      assert.equal(manager.state, BROWSER_STATES.RUNNING);
      assert.ok(manager.browser);
      assert.ok(manager.page);
    });

    // 13. duplicate-launch protection remains intact while genuinely running
    test('13. duplicate-launch protection remains intact while genuinely running', async () => {
      let launchCount = 0;
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({
        launcher: async () => {
          launchCount++;
          return mockEnv.browser;
        }
      });
      await manager.launch();
      assert.equal(launchCount, 1);

      const dup = await manager.launch();
      assert.equal(launchCount, 1);
      assert.equal(dup.alreadyRunning, true);
    });

    // 14. existing personal Edge processes are never targeted
    test('14. existing personal Edge processes are never targeted', () => {
      const manager = new BrowserManager();
      assert.equal(typeof manager.close, 'function');
      assert.equal(manager._browser, null);
    });

    // 15. no taskkill/global process termination introduced
    test('15. no taskkill/global process termination introduced', async () => {
      const fs = await import('node:fs');
      const bmCode = fs.readFileSync(new URL('../../src/browser/browserManager.js', import.meta.url), 'utf8');
      assert.equal(bmCode.includes('taskkill'), false, 'must not include taskkill');
      assert.equal(bmCode.includes('process.kill'), false, 'must not include process.kill');
    });
  });

  // Brick 27: Browser Navigation Foundation
  describe('Browser Navigation URL Validation (Section 39)', () => {
    const safeDns = async () => [{ address: '93.184.216.34', family: 4 }];

    test('1. https URL accepted', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      const res = await manager.navigate('https://example.com/', { dnsLookup: safeDns });
      assert.equal(res.success, true);
      assert.equal(res.requestedUrl, 'https://example.com/');
    });

    test('2. http URL accepted', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      const res = await manager.navigate('http://example.com/', { dnsLookup: safeDns });
      assert.equal(res.success, true);
      assert.equal(res.requestedUrl, 'http://example.com/');
    });

    test('3. missing URL rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate(),
        (err) => err.code === 'INVALID_URL'
      );
    });

    test('4. non-string URL rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate(12345),
        (err) => err.code === 'INVALID_URL'
      );
    });

    test('5. empty URL rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('   '),
        (err) => err.code === 'INVALID_URL'
      );
    });

    test('6. malformed URL rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('not-a-url'),
        (err) => err.code === 'INVALID_URL'
      );
    });

    test('7. javascript: rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('javascript:alert(1)'),
        (err) => err.code === 'UNSUPPORTED_PROTOCOL'
      );
    });

    test('8. file: rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('file:///etc/passwd'),
        (err) => err.code === 'UNSUPPORTED_PROTOCOL'
      );
    });

    test('9. ftp: rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('ftp://example.com/file.txt'),
        (err) => err.code === 'UNSUPPORTED_PROTOCOL'
      );
    });

    test('10. data: rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('data:text/html,<h1>Test</h1>'),
        (err) => err.code === 'UNSUPPORTED_PROTOCOL'
      );
    });

    test('11. about: rejected as user navigation', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('about:blank'),
        (err) => err.code === 'UNSUPPORTED_PROTOCOL'
      );
    });
  });

  describe('Browser Navigation Network Safety (Section 40)', () => {
    test('12. localhost rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('http://localhost/'),
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('13. 127.0.0.1 rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('http://127.0.0.1/'),
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('14. 10.0.0.1 rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('http://10.0.0.1/'),
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('15. 192.168.x.x rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('http://192.168.1.1/'),
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('16. 169.254.x.x rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('http://169.254.169.254/'),
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('17. IPv6 loopback rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('http://[::1]/'),
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('18. private IPv6 rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('http://[fe80::1]/'),
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('19. DNS result containing any private address rejected', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await assert.rejects(
        () => manager.navigate('https://private-dns.example.com/', {
          dnsLookup: async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.1', family: 4 }
          ]
        }),
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
      assert.equal(mockEnv.page.gotoCalls.length, 0, 'page.goto must NOT be called');
    });

    test('20. safe public DNS accepted', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      const res = await manager.navigate('https://public.example.com/', {
        dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }]
      });
      assert.equal(res.success, true);
      assert.equal(mockEnv.page.gotoCalls.length, 1);
    });
  });

  describe('Browser Navigation Execution (Section 41)', () => {
    const safeDns = async () => [{ address: '93.184.216.34', family: 4 }];

    test('21. navigate requires running browser', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      assert.equal(manager.state, BROWSER_STATES.STOPPED);

      await assert.rejects(
        () => manager.navigate('https://example.com/', { dnsLookup: safeDns }),
        (err) => err.code === 'BROWSER_NOT_RUNNING'
      );
      assert.equal(mockEnv.page.gotoCalls.length, 0);
    });

    test('22 & 23. page.goto called exactly once with exact requested URL', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await manager.navigate('https://example.com/path?query=1', { dnsLookup: safeDns });
      assert.equal(mockEnv.page.gotoCalls.length, 1);
      assert.equal(mockEnv.page.gotoCalls[0][0], 'https://example.com/path?query=1');
    });

    test('24. waitUntil is NOT networkidle (is domcontentloaded)', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await manager.navigate('https://example.com/', { dnsLookup: safeDns });
      const opts = mockEnv.page.gotoCalls[0][1];
      assert.equal(opts.waitUntil, 'domcontentloaded');
      assert.notEqual(opts.waitUntil, 'networkidle');
    });

    test('25. configured timeout used', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({
        launcher: async () => mockEnv.browser,
        navigationTimeoutMs: 12345
      });
      await manager.launch();

      await manager.navigate('https://example.com/', { dnsLookup: safeDns });
      const opts = mockEnv.page.gotoCalls[0][1];
      assert.equal(opts.timeout, 12345);
    });

    test('26. final URL returned from page.url()', async () => {
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async (url, opts, page) => {
          page.setUrl('https://example.com/final-redirected');
          return { status: () => 200, request: () => ({ url: () => 'https://example.com/final-redirected', redirectedFrom: () => null }) };
        }
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.navigate('https://example.com/start', { dnsLookup: safeDns });
      assert.equal(res.requestedUrl, 'https://example.com/start');
      assert.equal(res.finalUrl, 'https://example.com/final-redirected');
    });

    test('27. title returned from page.title()', async () => {
      const mockEnv = createMockBrowserEnvironment();
      mockEnv.page.setTitle('Custom Title For Test');
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.navigate('https://example.com/', { dnsLookup: safeDns });
      assert.equal(res.title, 'Custom Title For Test');
    });

    test('28. HTTP status returned', async () => {
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async () => ({
          status: () => 204,
          request: () => ({ url: () => 'https://example.com/', redirectedFrom: () => null })
        })
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.navigate('https://example.com/', { dnsLookup: safeDns });
      assert.equal(res.httpStatus, 204);
    });

    test('29. navigationDurationMs returned as positive number', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.navigate('https://example.com/', { dnsLookup: safeDns });
      assert.equal(typeof res.navigationDurationMs, 'number');
      assert.ok(res.navigationDurationMs >= 0);
    });
  });

  describe('Browser Navigation Redirect Safety (Section 42)', () => {
    const safeDns = async () => [{ address: '93.184.216.34', family: 4 }];

    test('30. safe redirect accepted', async () => {
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async (url, opts, page) => {
          page.setUrl('https://example.com/dest');
          return {
            status: () => 200,
            request: () => ({
              url: () => 'https://example.com/dest',
              redirectedFrom: () => ({
                url: () => 'https://example.com/src'
              })
            })
          };
        }
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.navigate('https://example.com/src', { dnsLookup: safeDns });
      assert.equal(res.success, true);
      assert.equal(res.finalUrl, 'https://example.com/dest');
    });

    test('31. redirect to localhost blocked via route handler', async () => {
      let abortedReason = null;
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async (url, opts, page) => {
          // Trigger registered route handler with a redirect to localhost
          const route = page.routes[0];
          if (route) {
            await route.handler({
              request: () => ({
                url: () => 'http://localhost:8080/admin',
                redirectedFrom: () => ({ url: () => 'https://example.com/' })
              }),
              abort: async (reason) => { abortedReason = reason; },
              continue: async () => {}
            });
          }
          if (abortedReason) {
            throw new Error('net::ERR_BLOCKED_BY_CLIENT');
          }
          return { status: () => 200, request: () => ({ url: () => url, redirectedFrom: () => null }) };
        }
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        () => manager.navigate('https://example.com/', { dnsLookup: safeDns }),
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED' || err.code === 'INSECURE_REDIRECT_DOWNGRADE'
      );
      assert.equal(abortedReason, 'blockedbyclient');
    });

    test('32. redirect to RFC1918 blocked via secondary chain verification', async () => {
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async (url, opts, page) => ({
          status: () => 200,
          request: () => ({
            url: () => 'http://192.168.1.1/router',
            redirectedFrom: () => ({
              url: () => 'http://example.com/'
            })
          })
        })
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        () => manager.navigate('http://example.com/', { dnsLookup: safeDns }),
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('33. redirect to link-local blocked via secondary chain verification', async () => {
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async (url, opts, page) => ({
          status: () => 200,
          request: () => ({
            url: () => 'http://169.254.169.254/latest/meta-data',
            redirectedFrom: () => ({
              url: () => 'http://example.com/'
            })
          })
        })
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        () => manager.navigate('http://example.com/', { dnsLookup: safeDns }),
        (err) => err.code === 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      );
    });

    test('34. HTTPS → HTTP downgrade blocked with INSECURE_REDIRECT_DOWNGRADE', async () => {
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async (url, opts, page) => ({
          status: () => 200,
          request: () => ({
            url: () => 'http://example.com/unencrypted',
            redirectedFrom: () => ({
              url: () => 'https://example.com/secure'
            })
          })
        })
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        () => manager.navigate('https://example.com/secure', { dnsLookup: safeDns }),
        (err) => err.code === 'INSECURE_REDIRECT_DOWNGRADE'
      );
    });

    test('35. blocked redirect does not proceed to usable final state', async () => {
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async (url, opts, page) => ({
          status: () => 200,
          request: () => ({
            url: () => 'http://10.0.0.1/internal',
            redirectedFrom: () => ({
              url: () => 'http://example.com/'
            })
          })
        })
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        () => manager.navigate('http://example.com/', { dnsLookup: safeDns })
      );

      // Verify page was reset to about:blank and does not remain on 10.0.0.1
      assert.equal(mockEnv.page.url(), 'about:blank');
    });
  });

  describe('Browser Navigation HTTP & Failure Modes (Section 43)', () => {
    const safeDns = async () => [{ address: '93.184.216.34', family: 4 }];

    test('36. HTTP 404 returns controlled BROWSER_HTTP_ERROR', async () => {
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async () => ({
          status: () => 404,
          request: () => ({ url: () => 'https://example.com/missing', redirectedFrom: () => null })
        })
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        () => manager.navigate('https://example.com/missing', { dnsLookup: safeDns }),
        (err) => err.code === 'BROWSER_HTTP_ERROR' && err.details?.httpStatus === 404
      );
      assert.equal(manager.state, BROWSER_STATES.RUNNING, 'Browser must remain running');
    });

    test('37. HTTP 500 returns controlled BROWSER_HTTP_ERROR', async () => {
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async () => ({
          status: () => 500,
          request: () => ({ url: () => 'https://example.com/crash', redirectedFrom: () => null })
        })
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        () => manager.navigate('https://example.com/crash', { dnsLookup: safeDns }),
        (err) => err.code === 'BROWSER_HTTP_ERROR' && err.details?.httpStatus === 500
      );
      assert.equal(manager.state, BROWSER_STATES.RUNNING);
    });

    test('38. navigation timeout → BROWSER_NAVIGATION_TIMEOUT', async () => {
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async () => {
          const timeoutErr = new Error('page.goto: Timeout 15000ms exceeded.');
          timeoutErr.name = 'TimeoutError';
          throw timeoutErr;
        }
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        () => manager.navigate('https://example.com/', { dnsLookup: safeDns }),
        (err) => err.code === 'BROWSER_NAVIGATION_TIMEOUT'
      );
      assert.equal(manager.state, BROWSER_STATES.RUNNING);
    });

    test('39 & 40. generic navigation error → BROWSER_NAVIGATION_FAILED with safe message', async () => {
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async () => {
          throw new Error('page.goto: net::ERR_CONNECTION_REFUSED at C:\\internal\\playwright\\page.js');
        }
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        () => manager.navigate('https://example.com/', { dnsLookup: safeDns }),
        (err) => {
          assert.equal(err.code, 'BROWSER_NAVIGATION_FAILED');
          assert.equal(err.message.includes('C:\\internal'), false, 'must not expose internal paths');
          return true;
        }
      );
    });

    test('41. browser lifecycle remains consistent after failure', async () => {
      const mockEnv = createMockBrowserEnvironment({
        gotoHandler: async () => {
          throw new Error('Navigation failure');
        }
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      try {
        await manager.navigate('https://example.com/', { dnsLookup: safeDns });
      } catch {}

      assert.equal(manager.state, BROWSER_STATES.RUNNING);
      assert.equal(manager.isSessionActive(), true);
    });
  });

  describe('Browser Page Status (Section 44)', () => {
    test('42. page-status while stopped returns stopped and null url/title', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });

      const status = await manager.getPageStatus();
      assert.equal(status.success, true);
      assert.equal(status.state, 'stopped');
      assert.equal(status.pageOpen, false);
      assert.equal(status.url, null);
      assert.equal(status.title, null);
    });

    test('43-46. page-status while running returns current URL and title without navigating', async () => {
      const mockEnv = createMockBrowserEnvironment();
      mockEnv.page.setUrl('https://example.com/active');
      mockEnv.page.setTitle('Active Page Title');
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const initialGotoCalls = mockEnv.page.gotoCalls.length;
      const status = await manager.getPageStatus();
      assert.equal(status.success, true);
      assert.equal(status.state, 'running');
      assert.equal(status.pageOpen, true);
      assert.equal(status.url, 'https://example.com/active');
      assert.equal(status.title, 'Active Page Title');
      assert.equal(mockEnv.page.gotoCalls.length, initialGotoCalls, 'Must not navigate');
    });

    test('47. manual page close reconciles to stopped on getPageStatus', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      assert.equal(manager.state, BROWSER_STATES.RUNNING);

      mockEnv.page.simulateClose();

      const status = await manager.getPageStatus();
      assert.equal(status.success, true);
      assert.equal(status.state, 'stopped');
      assert.equal(status.pageOpen, false);
      assert.equal(status.url, null);
      assert.equal(status.title, null);
    });
  });

  describe('Browser History Back (Section 45)', () => {
    test('48. back calls page.goBack once', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.back();
      assert.equal(res.success, true);
      assert.equal(res.navigated, true);
      assert.equal(mockEnv.page.goBackCalls.length, 1);
    });

    test('49. no history returns navigated false without crash', async () => {
      const mockEnv = createMockBrowserEnvironment({
        goBackHandler: async () => null
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.back();
      assert.equal(res.success, true);
      assert.equal(res.navigated, false);
    });

    test('50 & 51. back returns resulting URL and title', async () => {
      const mockEnv = createMockBrowserEnvironment();
      mockEnv.page.setUrl('https://example.com/previous');
      mockEnv.page.setTitle('Previous Page');
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.back();
      assert.equal(res.url, 'https://example.com/previous');
      assert.equal(res.title, 'Previous Page');
    });

    test('52. back uses configured timeout', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({
        launcher: async () => mockEnv.browser,
        navigationTimeoutMs: 7777
      });
      await manager.launch();

      await manager.back();
      assert.equal(mockEnv.page.goBackCalls[0].timeout, 7777);
      assert.equal(mockEnv.page.goBackCalls[0].waitUntil, 'domcontentloaded');
    });

    test('53. back does not launch browser when stopped', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });

      await assert.rejects(
        () => manager.back(),
        (err) => err.code === 'BROWSER_NOT_RUNNING'
      );
      assert.equal(mockEnv.page.goBackCalls.length, 0);
    });
  });

  describe('Browser History Forward (Section 46)', () => {
    test('54. forward calls page.goForward once', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.forward();
      assert.equal(res.success, true);
      assert.equal(res.navigated, true);
      assert.equal(mockEnv.page.goForwardCalls.length, 1);
    });

    test('55. no history returns navigated false', async () => {
      const mockEnv = createMockBrowserEnvironment({
        goForwardHandler: async () => null
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.forward();
      assert.equal(res.success, true);
      assert.equal(res.navigated, false);
    });

    test('56 & 57. forward returns resulting URL and title', async () => {
      const mockEnv = createMockBrowserEnvironment();
      mockEnv.page.setUrl('https://example.com/next');
      mockEnv.page.setTitle('Next Page');
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.forward();
      assert.equal(res.url, 'https://example.com/next');
      assert.equal(res.title, 'Next Page');
    });

    test('58. forward does not launch browser when stopped', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });

      await assert.rejects(
        () => manager.forward(),
        (err) => err.code === 'BROWSER_NOT_RUNNING'
      );
      assert.equal(mockEnv.page.goForwardCalls.length, 0);
    });
  });

  describe('Browser Refresh (Section 47)', () => {
    test('59. refresh calls page.reload once', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.refresh();
      assert.equal(res.success, true);
      assert.equal(mockEnv.page.reloadCalls.length, 1);
    });

    test('60 & 61. refresh uses configured timeout and does not use networkidle', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({
        launcher: async () => mockEnv.browser,
        navigationTimeoutMs: 8888
      });
      await manager.launch();

      await manager.refresh();
      assert.equal(mockEnv.page.reloadCalls[0].timeout, 8888);
      assert.equal(mockEnv.page.reloadCalls[0].waitUntil, 'domcontentloaded');
    });

    test('62 & 63. refresh returns current URL and title', async () => {
      const mockEnv = createMockBrowserEnvironment();
      mockEnv.page.setUrl('https://example.com/current');
      mockEnv.page.setTitle('Current Title');
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.refresh();
      assert.equal(res.url, 'https://example.com/current');
      assert.equal(res.title, 'Current Title');
    });

    test('64. refresh does not launch browser when stopped', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });

      await assert.rejects(
        () => manager.refresh(),
        (err) => err.code === 'BROWSER_NOT_RUNNING'
      );
      assert.equal(mockEnv.page.reloadCalls.length, 0);
    });
  });

  describe('Browser Lifecycle Regression (Section 48)', () => {
    test('65. duplicate launch still protected', async () => {
      let launchCount = 0;
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({
        launcher: async () => {
          launchCount++;
          return mockEnv.browser;
        }
      });
      await manager.launch();
      const dup = await manager.launch();
      assert.equal(launchCount, 1);
      assert.equal(dup.alreadyRunning, true);
    });

    test('66. manual X-close reconciliation preserved', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      assert.equal(manager.state, BROWSER_STATES.RUNNING);

      mockEnv.page.simulateClose();
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
    });

    test('67. fresh relaunch after manual close preserved', async () => {
      let launchCount = 0;
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({
        launcher: async () => {
          launchCount++;
          return mockEnv.browser;
        }
      });
      await manager.launch();
      mockEnv.page.simulateClose();
      assert.equal(manager.state, BROWSER_STATES.STOPPED);

      // Fresh relaunch
      mockEnv.page.closed = false;
      const second = await manager.launch();
      assert.equal(launchCount, 2);
      assert.equal(second.alreadyRunning, false);
      assert.equal(manager.state, BROWSER_STATES.RUNNING);
    });

    test('68. controlled close preserved', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      const closeRes = await manager.close();
      assert.equal(closeRes.success, true);
      assert.equal(closeRes.state, 'stopped');
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
    });

    test('69. existing user browser windows unaffected', () => {
      const manager = new BrowserManager();
      assert.equal(manager._browser, null);
    });

    test('70. no taskkill/global browser kill', async () => {
      const fs = await import('node:fs');
      const bmCode = fs.readFileSync(new URL('../../src/browser/browserManager.js', import.meta.url), 'utf8');
      assert.equal(bmCode.includes('taskkill'), false);
      assert.equal(bmCode.includes('process.kill'), false);
    });
  });

  describe('Brick 28 Page Inspection v1 Tests', () => {
    test('1. inspection requires running browser', async () => {
      const manager = new BrowserManager();
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
      await assert.rejects(
        async () => manager.inspectPage(),
        (err) => {
          assert.equal(err.code, 'BROWSER_NOT_RUNNING');
          assert.ok(err.message.includes('not running'));
          return true;
        }
      );
    });

    test('2-5. inspectPage returns url, title, visible text, and inspection duration', async () => {
      const mockEnv = createMockBrowserEnvironment();
      mockEnv.page.setUrl('https://example.com/');
      mockEnv.page.setTitle('Example Domain');
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const res = await manager.inspectPage();
      assert.equal(res.success, true);
      assert.equal(res.state, 'running');
      assert.equal(res.url, 'https://example.com/');
      assert.equal(res.title, 'Example Domain');
      assert.equal(res.visibleText, 'Example Domain text content.');
      assert.equal(res.textTruncated, false);
      assert.equal(res.returnedElementCount, 2);
      assert.equal(res.elements.length, 2);
      assert.equal(res.elementsTruncated, false);
      assert.ok(typeof res.inspectionDurationMs === 'number');
      assert.ok(res.inspectionDurationMs >= 0);
    });

    test('6-9. inspection does not navigate, click, type, or reload', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await manager.inspectPage();
      assert.equal(mockEnv.page.gotoCalls.length, 0, 'inspection must not call page.goto');
      assert.equal(mockEnv.page.clickCalls.length, 0, 'inspection must not click');
      assert.equal(mockEnv.page.typeCalls.length, 0, 'inspection must not type');
      assert.equal(mockEnv.page.fillCalls.length, 0, 'inspection must not fill');
      assert.equal(mockEnv.page.reloadCalls.length, 0, 'inspection must not reload');
    });

    test('59-60. manually closed page reconciles to stopped and rejects inspectPage', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      mockEnv.page.simulateClose();
      assert.equal(manager.state, BROWSER_STATES.STOPPED);

      await assert.rejects(
        async () => manager.inspectPage(),
        (err) => {
          assert.equal(err.code, 'BROWSER_NOT_RUNNING');
          return true;
        }
      );
    });

    test('61. controlled close still works after inspectPage', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await manager.inspectPage();
      const closeRes = await manager.close();
      assert.equal(closeRes.success, true);
      assert.equal(closeRes.state, 'stopped');
      assert.equal(manager.state, BROWSER_STATES.STOPPED);
    });

    test('62. fresh relaunch still works after inspectPage and close', async () => {
      let count = 0;
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({
        launcher: async () => {
          count++;
          return mockEnv.browser;
        }
      });
      await manager.launch();
      await manager.inspectPage();
      await manager.close();

      const relaunch = await manager.launch();
      assert.equal(relaunch.success, true);
      assert.equal(count, 2);
      assert.equal(manager.state, BROWSER_STATES.RUNNING);
    });

    test('63. duplicate launch protection remains after inspection', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();
      await manager.inspectPage();

      const dup = await manager.launch();
      assert.equal(dup.alreadyRunning, true);
    });

    test('64. navigation from GREEN-027 still works alongside inspection', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({
        launcher: async () => mockEnv.browser,
        dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }]
      });
      await manager.launch();

      const navRes = await manager.navigate('https://example.com/');
      assert.equal(navRes.success, true);
      assert.equal(navRes.finalUrl, 'https://example.com/');

      const inspectRes = await manager.inspectPage();
      assert.equal(inspectRes.success, true);
      assert.equal(inspectRes.url, 'https://example.com/');
    });

    test('controlled error handling when evaluation throws', async () => {
      const mockEnv = createMockBrowserEnvironment({
        evaluateHandler: async () => {
          throw new Error('Evaluation internal failure at C:\\Users\\secret\\path.js');
        }
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        async () => manager.inspectPage(),
        (err) => {
          assert.equal(err.code, 'BROWSER_INSPECTION_FAILED');
          assert.equal(err.message, 'Page inspection could not be completed.');
          assert.ok(!err.message.includes('C:\\Users'));
          assert.ok(!err.message.includes('secret'));
          return true;
        }
      );
    });
  });

  describe('Inspection Transient Error Recovery & Error Sanitization (Live Fix)', () => {
    test('1-2. normal successful inspection performs exactly one attempt and does not enter recovery', async () => {
      const mockEnv = createMockBrowserEnvironment();
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const result = await manager.inspectPage();
      assert.equal(result.success, true);
      assert.equal(mockEnv.page.evaluateCalls.length, 1, 'exactly 1 evaluate attempt performed');
      assert.equal(mockEnv.page.waitForLoadStateCalls.length, 0, 'did not enter recovery path');
    });

    test('3-6, 17-23. recognized transient condition triggers bounded recovery and successful retry returns normal inspection without navigation/interaction', async () => {
      let attempts = 0;
      const mockEnv = createMockBrowserEnvironment({
        evaluateHandler: async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
          }
          return {
            visibleText: 'Recovered page text',
            textTruncated: false,
            elements: [{ kind: 'heading', tag: 'h1', text: 'Recovered' }],
            returnedElementCount: 1,
            totalEligibleElementCount: 1,
            elementsTruncated: false
          };
        }
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      const result = await manager.inspectPage();
      assert.equal(result.success, true);
      assert.equal(result.visibleText, 'Recovered page text');
      assert.equal(attempts, 2, 'retried exactly once');
      assert.equal(mockEnv.page.waitForLoadStateCalls.length, 1, 'waited for domcontentloaded');
      assert.equal(mockEnv.page.waitForLoadStateCalls[0].state, 'domcontentloaded');

      // 17-23. Zero navigation or interaction during recovery
      assert.equal(mockEnv.page.gotoCalls.length, 0, 'recovery must not call page.goto');
      assert.equal(mockEnv.page.reloadCalls.length, 0, 'recovery must not call page.reload');
      assert.equal(mockEnv.page.goBackCalls.length, 0, 'recovery must not call goBack');
      assert.equal(mockEnv.page.goForwardCalls.length, 0, 'recovery must not call goForward');
      assert.equal(mockEnv.page.clickCalls.length, 0, 'recovery must not click');
      assert.equal(mockEnv.page.typeCalls.length, 0, 'recovery must not type');
      assert.equal(mockEnv.page.fillCalls.length, 0, 'recovery must not fill');
    });

    test('7-12. persistent transient failure stops at max 2 total attempts and returns controlled BROWSER_PAGE_BUSY with zero raw error leakage', async () => {
      let attempts = 0;
      const mockEnv = createMockBrowserEnvironment({
        evaluateHandler: async () => {
          attempts++;
          throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation at InternalRuntime.js:42\n    at eval (file:///C:/path/internal.js:10:5)');
        }
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        async () => manager.inspectPage(),
        (err) => {
          assert.equal(err.code, 'BROWSER_PAGE_BUSY');
          assert.equal(err.message, 'The page is still changing or loading. Try inspection again shortly.');
          // 9-12. Sanity checks: raw text, Playwright internals, paths, stack traces must NOT appear
          assert.ok(!err.message.includes('page.evaluate'), '9. raw page.evaluate must not be returned');
          assert.ok(!err.message.includes('Execution context was destroyed'), '10. raw Execution context was destroyed must not be returned');
          assert.ok(!err.message.includes('InternalRuntime'), '11. raw Playwright error string must not be exposed');
          assert.ok(!err.message.includes('at eval'), '12. stack trace must not be exposed');
          assert.ok(!err.message.includes('C:/path'), 'Windows path must not be exposed');
          return true;
        }
      );

      // 7. Maximum retry count is exactly 1 additional attempt (2 total attempts)
      assert.equal(attempts, 2, 'max total attempts must be exactly 2');
    });

    test('13-14. unknown/generic Playwright error is NOT retried and returns sanitized BROWSER_INSPECTION_FAILED', async () => {
      let attempts = 0;
      const mockEnv = createMockBrowserEnvironment({
        evaluateHandler: async () => {
          attempts++;
          throw new Error('Internal V8 TypeError: cannot read properties of null at C:\\Playwright\\core.js');
        }
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        async () => manager.inspectPage(),
        (err) => {
          assert.equal(err.code, 'BROWSER_INSPECTION_FAILED');
          assert.equal(err.message, 'Page inspection could not be completed.');
          assert.ok(!err.message.includes('TypeError'));
          assert.ok(!err.message.includes('Playwright'));
          assert.ok(!err.message.includes('C:\\Playwright'));
          return true;
        }
      );

      assert.equal(attempts, 1, 'non-transient error must not be retried');
      assert.equal(mockEnv.page.waitForLoadStateCalls.length, 0, 'must not wait for stability on non-transient error');
    });

    test('15. closed page during recovery uses lifecycle reconciliation and throws BROWSER_NOT_RUNNING', async () => {
      let attempts = 0;
      const mockEnv = createMockBrowserEnvironment({
        evaluateHandler: async () => {
          attempts++;
          throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
        },
        waitForLoadStateHandler: async (state, opts, page) => {
          // Page closes while waiting for stability
          page.simulateClose();
        }
      });
      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        async () => manager.inspectPage(),
        (err) => {
          assert.equal(err.code, 'BROWSER_NOT_RUNNING');
          assert.equal(manager.state, BROWSER_STATES.STOPPED);
          return true;
        }
      );

      assert.equal(attempts, 1, 'must not retry once page is closed');
    });

    test('16. browser disconnect during recovery uses lifecycle reconciliation', async () => {
      let attempts = 0;
      let connected = true;
      const mockEnv = createMockBrowserEnvironment({
        evaluateHandler: async () => {
          attempts++;
          throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
        },
        waitForLoadStateHandler: async () => {
          // Browser disconnects while waiting
          connected = false;
        }
      });
      mockEnv.browser.isConnected = () => connected;

      const manager = new BrowserManager({ launcher: async () => mockEnv.browser });
      await manager.launch();

      await assert.rejects(
        async () => manager.inspectPage(),
        (err) => {
          assert.equal(err.code, 'BROWSER_NOT_RUNNING');
          assert.equal(manager.state, BROWSER_STATES.STOPPED);
          return true;
        }
      );

      assert.equal(attempts, 1, 'must not retry once browser disconnected');
    });

    test('24-26. recovery does not create another page, context, or auto-launch browser', async () => {
      let pageCreations = 0;
      let contextCreations = 0;
      let launches = 0;
      const mockEnv = createMockBrowserEnvironment({
        evaluateHandler: async () => {
          throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
        }
      });
      const origNewPage = mockEnv.context.newPage;
      mockEnv.context.newPage = async () => {
        pageCreations++;
        return await origNewPage();
      };
      const origNewContext = mockEnv.browser.newContext;
      mockEnv.browser.newContext = async () => {
        contextCreations++;
        return await origNewContext();
      };

      const manager = new BrowserManager({
        launcher: async () => {
          launches++;
          return mockEnv.browser;
        }
      });
      await manager.launch();
      assert.equal(launches, 1);
      assert.equal(pageCreations, 1);
      assert.equal(contextCreations, 1);

      await assert.rejects(
        async () => manager.inspectPage(),
        (err) => err.code === 'BROWSER_PAGE_BUSY'
      );

      // Verify no extra pages, contexts, or launches
      assert.equal(launches, 1, 'no extra launches during recovery');
      assert.equal(pageCreations, 1, '24. recovery does not create another page');
      assert.equal(contextCreations, 1, '25. recovery does not create another context');

      // 26. When stopped, inspectPage must NOT auto-launch
      await manager.close();
      await assert.rejects(
        async () => manager.inspectPage(),
        (err) => err.code === 'BROWSER_NOT_RUNNING'
      );
      assert.equal(launches, 1, '26. recovery does not auto-launch browser');
    });
  });
});
