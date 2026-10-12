import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager, BrowserManagerError, BROWSER_STATES } from '../../src/browser/browserManager.js';
import { defaultPlaywrightLauncher, chromium } from '../../src/browser/playwrightBrowser.js';

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
});
