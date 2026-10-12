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
import { validateUrlSafety, PageReaderError } from '../webpage/urlSafety.js';
import { extractDomSnapshot } from './pageInspection.js';
import { generateSnapshotToken, resolveTargetFromElements, TargetResolutionError } from './targetResolver.js';

export class BrowserManagerError extends Error {
  /**
   * @param {string} message
   * @param {string} [code='BROWSER_ERROR']
   * @param {Object} [details={}]
   */
  constructor(message, code = 'BROWSER_ERROR', details = {}) {
    super(message);
    this.name = 'BrowserManagerError';
    this.code = code;
    this.details = details;
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
   * @param {number} [options.navigationTimeoutMs]
   * @param {Function} [options.launcher]
   * @param {Function} [options.dnsLookup]
   */
  constructor(options = {}) {
    this._channel = (options.channel ?? config.browser?.channel ?? 'msedge').trim();
    this._headless = typeof options.headless === 'boolean'
      ? options.headless
      : (config.browser?.headless ?? false);
    this._timeoutMs = Math.max(1, Number(options.timeoutMs ?? config.browser?.launchTimeoutMs ?? 15000)) || 15000;
    this._navTimeoutMs = Math.max(1, Number(options.navTimeoutMs ?? options.navigationTimeoutMs ?? config.browser?.navigationTimeoutMs ?? 15000)) || 15000;
    this._dnsLookup = options.dnsLookup;
    this._launcher = options.launcher || defaultPlaywrightLauncher;

    this._state = BROWSER_STATES.STOPPED;
    this._browser = null;
    this._context = null;
    this._page = null;
    this._lastError = null;

    this._snapshotVersion = 0;
    this._snapshotToken = null;

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

  get snapshotToken() {
    return this._snapshotToken;
  }

  get snapshotVersion() {
    return this._snapshotVersion;
  }

  getSnapshotToken() {
    return this._snapshotToken;
  }

  isSnapshotTokenValid(token) {
    return Boolean(this._snapshotToken && token === this._snapshotToken);
  }

  _invalidateSnapshot() {
    this._snapshotVersion++;
    this._snapshotToken = generateSnapshotToken(this._snapshotVersion);
    return this._snapshotToken;
  }

  _resetSnapshot() {
    this._snapshotVersion = 0;
    this._snapshotToken = null;
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

    let currentUrl = null;
    if (isRunning && this._page) {
      currentUrl = typeof this._page.url === 'function' ? this._page.url() : 'about:blank';
    }

    return {
      success: true,
      state: this._state,
      browserConnected: connected,
      contextOpen: isRunning && Boolean(this._context),
      pageOpen: isRunning && Boolean(this._page && (!this._page.isClosed || !this._page.isClosed())),
      channel: this._channel,
      headless: this._headless,
      currentUrl
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
        this._snapshotVersion = 1;
        this._snapshotToken = generateSnapshotToken(1);

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
   * Returns current managed page status without navigating.
   * Reconciles lifecycle state if the page or browser was manually closed.
   *
   * @returns {Promise<{
   *   success: boolean,
   *   state: string,
   *   pageOpen: boolean,
   *   url: string|null,
   *   title: string|null
   * }>}
   */
  async getPageStatus() {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      return {
        success: true,
        state: BROWSER_STATES.STOPPED,
        pageOpen: false,
        url: null,
        title: null
      };
    }

    let currentUrl = null;
    let currentTitle = '';

    try {
      if (this._page) {
        if (typeof this._page.url === 'function') {
          currentUrl = this._page.url();
        }
        if (typeof this._page.title === 'function') {
          currentTitle = (await this._page.title()) || '';
        }
      }
    } catch {
      this._reconcileLifecycle();
      return {
        success: true,
        state: this._state,
        pageOpen: this.isSessionActive(),
        url: null,
        title: null
      };
    }

    return {
      success: true,
      state: this._state,
      pageOpen: true,
      url: currentUrl,
      title: currentTitle
    };
  }

  /**
   * Explicitly navigates the managed page to the specified URL.
   * Requires the browser to be already running (no auto-launch).
   * Strictly validates URL format and prevents SSRF and redirect downgrades.
   *
   * @param {string} urlStr
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   * @param {Function} [options.dnsLookup]
   * @returns {Promise<{
   *   success: boolean,
   *   requestedUrl: string,
   *   finalUrl: string,
   *   title: string,
   *   httpStatus: number,
   *   navigationDurationMs: number,
   *   state: string
   * }>}
   */
  async navigate(urlStr, options = {}) {
    // 1. Reconcile lifecycle and verify browser is running
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    // 2. Strict URL validation
    if (typeof urlStr !== 'string' || urlStr.trim().length === 0) {
      throw new BrowserManagerError('URL must be a non-empty string', 'INVALID_URL');
    }

    const requestedUrl = urlStr.trim();
    const dnsLookup = options.dnsLookup || this._dnsLookup;

    try {
      await validateUrlSafety(requestedUrl, { dnsLookup });
    } catch (err) {
      if (err instanceof BrowserManagerError) {
        throw err;
      }
      throw new BrowserManagerError(
        err.message,
        err.code || 'INVALID_URL',
        err.details || {}
      );
    }

    const navTimeout = Math.max(1, Number(options.timeoutMs ?? this._navTimeoutMs)) || 15000;
    const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    // 3. Setup redirect interception on managed page
    let redirectError = null;
    const routeHandler = async (route) => {
      try {
        const req = typeof route.request === 'function' ? route.request() : null;
        if (req) {
          const redirectedFrom = typeof req.redirectedFrom === 'function' ? req.redirectedFrom() : null;
          if (redirectedFrom) {
            const fromUrl = typeof redirectedFrom.url === 'function' ? redirectedFrom.url() : '';
            const toUrl = typeof req.url === 'function' ? req.url() : '';

            // Check HTTPS -> HTTP downgrade
            if (fromUrl.startsWith('https:') && toUrl.startsWith('http:')) {
              redirectError = new BrowserManagerError(
                `Insecure redirect downgrade from HTTPS to HTTP blocked: "${toUrl}"`,
                'INSECURE_REDIRECT_DOWNGRADE',
                { requestedUrl, finalUrl: toUrl }
              );
              if (typeof route.abort === 'function') {
                await route.abort('blockedbyclient').catch(() => {});
              }
              return;
            }

            // Validate redirect destination network safety
            try {
              await validateUrlSafety(toUrl, { dnsLookup });
            } catch (valErr) {
              redirectError = new BrowserManagerError(
                `Redirect destination blocked: ${valErr.message}`,
                valErr.code || 'LOCAL_OR_PRIVATE_HOST_BLOCKED',
                { requestedUrl, redirectUrl: toUrl }
              );
              if (typeof route.abort === 'function') {
                await route.abort('blockedbyclient').catch(() => {});
              }
              return;
            }
          }
        }
        if (typeof route.continue === 'function') {
          await route.continue().catch(() => {});
        }
      } catch (handlerErr) {
        if (!redirectError) {
          redirectError = handlerErr instanceof BrowserManagerError
            ? handlerErr
            : new BrowserManagerError(handlerErr.message || 'Redirect interception failed', 'BROWSER_NAVIGATION_FAILED');
        }
        if (typeof route.abort === 'function') {
          await route.abort('blockedbyclient').catch(() => {});
        }
      }
    };

    let routingRegistered = false;
    if (this._page && typeof this._page.route === 'function') {
      try {
        await this._page.route('**/*', routeHandler);
        routingRegistered = true;
      } catch {
        // Safe fallback for mocks
      }
    }

    let response = null;
    try {
      response = await this._page.goto(requestedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: navTimeout
      });
    } catch (err) {
      if (redirectError) {
        if (this._page && typeof this._page.goto === 'function') {
          await this._page.goto('about:blank').catch(() => {});
        }
        throw redirectError;
      }
      if (err.name === 'TimeoutError' || /timeout/i.test(err.message || '')) {
        throw new BrowserManagerError(
          `Navigation timed out after ${navTimeout} ms`,
          'BROWSER_NAVIGATION_TIMEOUT',
          { requestedUrl, timeoutMs: navTimeout }
        );
      }
      if (err instanceof BrowserManagerError) {
        throw err;
      }
      let safeMsg = 'Navigation failed';
      if (err && typeof err.message === 'string') {
        const firstLine = err.message.split('\n')[0].trim();
        safeMsg = firstLine.replace(/([A-Za-z]:\\[^:\s]+|\/[^\s:]+)/g, '[path]').trim();
      }
      throw new BrowserManagerError(
        safeMsg || 'Navigation failed',
        'BROWSER_NAVIGATION_FAILED',
        { requestedUrl }
      );
    } finally {
      if (routingRegistered && this._page && typeof this._page.unroute === 'function') {
        try {
          await this._page.unroute('**/*', routeHandler).catch(() => {});
        } catch {
          // Safe absorption
        }
      }
    }

    if (redirectError) {
      if (this._page && typeof this._page.goto === 'function') {
        await this._page.goto('about:blank').catch(() => {});
      }
      throw redirectError;
    }

    // 4. Secondary check: response request redirect chain
    if (response && typeof response.request === 'function') {
      let currReq = response.request();
      while (currReq && typeof currReq.redirectedFrom === 'function') {
        const prev = currReq.redirectedFrom();
        if (!prev) break;
        const prevUrl = typeof prev.url === 'function' ? prev.url() : '';
        const currUrl = typeof currReq.url === 'function' ? currReq.url() : '';

        if (prevUrl.startsWith('https:') && currUrl.startsWith('http:')) {
          if (this._page && typeof this._page.goto === 'function') {
            await this._page.goto('about:blank').catch(() => {});
          }
          throw new BrowserManagerError(
            `Insecure redirect downgrade from HTTPS to HTTP blocked: "${currUrl}"`,
            'INSECURE_REDIRECT_DOWNGRADE',
            { requestedUrl, finalUrl: currUrl }
          );
        }

        try {
          await validateUrlSafety(currUrl, { dnsLookup });
        } catch (valErr) {
          if (this._page && typeof this._page.goto === 'function') {
            await this._page.goto('about:blank').catch(() => {});
          }
          throw new BrowserManagerError(
            `Redirect destination blocked: ${valErr.message}`,
            valErr.code || 'LOCAL_OR_PRIVATE_HOST_BLOCKED',
            { requestedUrl, redirectUrl: currUrl }
          );
        }

        currReq = prev;
      }
    }

    // 5. HTTP status check
    let httpStatus = 200;
    if (response) {
      if (typeof response.status === 'function') {
        httpStatus = response.status();
      } else if (typeof response.status === 'number') {
        httpStatus = response.status;
      }
    }

    const finalUrl = (this._page && typeof this._page.url === 'function')
      ? this._page.url()
      : requestedUrl;

    if (httpStatus >= 400) {
      throw new BrowserManagerError(
        `Navigation failed with HTTP error ${httpStatus}`,
        'BROWSER_HTTP_ERROR',
        {
          httpStatus,
          requestedUrl,
          finalUrl,
          state: this._state
        }
      );
    }

    const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const navigationDurationMs = Math.max(0.001, Number((endTime - startTime).toFixed(3)));

    const title = (this._page && typeof this._page.title === 'function')
      ? (await this._page.title()) || ''
      : '';

    this._invalidateSnapshot();

    return {
      success: true,
      requestedUrl,
      finalUrl,
      title,
      httpStatus,
      navigationDurationMs,
      state: this._state
    };
  }

  /**
   * Navigates back in the managed page history.
   *
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{
   *   success: boolean,
   *   navigated: boolean,
   *   url: string|null,
   *   title: string,
   *   state: string
   * }>}
   */
  async back(options = {}) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    const navTimeout = Math.max(1, Number(options.timeoutMs ?? this._navTimeoutMs)) || 15000;
    let response = null;

    try {
      response = await this._page.goBack({
        waitUntil: 'domcontentloaded',
        timeout: navTimeout
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || /timeout/i.test(err.message || '')) {
        throw new BrowserManagerError(
          `Back navigation timed out after ${navTimeout} ms`,
          'BROWSER_NAVIGATION_TIMEOUT',
          { timeoutMs: navTimeout }
        );
      }
      throw new BrowserManagerError(
        `Back navigation failed: ${err.message || 'Unknown error'}`,
        'BROWSER_NAVIGATION_FAILED'
      );
    }

    const currentUrl = (this._page && typeof this._page.url === 'function')
      ? this._page.url()
      : null;
    const title = (this._page && typeof this._page.title === 'function')
      ? (await this._page.title()) || ''
      : '';

    this._invalidateSnapshot();

    return {
      success: true,
      navigated: Boolean(response),
      url: currentUrl,
      title,
      state: this._state
    };
  }

  /**
   * Navigates forward in the managed page history.
   *
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{
   *   success: boolean,
   *   navigated: boolean,
   *   url: string|null,
   *   title: string,
   *   state: string
   * }>}
   */
  async forward(options = {}) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    const navTimeout = Math.max(1, Number(options.timeoutMs ?? this._navTimeoutMs)) || 15000;
    let response = null;

    try {
      response = await this._page.goForward({
        waitUntil: 'domcontentloaded',
        timeout: navTimeout
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || /timeout/i.test(err.message || '')) {
        throw new BrowserManagerError(
          `Forward navigation timed out after ${navTimeout} ms`,
          'BROWSER_NAVIGATION_TIMEOUT',
          { timeoutMs: navTimeout }
        );
      }
      throw new BrowserManagerError(
        `Forward navigation failed: ${err.message || 'Unknown error'}`,
        'BROWSER_NAVIGATION_FAILED'
      );
    }

    const currentUrl = (this._page && typeof this._page.url === 'function')
      ? this._page.url()
      : null;
    const title = (this._page && typeof this._page.title === 'function')
      ? (await this._page.title()) || ''
      : '';

    this._invalidateSnapshot();

    return {
      success: true,
      navigated: Boolean(response),
      url: currentUrl,
      title,
      state: this._state
    };
  }

  /**
   * Reloads the current managed page.
   *
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{
   *   success: boolean,
   *   url: string|null,
   *   title: string,
   *   state: string
   * }>}
   */
  async refresh(options = {}) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    const navTimeout = Math.max(1, Number(options.timeoutMs ?? this._navTimeoutMs)) || 15000;

    try {
      await this._page.reload({
        waitUntil: 'domcontentloaded',
        timeout: navTimeout
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || /timeout/i.test(err.message || '')) {
        throw new BrowserManagerError(
          `Refresh timed out after ${navTimeout} ms`,
          'BROWSER_NAVIGATION_TIMEOUT',
          { timeoutMs: navTimeout }
        );
      }
      throw new BrowserManagerError(
        `Refresh failed: ${err.message || 'Unknown error'}`,
        'BROWSER_NAVIGATION_FAILED'
      );
    }

    const currentUrl = (this._page && typeof this._page.url === 'function')
      ? this._page.url()
      : null;
    const title = (this._page && typeof this._page.title === 'function')
      ? (await this._page.title()) || ''
      : '';

    this._invalidateSnapshot();

    return {
      success: true,
      url: currentUrl,
      title,
      state: this._state
    };
  }

  /**
   * Observes and inspects the currently loaded managed page (Brick 28).
   * Extracts visible text and a bounded inventory of visible elements without interaction.
   *
   * Strict invariants:
   * - Requires browser to be already running (no auto-launch).
   * - Reconciles lifecycle state if the page or browser was manually closed.
   * - Read-only: zero clicking, typing, scrolling, form submitting, reloading, or navigating.
   * - Input privacy: zero field values returned (passwords, text, email, tokens omitted).
   * - Untrusted data: extracted content treated strictly as passive text, zero AI calls.
   *
   * @param {Object} [options={}]
   * @param {number} [options.maxTextChars]
   * @param {number} [options.maxElements]
   * @param {number} [options.maxElementTextChars]
   * @param {Function} [options.evaluator]
   * @returns {Promise<{
   *   success: boolean,
   *   state: string,
   *   url: string,
   *   title: string,
   *   visibleText: string,
   *   textTruncated: boolean,
   *   elements: Array<Object>,
   *   returnedElementCount: number,
   *   totalEligibleElementCount: number,
   *   elementsTruncated: boolean,
   *   inspectionDurationMs: number
   * }>}
   */
  /**
   * Determines whether an inspection failure is a recognized transient error
   * caused by document navigation, frame detachment, or execution context replacement.
   *
   * @param {Error|unknown} err
   * @returns {boolean}
   * @private
   */
  _isTransientInspectionError(err) {
    if (!err) return false;
    const msg = typeof err.message === 'string' ? err.message : '';
    const transientPatterns = [
      /execution context was destroyed/i,
      /cannot find context with specified id/i,
      /frame was detached/i,
      /execution context is not available in detached frame/i,
      /document replaced/i,
      /navigation occurred/i
    ];
    return transientPatterns.some((pattern) => pattern.test(msg));
  }

  /**
   * Observes and inspects the currently loaded managed page (Brick 28).
   * Extracts visible text and a bounded inventory of visible elements without interaction.
   *
   * Strict invariants:
   * - Requires browser to be already running (no auto-launch).
   * - Reconciles lifecycle state if the page or browser was manually closed.
   * - Read-only: zero clicking, typing, scrolling, form submitting, reloading, or navigating.
   * - Input privacy: zero field values returned (passwords, text, email, tokens omitted).
   * - Untrusted data: extracted content treated strictly as passive text, zero AI calls.
   * - Bounded transient recovery: retries at most once if execution context was replaced during navigation.
   * - Sanitized error messages: raw Playwright internals are never exposed to API or UI.
   *
   * @param {Object} [options={}]
   * @param {number} [options.maxTextChars]
   * @param {number} [options.maxElements]
   * @param {number} [options.maxElementTextChars]
   * @param {Function} [options.evaluator]
   * @param {Function} [options.waitForStability]
   * @param {number} [options.stabilityTimeoutMs]
   * @returns {Promise<{
   *   success: boolean,
   *   state: string,
   *   url: string,
   *   title: string,
   *   visibleText: string,
   *   textTruncated: boolean,
   *   elements: Array<Object>,
   *   returnedElementCount: number,
   *   totalEligibleElementCount: number,
   *   elementsTruncated: boolean,
   *   inspectionDurationMs: number
   * }>}
   */
  async inspectPage(options = {}) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    const maxTextChars = Math.max(1, Number(options.maxTextChars ?? config.browser?.inspectionMaxTextChars ?? 12000)) || 12000;
    const maxElements = Math.max(1, Number(options.maxElements ?? config.browser?.inspectionMaxElements ?? 100)) || 100;
    const maxElementTextChars = Math.max(1, Number(options.maxElementTextChars ?? config.browser?.inspectionMaxElementTextChars ?? 300)) || 300;

    const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    let snapshot;
    let lastError = null;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (typeof options.evaluator === 'function') {
          snapshot = await options.evaluator(this._page, {
            maxTextChars,
            maxElements,
            maxElementTextChars,
            attempt
          });
        } else if (this._page && typeof this._page.evaluate === 'function') {
          snapshot = await this._page.evaluate(extractDomSnapshot, {
            maxTextChars,
            maxElements,
            maxElementTextChars
          });
        } else {
          throw new Error('Page evaluate method not available');
        }

        // Inspection succeeded on this attempt!
        lastError = null;
        break;
      } catch (err) {
        lastError = err;

        // Reconcile lifecycle immediately in case page/browser was closed
        this._reconcileLifecycle();
        if (!this.isSessionActive()) {
          throw new BrowserManagerError(
            'Browser is not running. Please launch the browser first.',
            'BROWSER_NOT_RUNNING'
          );
        }

        if (err instanceof BrowserManagerError) {
          throw err;
        }

        const isTransient = this._isTransientInspectionError(err);
        if (!isTransient || attempt >= maxAttempts) {
          break;
        }

        // Bounded wait for page lifecycle/stability before exactly one retry
        if (typeof options.waitForStability === 'function') {
          await options.waitForStability(this._page).catch(() => {});
        } else if (this._page && typeof this._page.waitForLoadState === 'function') {
          const waitTimeout = Math.min(5000, Math.max(100, Number(options.stabilityTimeoutMs ?? 2000) || 2000));
          await this._page.waitForLoadState('domcontentloaded', { timeout: waitTimeout }).catch(() => {});
        }

        // Reconcile lifecycle after wait in case page was closed during the wait
        this._reconcileLifecycle();
        if (!this.isSessionActive()) {
          throw new BrowserManagerError(
            'Browser is not running. Please launch the browser first.',
            'BROWSER_NOT_RUNNING'
          );
        }
      }
    }

    if (lastError) {
      this._reconcileLifecycle();
      if (!this.isSessionActive()) {
        throw new BrowserManagerError(
          'Browser is not running. Please launch the browser first.',
          'BROWSER_NOT_RUNNING'
        );
      }
      if (lastError instanceof BrowserManagerError) {
        throw lastError;
      }
      if (this._isTransientInspectionError(lastError)) {
        throw new BrowserManagerError(
          'The page is still changing or loading. Try inspection again shortly.',
          'BROWSER_PAGE_BUSY'
        );
      }
      throw new BrowserManagerError(
        'Page inspection could not be completed.',
        'BROWSER_INSPECTION_FAILED'
      );
    }

    const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const inspectionDurationMs = Math.max(0.001, Number((endTime - startTime).toFixed(3)));

    let currentUrl = 'about:blank';
    let currentTitle = '';

    try {
      if (this._page) {
        if (typeof this._page.url === 'function') {
          currentUrl = this._page.url();
        }
        if (typeof this._page.title === 'function') {
          currentTitle = (await this._page.title()) || '';
        }
      }
    } catch {
      this._reconcileLifecycle();
      if (!this.isSessionActive()) {
        throw new BrowserManagerError(
          'Browser is not running. Please launch the browser first.',
          'BROWSER_NOT_RUNNING'
        );
      }
    }

    if (!this._snapshotToken) {
      this._invalidateSnapshot();
    }

    return {
      success: true,
      state: this._state,
      url: currentUrl,
      title: currentTitle,
      snapshotToken: this._snapshotToken,
      visibleText: snapshot?.visibleText ?? '',
      textTruncated: Boolean(snapshot?.textTruncated),
      elements: Array.isArray(snapshot?.elements) ? snapshot.elements : [],
      returnedElementCount: Number(snapshot?.returnedElementCount ?? snapshot?.elements?.length ?? 0),
      totalEligibleElementCount: Number(snapshot?.totalEligibleElementCount ?? snapshot?.elements?.length ?? 0),
      elementsTruncated: Boolean(snapshot?.elementsTruncated),
      inspectionDurationMs
    };
  }

  /**
   * Resolves a unique visible target element deterministically from the current page (Brick 29).
   * Never clicks, types, focuses, submits, navigates, or interacts.
   *
   * @param {Object|string} targetQuery
   * @param {Object} [options={}]
   * @returns {Promise<Object>}
   */
  async resolveTarget(targetQuery, options = {}) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    if (!this._snapshotToken) {
      this._invalidateSnapshot();
    }

    let elements = options.elements;
    let pageUrl = options.pageUrl;
    let pageTitle = options.pageTitle;

    if (!elements) {
      const inspection = await this.inspectPage(options);
      elements = inspection.elements;
      pageUrl = inspection.url;
      pageTitle = inspection.title;
    }

    try {
      const result = resolveTargetFromElements(elements, targetQuery, {
        snapshotToken: this._snapshotToken,
        pageUrl: pageUrl ?? (typeof this._page?.url === 'function' ? this._page.url() : ''),
        pageTitle: pageTitle ?? '',
        ...options
      });

      const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
      result.resolutionDurationMs = Math.max(0.001, Number((endTime - startTime).toFixed(3)));

      return result;
    } catch (err) {
      if (err instanceof TargetResolutionError) {
        throw err;
      }
      throw new BrowserManagerError(
        'Target resolution failed.',
        'TARGET_RESOLUTION_FAILED'
      );
    }
  }

  /**
   * Clears internal references to managed browser, context, and page objects.
   * @private
   */
  _cleanupReferences() {
    this._browser = null;
    this._context = null;
    this._page = null;
    this._resetSnapshot();
  }
}

export const defaultBrowserManager = new BrowserManager();

export default defaultBrowserManager;
