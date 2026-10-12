/**
 * Browser Manager for JARVIS4 (Brick 26).
 * Manages the single JARVIS-owned Playwright browser lifecycle instance.
 *
 * Strict invariants:
 * - Owns at most ONE browser instance, ONE isolated context, ONE blank page.
 * - No navigation (about:blank only).
 * - No persistent profile, no userDataDir, no cookies/history access.
 * - Deterministic lifecycle: launch, status, close, unexpected disconnect handling.
 * - Concurrent launch/close protection.
 * - Clean reference cleanup on stop or unexpected disconnect.
 * - Never attaches to existing user browsers.
 * - Never kills external browser processes globally.
 */

import { config } from '../config/index.js';
import { defaultPlaywrightLauncher } from './playwrightBrowser.js';

export class BrowserManagerError extends Error {
  /**
   * @param {string} message
   * @param {string} [code='BROWSER_ERROR']
   */
  constructor(message, code = 'BROWSER_ERROR') {
    super(message);
    this.name = 'BrowserManagerError';
    this.code = code;
  }
}

export const BROWSER_STATES = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping'
});

export class BrowserManager {
  /**
   * @param {Object} [options]
   * @param {string} [options.channel]
   * @param {boolean} [options.headless]
   * @param {number} [options.timeoutMs]
   * @param {Function} [options.launcher]
   */
  constructor(options = {}) {
    this._channel = (options.channel ?? config.browser?.channel ?? 'msedge').trim();
    this._headless = typeof options.headless === 'boolean'
      ? options.headless
      : (config.browser?.headless ?? false);
    this._timeoutMs = Math.max(1, Number(options.timeoutMs ?? config.browser?.launchTimeoutMs ?? 15000)) || 15000;
    this._launcher = options.launcher || defaultPlaywrightLauncher;

    this._state = BROWSER_STATES.STOPPED;
    this._browser = null;
    this._context = null;
    this._page = null;
    this._lastError = null;

    this._launchPromise = null;
    this._closePromise = null;
    this._cleanupPromise = null;
  }

  get state() {
    return this._state;
  }

  get channel() {
    return this._channel;
  }

  get headless() {
    return this._headless;
  }

  get browser() {
    return this._browser;
  }

  get context() {
    return this._context;
  }

  get page() {
    return this._page;
  }

  get lastError() {
    return this._lastError;
  }

  /**
   * Returns whether the browser instance is currently connected and active.
   * If the sole managed page is closed, the session is considered dead.
   * @returns {boolean}
   */
  isBrowserConnected() {
    if (!this._browser || this._state !== BROWSER_STATES.RUNNING) {
      return false;
    }
    if (this._page && typeof this._page.isClosed === 'function' && this._page.isClosed()) {
      return false;
    }
    if (typeof this._browser.isConnected === 'function') {
      return this._browser.isConnected();
    }
    return true;
  }

  /**
   * Checks whether the current managed browser session is completely healthy and active.
   * Evaluates browser connection, context existence, and whether the sole managed page is open.
   * @returns {boolean}
   */
  isSessionActive() {
    if (this._state !== BROWSER_STATES.RUNNING) {
      return false;
    }
    if (!this._browser || !this._context || !this._page) {
      return false;
    }
    if (typeof this._browser.isConnected === 'function' && !this._browser.isConnected()) {
      return false;
    }
    if (typeof this._page.isClosed === 'function' && this._page.isClosed()) {
      return false;
    }
    return true;
  }

  /**
   * Actively reconciles current managed objects and transitions to STOPPED
   * if the browser, context, or page is no longer connected or open.
   * @private
   */
  _reconcileLifecycle() {
    if (this._state !== BROWSER_STATES.RUNNING) {
      return;
    }

    if (!this.isSessionActive()) {
      this._handleSessionTerminated('reconciliation');
    }
  }

  /**
   * Returns current lifecycle status. Does NOT launch browser.
   * Actively reconciles stale disconnected references if needed.
   *
   * @returns {{
   *   success: boolean,
   *   state: string,
   *   browserConnected: boolean,
   *   contextOpen: boolean,
   *   pageOpen: boolean,
   *   channel: string,
   *   headless: boolean,
   *   currentUrl: string|null
   * }}
   */
  getStatus() {
    this._reconcileLifecycle();

    const isRunning = this._state === BROWSER_STATES.RUNNING && this.isSessionActive();
    const connected = isRunning && this.isBrowserConnected();

    return {
      success: true,
      state: this._state,
      browserConnected: connected,
      contextOpen: isRunning && Boolean(this._context),
      pageOpen: isRunning && Boolean(this._page && (!this._page.isClosed || !this._page.isClosed())),
      channel: this._channel,
      headless: this._headless,
      currentUrl: isRunning && this._page ? 'about:blank' : null
    };
  }

  /**
   * Launches the managed browser instance.
   * Idempotent: repeated launch while genuinely running returns alreadyRunning: true.
   * Concurrency-guarded: concurrent launches produce exactly one launch.
   *
   * @returns {Promise<{
   *   success: boolean,
   *   state: string,
   *   browserConnected: boolean,
   *   contextOpen: boolean,
   *   pageOpen: boolean,
   *   channel: string,
   *   headless: boolean,
   *   currentUrl: string,
   *   alreadyRunning: boolean
   * }>}
   */
  async launch() {
    // 1. Reconcile stale session state first
    this._reconcileLifecycle();

    // 2. If genuinely running with active page and connected browser, return alreadyRunning
    if (this._state === BROWSER_STATES.RUNNING && this.isSessionActive()) {
      return {
        success: true,
        state: BROWSER_STATES.RUNNING,
        browserConnected: true,
        contextOpen: Boolean(this._context),
        pageOpen: Boolean(this._page && (!this._page.isClosed || !this._page.isClosed())),
        channel: this._channel,
        headless: this._headless,
        currentUrl: 'about:blank',
        alreadyRunning: true
      };
    }

    // 3. If cleanup from previous unexpected termination is in progress, await it before new launch
    if (this._cleanupPromise) {
      await this._cleanupPromise;
    }

    // 4. If currently starting, wait for the in-flight launch to complete
    if (this._state === BROWSER_STATES.STARTING && this._launchPromise) {
      await this._launchPromise;
      return {
        success: true,
        state: BROWSER_STATES.RUNNING,
        browserConnected: true,
        contextOpen: Boolean(this._context),
        pageOpen: Boolean(this._page && (!this._page.isClosed || !this._page.isClosed())),
        channel: this._channel,
        headless: this._headless,
        currentUrl: 'about:blank',
        alreadyRunning: true
      };
    }

    // 5. If currently stopping, wait for close to finish first
    if (this._state === BROWSER_STATES.STOPPING && this._closePromise) {
      await this._closePromise;
    }

    // 6. Begin new launch
    this._state = BROWSER_STATES.STARTING;

    this._launchPromise = (async () => {
      let browserInstance = null;
      let contextInstance = null;
      let pageInstance = null;

      try {
        browserInstance = await this._launcher({
          channel: this._channel,
          headless: this._headless,
          timeout: this._timeoutMs
        });

        if (!browserInstance) {
          throw new Error('Launcher returned empty browser instance');
        }

        // Attach unexpected disconnect listener to browser
        if (typeof browserInstance.on === 'function') {
          browserInstance.on('disconnected', () => {
            this._handleSessionTerminated('browser_disconnected');
          });
        }

        // Create isolated temporary context
        if (typeof browserInstance.newContext !== 'function') {
          throw new Error('Browser instance missing newContext method');
        }
        contextInstance = await browserInstance.newContext();

        // Attach close listener to context
        if (typeof contextInstance.on === 'function') {
          contextInstance.on('close', () => {
            this._handleSessionTerminated('context_closed');
          });
        }

        // Create blank page (about:blank only, no page.goto)
        if (typeof contextInstance.newPage !== 'function') {
          throw new Error('Browser context missing newPage method');
        }
        pageInstance = await contextInstance.newPage();

        // Attach close listener to managed page
        if (typeof pageInstance.on === 'function') {
          pageInstance.on('close', () => {
            this._handleSessionTerminated('page_closed');
          });
        }

        this._browser = browserInstance;
        this._context = contextInstance;
        this._page = pageInstance;
        this._state = BROWSER_STATES.RUNNING;
        this._lastError = null;

        return {
          success: true,
          state: BROWSER_STATES.RUNNING,
          browserConnected: true,
          contextOpen: true,
          pageOpen: true,
          channel: this._channel,
          headless: this._headless,
          currentUrl: 'about:blank',
          alreadyRunning: false
        };
      } catch (err) {
        // Safe cleanup of any partial handles
        try {
          if (pageInstance && typeof pageInstance.close === 'function') {
            await pageInstance.close().catch(() => {});
          }
          if (contextInstance && typeof contextInstance.close === 'function') {
            await contextInstance.close().catch(() => {});
          }
          if (browserInstance && typeof browserInstance.close === 'function') {
            await browserInstance.close().catch(() => {});
          }
        } catch {
          // ignore cleanup errors during failure unwind
        }

        this._cleanupReferences();
        this._state = BROWSER_STATES.STOPPED;
        this._lastError = err.message || 'Browser launch failed';

        throw new BrowserManagerError(
          `Browser launch failed for channel "${this._channel}": ${err.message}`,
          'BROWSER_LAUNCH_FAILED'
        );
      } finally {
        this._launchPromise = null;
      }
    })();

    return await this._launchPromise;
  }

  /**
   * Closes the managed browser instance.
   * Safe order: page -> context -> browser.
   * Idempotent: closing already stopped browser returns alreadyStopped: true without error.
   *
   * @returns {Promise<{
   *   success: boolean,
   *   state: string,
   *   alreadyStopped: boolean
   * }>}
   */
  async close() {
    // If cleanup from unexpected termination is in progress, await it
    if (this._cleanupPromise) {
      await this._cleanupPromise;
    }

    if (this._state === BROWSER_STATES.STOPPED) {
      return {
        success: true,
        state: BROWSER_STATES.STOPPED,
        alreadyStopped: true
      };
    }

    // Reconcile before attempting close in case page/browser was closed
    this._reconcileLifecycle();

    if (this._state === BROWSER_STATES.STOPPED) {
      return {
        success: true,
        state: BROWSER_STATES.STOPPED,
        alreadyStopped: true
      };
    }

    if (this._state === BROWSER_STATES.STOPPING && this._closePromise) {
      await this._closePromise;
      return {
        success: true,
        state: BROWSER_STATES.STOPPED,
        alreadyStopped: true
      };
    }

    if (this._state === BROWSER_STATES.STARTING && this._launchPromise) {
      try {
        await this._launchPromise;
      } catch {
        // Launch failed, state already reset to STOPPED
        return {
          success: true,
          state: BROWSER_STATES.STOPPED,
          alreadyStopped: true
        };
      }
    }

    this._state = BROWSER_STATES.STOPPING;

    this._closePromise = (async () => {
      try {
        if (this._page && typeof this._page.close === 'function') {
          const isClosed = typeof this._page.isClosed === 'function' ? this._page.isClosed() : false;
          if (!isClosed) {
            await this._page.close().catch(() => {});
          }
        }
        if (this._context && typeof this._context.close === 'function') {
          await this._context.close().catch(() => {});
        }
        if (this._browser && typeof this._browser.close === 'function') {
          const isConnected = typeof this._browser.isConnected === 'function' ? this._browser.isConnected() : false;
          if (isConnected) {
            await this._browser.close().catch(() => {});
          }
        }
      } finally {
        this._cleanupReferences();
        this._state = BROWSER_STATES.STOPPED;
        this._closePromise = null;
      }

      return {
        success: true,
        state: BROWSER_STATES.STOPPED,
        alreadyStopped: false
      };
    })();

    return await this._closePromise;
  }

  /**
   * Handles unexpected closure or termination of the managed browser session
   * (e.g. user closed window, page close event, context close event, or browser disconnect).
   * Safely transitions state to STOPPED, clears references, and cleans up remaining resources.
   *
   * @param {string} [reason='unexpected_close']
   * @private
   */
  _handleSessionTerminated(reason = 'unexpected_close') {
    // If we are already stopping (intentional close) or stopped, do not double-process
    if (this._state === BROWSER_STATES.STOPPING || this._state === BROWSER_STATES.STOPPED) {
      return;
    }

    const browserToClose = this._browser;
    const contextToClose = this._context;
    const pageToClose = this._page;

    // Immediately mark lifecycle as no longer usable and clear references
    this._cleanupReferences();
    this._state = BROWSER_STATES.STOPPED;

    // Asynchronously tear down any remaining live resources for this JARVIS-owned session
    this._cleanupPromise = (async () => {
      try {
        if (pageToClose && typeof pageToClose.close === 'function') {
          const isClosed = typeof pageToClose.isClosed === 'function' ? pageToClose.isClosed() : false;
          if (!isClosed) {
            await pageToClose.close().catch(() => {});
          }
        }
        if (contextToClose && typeof contextToClose.close === 'function') {
          await contextToClose.close().catch(() => {});
        }
        if (browserToClose && typeof browserToClose.close === 'function') {
          const isConnected = typeof browserToClose.isConnected === 'function' ? browserToClose.isConnected() : false;
          if (isConnected) {
            await browserToClose.close().catch(() => {});
          }
        }
      } catch {
        // Safe absorption: background cleanup never throws
      } finally {
        this._cleanupPromise = null;
      }
    })();
  }

  /**
   * Backward-compatible alias for disconnect events.
   * @private
   */
  _handleUnexpectedDisconnect() {
    this._handleSessionTerminated('browser_disconnected');
  }

  /**
   * Clears internal references to managed browser, context, and page objects.
   * @private
   */
  _cleanupReferences() {
    this._browser = null;
    this._context = null;
    this._page = null;
  }
}

export const defaultBrowserManager = new BrowserManager();

export default defaultBrowserManager;
