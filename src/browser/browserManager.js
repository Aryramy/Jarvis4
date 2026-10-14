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
import { generateSnapshotToken, resolveTargetFromElements, createSafeElementSummary, TargetResolutionError } from './targetResolver.js';
import { executeSemanticAction, ActionExecutionError } from './actionExecutor.js';
import { DYNAMIC_TRACKER_SCRIPT } from './dynamicTracker.js';
import { inspectForms, FormInspectionError } from './formInspector.js';
import { populateForm, FormPopulationError } from './formPopulator.js';
import { prepareFormSubmission, executeFormSubmission, getConfirmationToken, clearConfirmationTokens, FormSubmissionError } from './formSubmitter.js';

export { ActionExecutionError, FormInspectionError, FormPopulationError, FormSubmissionError };

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

let pageCounter = 0;

/**
 * Generates an opaque, stable page identifier for a managed Playwright page (Brick 31).
 *
 * @returns {string}
 */
export function generatePageId() {
  pageCounter = (pageCounter + 1) % 1000000;
  const rnd = Math.random().toString(36).slice(2, 8);
  return `pg_${Date.now().toString(36)}_${rnd}_${pageCounter.toString(36)}`;
}

export class BrowserManager {
  /**
   * @param {Object} [options]
   * @param {string} [options.channel]
   * @param {boolean} [options.headless]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.navigationTimeoutMs]
   * @param {number} [options.maxPages]
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
    this._maxPages = Math.max(1, Number(options.maxPages ?? config.browser?.maxPages ?? 8)) || 8;
    this._dnsLookup = options.dnsLookup;
    this._launcher = options.launcher || defaultPlaywrightLauncher;
    const isCustomLauncher = Boolean(options.launcher && options.launcher !== defaultPlaywrightLauncher);
    this._isCustomLauncher = isCustomLauncher;
    if (options.popupSettleMs !== undefined) {
      this._popupSettleMs = Math.max(0, Number(options.popupSettleMs));
    } else if (process.env.BROWSER_POPUP_SETTLE_MS !== undefined) {
      this._popupSettleMs = Math.max(0, Number(process.env.BROWSER_POPUP_SETTLE_MS));
    } else if (isCustomLauncher) {
      this._popupSettleMs = 0;
    } else {
      this._popupSettleMs = config.browser?.popupSettleMs ?? 500;
    }

    this._dynamicTimeoutMs = Math.min(Math.max(Number(options.dynamicTimeoutMs ?? config.browser?.dynamicTimeoutMs ?? 5000) || 5000, 100), 60000);
    this._domQuietMs = Math.min(Math.max(Number(options.domQuietMs ?? config.browser?.domQuietMs ?? 300) || 300, 50), 5000);
    this._dynamicPollMs = Math.min(Math.max(Number(options.dynamicPollMs ?? config.browser?.dynamicPollMs ?? 100) || 100, 20), 1000);
    this._maxDynamicWaits = Math.min(Math.max(Number(options.maxDynamicWaits ?? config.browser?.maxDynamicWaits ?? 4) || 4, 1), 20);
    this._activeDynamicWaits = 0;
    this._dynamicWaiters = new Set();

    this._submitVerifyTimeoutMs = Math.min(Math.max(Number(options.submitVerifyTimeoutMs ?? config.browser?.submitVerifyTimeoutMs ?? 10000) || 10000, 100), 30000);
    this._submitConfirmationTtlMs = Math.min(Math.max(Number(options.submitConfirmationTtlMs ?? config.browser?.submitConfirmationTtlMs ?? 60000) || 60000, 1000), 300000);

    this._state = BROWSER_STATES.STOPPED;
    this._browser = null;
    this._context = null;
    this._page = null;
    this._legacyPage = null;
    this._pages = new Map();
    this._activePageId = null;
    this._pendingAuthorizedCreation = null;
    this._actionPopupWindow = null;
    this._authorizedPages = new WeakSet();
    this._contextPageListener = null;
    this._contextCloseListener = null;
    this._browserDisconnectListener = null;
    this._lastError = null;

    this._allowTestLoopback = Boolean(options.allowTestLoopback || options.allowLoopbackTest);
    this._args = Array.isArray(options.args) ? [...options.args] : (this._allowTestLoopback ? ['--no-proxy-server'] : []);

    this._snapshotVersion = 0;
    this._snapshotToken = null;

    this._launchPromise = null;
    this._closePromise = null;
    this._cleanupPromise = null;
  }

  get dynamicTimeoutMs() {
    return this._dynamicTimeoutMs;
  }

  get domQuietMs() {
    return this._domQuietMs;
  }

  get dynamicPollMs() {
    return this._dynamicPollMs;
  }

  get maxDynamicWaits() {
    return this._maxDynamicWaits;
  }

  get activeDynamicWaits() {
    return this._activeDynamicWaits;
  }

  get popupSettleMs() {
    return this._popupSettleMs;
  }

  get submitVerifyTimeoutMs() {
    return this._submitVerifyTimeoutMs;
  }

  get submitConfirmationTtlMs() {
    return this._submitConfirmationTtlMs;
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

  get maxPages() {
    return this._maxPages;
  }

  get _popupAdoptionWindowActive() {
    return Boolean(this._actionPopupWindow && this._actionPopupWindow.policy === 'allow-single');
  }

  set _popupAdoptionWindowActive(val) {
    if (val) {
      if (!this._actionPopupWindow) {
        this.beginActionPopupWindow({ policy: 'allow-single' });
      } else {
        this._actionPopupWindow.policy = 'allow-single';
      }
    } else {
      this._actionPopupWindow = null;
    }
  }

  /**
   * Begins an action-scoped popup observation window (Brick 31 Live Fix B & C).
   * Ensures popups created during an explicit action click are observed
   * by the action executor before any context cleanup can swallow them.
   *
   * @param {Object} [options]
   * @param {string} [options.policy='block'] - 'block' | 'allow-single'
   * @param {Object} [options.openerPage=null] - Opener page instance
   * @returns {Object} actionPopupWindow state
   */
  beginActionPopupWindow({ policy = 'block', openerPage = null } = {}) {
    const windowState = {
      active: true,
      policy,
      openerPage,
      capturedPopups: [],
      createdAt: Date.now(),
      _popupListeners: new Set(),
      _settleResolvers: new Set(),
      onPopup(cb) {
        if (typeof cb === 'function') {
          this._popupListeners.add(cb);
        }
      },
      offPopup(cb) {
        this._popupListeners.delete(cb);
      },
      notifyPopup(popup) {
        for (const cb of this._popupListeners) {
          try {
            cb(popup);
          } catch {}
        }
      },
      signalSettled() {
        for (const resolve of this._settleResolvers) {
          try {
            resolve();
          } catch {}
        }
        this._settleResolvers.clear();
      }
    };
    this._actionPopupWindow = windowState;
    return windowState;
  }

  /**
   * Ends an active action-scoped popup observation window.
   *
   * @param {Object} [windowState]
   */
  endActionPopupWindow(windowState) {
    if (!windowState || this._actionPopupWindow === windowState) {
      if (this._actionPopupWindow) {
        this._actionPopupWindow.active = false;
        if (typeof this._actionPopupWindow.signalSettled === 'function') {
          this._actionPopupWindow.signalSettled();
        }
      }
      this._actionPopupWindow = null;
    }
  }

  get pageCount() {
    return this._pages.size;
  }

  get activePageId() {
    return this._activePageId;
  }

  get pages() {
    return Array.from(this._pages.values());
  }

  /**
   * Authorizes exactly ONE upcoming internal page creation (initial page or open-page) (Brick 31 Live Fix A).
   *
   * @param {Object} [metadata={}]
   * @returns {Object}
   * @private
   */
  _authorizeNextPageCreation(metadata = {}) {
    const ticket = {
      id: Math.random().toString(36).slice(2),
      createdAt: Date.now(),
      metadata,
      authorizedPage: null
    };
    this._pendingAuthorizedCreation = ticket;
    return ticket;
  }

  /**
   * Clears the pending authorization ticket if it was not consumed (Brick 31 Live Fix A).
   *
   * @param {Object} ticket
   * @private
   */
  _clearAuthorizedPageCreation(ticket) {
    if (this._pendingAuthorizedCreation === ticket) {
      this._pendingAuthorizedCreation = null;
    }
  }

  /**
   * Evaluates whether a managed Playwright page instance is genuinely alive, open, and belongs to context (Brick 31 Live Fix A).
   *
   * @param {Object|null} pageInstance
   * @returns {boolean}
   * @private
   */
  _isPageReallyOpen(pageInstance) {
    if (!pageInstance) {
      return false;
    }
    if (typeof pageInstance.isClosed === 'function' && pageInstance.isClosed()) {
      return false;
    }
    if (this._context) {
      if (typeof pageInstance.context === 'function') {
        const pageCtx = pageInstance.context();
        if (pageCtx && pageCtx !== this._context) {
          return false;
        }
      }
    }
    return true;
  }

  get page() {
    if (this._activePageId && this._pages.has(this._activePageId)) {
      const entry = this._pages.get(this._activePageId);
      if (this._isPageReallyOpen(entry.page)) {
        return entry.page;
      }
    }
    for (const entry of this._pages.values()) {
      if (this._isPageReallyOpen(entry.page)) {
        return entry.page;
      }
    }
    return null;
  }

  set page(val) {
    this._legacyPage = val;
    this._page = val;
  }

  get currentUrl() {
    if (this._activePageId && this._pages.has(this._activePageId)) {
      const entry = this._pages.get(this._activePageId);
      if (entry.page && typeof entry.page.url === 'function') {
        return entry.page.url();
      }
      return entry.currentUrl || 'about:blank';
    }
    return null;
  }

  get lastError() {
    return this._lastError;
  }

  get snapshotToken() {
    if (this._activePageId && this._pages.has(this._activePageId)) {
      return this._pages.get(this._activePageId).snapshotToken;
    }
    return this._snapshotToken;
  }

  get snapshotVersion() {
    if (this._activePageId && this._pages.has(this._activePageId)) {
      return this._pages.get(this._activePageId).snapshotVersion;
    }
    return this._snapshotVersion;
  }

  getSnapshotToken(pageId = this._activePageId) {
    if (pageId && this._pages.has(pageId)) {
      return this._pages.get(pageId).snapshotToken;
    }
    return this._snapshotToken;
  }

  isSnapshotTokenValid(token, pageId = this._activePageId) {
    if (!token || typeof token !== 'string' || token.trim().length === 0) return false;
    const pId = pageId || this._activePageId;
    if (pId) {
      if (!this._pages.has(pId)) return false;
      const entry = this._pages.get(pId);
      if (!entry || !entry.snapshotToken) return false;
      if (entry.snapshotToken !== token) return false;
      if (entry.semanticRevision !== entry.snapshotSemanticRevision) {
        return false;
      }
      if (entry.spaRouteVersion !== entry.snapshotRouteVersion) {
        return false;
      }
      return true;
    }
    return Boolean(this._snapshotToken && token === this._snapshotToken);
  }

  _invalidateSnapshot(pageId = this._activePageId) {
    const pId = pageId || this._activePageId;
    if (pId && this._pages.has(pId)) {
      const entry = this._pages.get(pId);
      entry.snapshotVersion = (entry.snapshotVersion || 0) + 1;
      entry.snapshotSemanticRevision = entry.semanticRevision;
      entry.snapshotRouteVersion = entry.spaRouteVersion;
      entry.snapshotToken = generateSnapshotToken(entry.snapshotVersion, `${entry.pageId}_${entry.semanticRevision}_${Date.now().toString(36)}`);
      if (pId === this._activePageId) {
        this._snapshotVersion = entry.snapshotVersion;
        this._snapshotToken = entry.snapshotToken;
      }
      return entry.snapshotToken;
    }
    this._snapshotVersion++;
    this._snapshotToken = generateSnapshotToken(this._snapshotVersion);
    return this._snapshotToken;
  }

  _resetSnapshot() {
    this._snapshotVersion = 0;
    this._snapshotToken = null;
    for (const entry of this._pages.values()) {
      entry.snapshotVersion = 0;
      entry.snapshotToken = null;
    }
  }

  /**
   * Returns whether the browser instance is currently connected and active.
   * If the active managed page is closed, the session is considered dead.
   * @returns {boolean}
   */
  isBrowserConnected() {
    if (!this._browser || this._state !== BROWSER_STATES.RUNNING) {
      return false;
    }
    const activePage = this.page;
    if (activePage && !this._isPageReallyOpen(activePage)) {
      return false;
    }
    if (typeof this._browser.isConnected === 'function') {
      return this._browser.isConnected();
    }
    return true;
  }

  /**
   * Checks whether the current managed browser session is completely healthy and active.
   * Evaluates browser connection, context existence, and whether the active managed page is open.
   * @returns {boolean}
   */
  isSessionActive() {
    if (this._state !== BROWSER_STATES.RUNNING) {
      return false;
    }
    if (!this._browser || !this._context) {
      return false;
    }
    if (this._pages.size === 0) {
      return false;
    }
    if (typeof this._browser.isConnected === 'function' && !this._browser.isConnected()) {
      return false;
    }
    const activePage = this.page;
    if (!activePage || !this._isPageReallyOpen(activePage)) {
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

    for (const [pId, entry] of Array.from(this._pages.entries())) {
      if (!this._isPageReallyOpen(entry.page)) {
        this._handlePageClosed(pId);
      }
    }

    if (this._activePageId) {
      const activeEntry = this._pages.get(this._activePageId);
      if (!activeEntry || !this._isPageReallyOpen(activeEntry.page)) {
        this._handlePageClosed(this._activePageId);
      }
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
    const activePage = this.page;
    const isPageOpen = Boolean(isRunning && activePage && this._isPageReallyOpen(activePage));

    if (isRunning && activePage && isPageOpen) {
      currentUrl = typeof activePage.url === 'function' ? activePage.url() : 'about:blank';
    }

    return {
      success: true,
      state: this._state,
      browserConnected: connected,
      contextOpen: isRunning && Boolean(this._context),
      pageOpen: isPageOpen,
      channel: this._channel,
      headless: this._headless,
      currentUrl,
      activePageId: this._activePageId,
      pageCount: this._pages.size
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
   *   alreadyRunning: boolean,
   *   activePageId: string,
   *   pageCount: number
   * }>}
   */
  async launch() {
    // 1. Reconcile stale session state first
    this._reconcileLifecycle();

    // 2. If genuinely running with active page and connected browser, return alreadyRunning
    if (this._state === BROWSER_STATES.RUNNING && this.isSessionActive()) {
      const activePage = this.page;
      return {
        success: true,
        state: BROWSER_STATES.RUNNING,
        browserConnected: true,
        contextOpen: Boolean(this._context),
        pageOpen: Boolean(activePage && (!activePage.isClosed || !activePage.isClosed())),
        channel: this._channel,
        headless: this._headless,
        currentUrl: 'about:blank',
        alreadyRunning: true,
        activePageId: this._activePageId,
        pageCount: this._pages.size
      };
    }

    // 3. If cleanup from previous unexpected termination is in progress, await it before new launch
    if (this._cleanupPromise) {
      await this._cleanupPromise;
    }

    // 4. If currently starting, wait for the in-flight launch to complete
    if (this._state === BROWSER_STATES.STARTING && this._launchPromise) {
      await this._launchPromise;
      const activePage = this.page;
      return {
        success: true,
        state: BROWSER_STATES.RUNNING,
        browserConnected: true,
        contextOpen: Boolean(this._context),
        pageOpen: Boolean(activePage && (!activePage.isClosed || !activePage.isClosed())),
        channel: this._channel,
        headless: this._headless,
        currentUrl: 'about:blank',
        alreadyRunning: true,
        activePageId: this._activePageId,
        pageCount: this._pages.size
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
          timeout: this._timeoutMs,
          args: this._args
        });

        if (!browserInstance) {
          throw new Error('Launcher returned empty browser instance');
        }

        // Attach unexpected disconnect listener to browser
        if (typeof browserInstance.on === 'function') {
          this._browserDisconnectListener = () => {
            this._handleSessionTerminated('browser_disconnected');
          };
          browserInstance.on('disconnected', this._browserDisconnectListener);
        }

        // Create isolated temporary context
        if (typeof browserInstance.newContext !== 'function') {
          throw new Error('Browser instance missing newContext method');
        }
        contextInstance = await browserInstance.newContext();

        // Attach close listener to context
        if (typeof contextInstance.on === 'function') {
          this._contextCloseListener = () => {
            this._handleSessionTerminated('context_closed');
          };
          contextInstance.on('close', this._contextCloseListener);

          // Context Page lifecycle listener (Brick 31 Live Fix A)
          this._contextPageListener = (newPage) => {
            // Guard: If this context instance is no longer active, ignore
            if (this._context && this._context !== contextInstance && this._state !== BROWSER_STATES.STARTING) {
              return;
            }

            // If already registered or authorized, do not double-register or close
            if (this._authorizedPages.has(newPage)) {
              return;
            }
            for (const entry of this._pages.values()) {
              if (entry.page === newPage) {
                return;
              }
            }

            // Case A: JARVIS-internal authorized page creation (initial page or open-page)
            if (this._pendingAuthorizedCreation) {
              const ticket = this._pendingAuthorizedCreation;
              ticket.authorizedPage = newPage;
              this._authorizedPages.add(newPage);
              this._pendingAuthorizedCreation = null;
              return;
            }

            // Case B & C: Action-scoped popup creation window (Brick 31 Live Fix B & C)
            if (this._actionPopupWindow && this._actionPopupWindow.active) {
              const actionWindow = this._actionPopupWindow;
              if (!actionWindow.capturedPopups.includes(newPage)) {
                actionWindow.capturedPopups.push(newPage);
              }
              if (typeof actionWindow.notifyPopup === 'function') {
                actionWindow.notifyPopup(newPage);
              }
              return;
            }

            // Case D: Truly unsolicited / spontaneous page creation -> safely close immediately
            if (newPage && typeof newPage.close === 'function') {
              newPage.close().catch(() => {});
            }
          };
          contextInstance.on('page', this._contextPageListener);
        }

        // Create blank page (about:blank only, no page.goto)
        if (typeof contextInstance.newPage !== 'function') {
          throw new Error('Browser context missing newPage method');
        }
        const authTicket = this._authorizeNextPageCreation({ creationType: 'initial' });
        try {
          pageInstance = await contextInstance.newPage();
          if (pageInstance) {
            this._authorizedPages.add(pageInstance);
          }
        } finally {
          this._clearAuthorizedPageCreation(authTicket);
        }

        this._browser = browserInstance;
        this._context = contextInstance;
        this._pages.clear();
        const initialEntry = this._registerPage(pageInstance, { creationType: 'initial', activate: true });
        this._page = pageInstance;
        this._legacyPage = pageInstance;
        this._state = BROWSER_STATES.RUNNING;
        this._lastError = null;

        return {
          success: true,
          state: BROWSER_STATES.RUNNING,
          browserConnected: true,
          contextOpen: true,
          pageOpen: this._isPageReallyOpen(pageInstance),
          channel: this._channel,
          headless: this._headless,
          currentUrl: 'about:blank',
          alreadyRunning: false,
          activePageId: initialEntry.pageId,
          pageCount: 1
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
   * Safe order: pages -> context -> browser.
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
        for (const entry of Array.from(this._pages.values())) {
          if (entry.page && typeof entry.page.close === 'function') {
            const isClosed = typeof entry.page.isClosed === 'function' ? entry.page.isClosed() : false;
            if (!isClosed) {
              await entry.page.close().catch(() => {});
            }
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
    const pagesToClose = Array.from(this._pages.values()).map(e => e.page);

    // Immediately mark lifecycle as no longer usable and clear references
    this._cleanupReferences();
    this._state = BROWSER_STATES.STOPPED;

    // Asynchronously tear down any remaining live resources for this JARVIS-owned session
    this._cleanupPromise = (async () => {
      try {
        for (const p of pagesToClose) {
          if (p && typeof p.close === 'function') {
            const isClosed = typeof p.isClosed === 'function' ? p.isClosed() : false;
            if (!isClosed) {
              await p.close().catch(() => {});
            }
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
        title: null,
        pageId: null,
        semanticRevision: 0,
        spaRouteVersion: 0,
        lastRelevantMutationAgeMs: null
      };
    }

    let currentUrl = null;
    let currentTitle = '';
    const activeEntry = this._activePageId ? this._pages.get(this._activePageId) : null;

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
        title: null,
        pageId: this._activePageId,
        semanticRevision: activeEntry?.semanticRevision ?? 0,
        spaRouteVersion: activeEntry?.spaRouteVersion ?? 0,
        lastRelevantMutationAgeMs: null
      };
    }

    if (this._activePageId) {
      await this.syncDynamicState(this._activePageId).catch(() => {});
    }

    const now = Date.now();
    const lastMutationTimestamp = activeEntry?.lastRelevantMutationTimestamp ?? now;
    const lastRelevantMutationAgeMs = Math.max(0, now - lastMutationTimestamp);
    const effectiveUrl = (activeEntry?.currentUrl && activeEntry.currentUrl !== 'about:blank')
      ? activeEntry.currentUrl
      : (currentUrl || activeEntry?.currentUrl || 'about:blank');

    return {
      success: true,
      state: this._state,
      pageOpen: true,
      url: effectiveUrl,
      title: currentTitle,
      pageId: this._activePageId,
      semanticRevision: activeEntry?.semanticRevision ?? 1,
      spaRouteVersion: activeEntry?.spaRouteVersion ?? 1,
      lastRelevantMutationAgeMs,
      dynamicObserverInstalled: Boolean(activeEntry?.dynamicObserverInstalled ?? true),
      observerDocumentVersion: activeEntry?.documentVersion ?? 1
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
    const allowTestLoopback = Boolean(options.allowTestLoopback || options.allowLoopbackTest || this._allowTestLoopback);

    try {
      await validateUrlSafety(requestedUrl, { dnsLookup, allowTestLoopback });
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
              await validateUrlSafety(toUrl, { dnsLookup, allowTestLoopback });
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
          await validateUrlSafety(currUrl, { dnsLookup, allowTestLoopback });
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

    if (this._activePageId && this._pages.has(this._activePageId)) {
      const activeEntry = this._pages.get(this._activePageId);
      activeEntry.documentVersion = (activeEntry.documentVersion || 1) + 1;
      activeEntry.semanticRevision = 1;
      activeEntry.snapshotSemanticRevision = 1;
      activeEntry.spaRouteVersion = 1;
      activeEntry.snapshotRouteVersion = 1;
      activeEntry.currentUrl = finalUrl;
      activeEntry.spaRouteChanged = false;
      activeEntry.lastRelevantMutationTimestamp = Date.now();
      this._initDynamicTracker(activeEntry.page, activeEntry.pageId);
      await this.syncDynamicState(activeEntry.pageId).catch(() => {});
    }

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

    if (response && this._activePageId && this._pages.has(this._activePageId)) {
      const activeEntry = this._pages.get(this._activePageId);
      activeEntry.documentVersion = (activeEntry.documentVersion || 1) + 1;
      activeEntry.semanticRevision = 1;
      activeEntry.snapshotSemanticRevision = 1;
      activeEntry.spaRouteVersion = 1;
      activeEntry.snapshotRouteVersion = 1;
      activeEntry.currentUrl = currentUrl;
      activeEntry.spaRouteChanged = false;
      activeEntry.lastRelevantMutationTimestamp = Date.now();
      this._initDynamicTracker(activeEntry.page, activeEntry.pageId);
      await this.syncDynamicState(activeEntry.pageId).catch(() => {});
    }

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

    if (response && this._activePageId && this._pages.has(this._activePageId)) {
      const activeEntry = this._pages.get(this._activePageId);
      activeEntry.documentVersion = (activeEntry.documentVersion || 1) + 1;
      activeEntry.semanticRevision = 1;
      activeEntry.snapshotSemanticRevision = 1;
      activeEntry.spaRouteVersion = 1;
      activeEntry.snapshotRouteVersion = 1;
      activeEntry.currentUrl = currentUrl;
      activeEntry.spaRouteChanged = false;
      activeEntry.lastRelevantMutationTimestamp = Date.now();
      this._initDynamicTracker(activeEntry.page, activeEntry.pageId);
      await this.syncDynamicState(activeEntry.pageId).catch(() => {});
    }

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

    if (this._activePageId && this._pages.has(this._activePageId)) {
      const activeEntry = this._pages.get(this._activePageId);
      activeEntry.documentVersion = (activeEntry.documentVersion || 1) + 1;
      activeEntry.semanticRevision = 1;
      activeEntry.snapshotSemanticRevision = 1;
      activeEntry.spaRouteVersion = 1;
      activeEntry.snapshotRouteVersion = 1;
      activeEntry.currentUrl = currentUrl;
      activeEntry.spaRouteChanged = false;
      activeEntry.lastRelevantMutationTimestamp = Date.now();
      this._initDynamicTracker(activeEntry.page, activeEntry.pageId);
      await this.syncDynamicState(activeEntry.pageId).catch(() => {});
    }

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

    const targetPageId = options.pageId || this._activePageId;
    const entry = this._pages.get(targetPageId);
    if (!entry || !entry.page || (typeof entry.page.isClosed === 'function' && entry.page.isClosed())) {
      throw new BrowserManagerError(`Page "${targetPageId}" not found or closed.`, 'PAGE_NOT_FOUND');
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
          snapshot = await options.evaluator(entry.page, {
            maxTextChars,
            maxElements,
            maxElementTextChars,
            attempt
          });
        } else if (entry.page && typeof entry.page.evaluate === 'function') {
          snapshot = await entry.page.evaluate(extractDomSnapshot, {
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
          await options.waitForStability(entry.page).catch(() => {});
        } else if (entry.page && typeof entry.page.waitForLoadState === 'function') {
          const waitTimeout = Math.min(5000, Math.max(100, Number(options.stabilityTimeoutMs ?? 2000) || 2000));
          await entry.page.waitForLoadState('domcontentloaded', { timeout: waitTimeout }).catch(() => {});
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
      if (entry.page) {
        if (typeof entry.page.url === 'function') {
          currentUrl = entry.page.url();
        }
        if (typeof entry.page.title === 'function') {
          currentTitle = (await entry.page.title()) || '';
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

    if (!entry.snapshotToken) {
      this._invalidateSnapshot(entry.pageId);
    }

    return {
      success: true,
      state: this._state,
      pageId: entry.pageId,
      documentVersion: entry.documentVersion ?? 1,
      semanticRevision: entry.semanticRevision ?? 0,
      url: currentUrl,
      title: currentTitle,
      snapshotToken: entry.snapshotToken,
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

    const targetPageId = options.pageId || this._activePageId;
    const entry = this._pages.get(targetPageId);
    if (!entry || !entry.page || (typeof entry.page.isClosed === 'function' && entry.page.isClosed())) {
      throw new BrowserManagerError(`Page "${targetPageId}" not found or closed.`, 'PAGE_NOT_FOUND');
    }

    if (!entry.snapshotToken) {
      this._invalidateSnapshot(entry.pageId);
    }

    let elements = options.elements;
    let pageUrl = options.pageUrl;
    let pageTitle = options.pageTitle;

    if (!elements) {
      const inspection = await this.inspectPage({ ...options, pageId: entry.pageId });
      elements = inspection.elements;
      pageUrl = inspection.url;
      pageTitle = inspection.title;
    }

    try {
      const result = resolveTargetFromElements(elements, targetQuery, {
        snapshotToken: entry.snapshotToken,
        pageUrl: pageUrl ?? (typeof entry.page?.url === 'function' ? entry.page.url() : ''),
        pageTitle: pageTitle ?? '',
        ...options
      });

      const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
      result.resolutionDurationMs = Math.max(0.001, Number((endTime - startTime).toFixed(3)));
      result.pageId = entry.pageId;
      result.documentVersion = entry.documentVersion ?? 1;
      result.semanticRevision = entry.semanticRevision ?? 0;
      result.snapshotToken = entry.snapshotToken;

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
   * Safely executes exactly ONE bounded action on ONE semantically resolved target (Brick 30).
   *
   * @param {Object} actionRequest
   * @param {Object} [options={}]
   * @returns {Promise<Object>}
   */
  async executeAction(actionRequest, options = {}) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    const targetPageId = options.pageId || actionRequest?.pageId || this._activePageId;
    const entry = this._pages.get(targetPageId);
    if (!entry || !entry.page || (typeof entry.page.isClosed === 'function' && entry.page.isClosed())) {
      throw new BrowserManagerError(`Page "${targetPageId}" not found or closed.`, 'PAGE_NOT_FOUND');
    }

    try {
      return await executeSemanticAction(entry.page, this, actionRequest, { ...options, pageId: entry.pageId });
    } catch (err) {
      if (err instanceof BrowserManagerError || err instanceof ActionExecutionError) {
        throw err;
      }
      let safeMsg = 'Browser action failed.';
      if (err && typeof err.message === 'string') {
        const firstLine = err.message.split('\n')[0].trim();
        safeMsg = firstLine.replace(/([A-Za-z]:\\[^:\s]+|\/[^\s:]+)/g, '[path]').trim();
      }
      throw new BrowserManagerError(
        safeMsg || 'Browser action failed.',
        'ACTION_EXECUTION_FAILED'
      );
    }
  }

  /**
   * Discovers and inspects HTML forms on the active or specified page (Brick 33).
   *
   * @param {Object} [options={}]
   * @param {string} [options.pageId]
   * @returns {Promise<Object>}
   */
  async inspectForms(options = {}) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    const targetPageId = options.pageId || this._activePageId;
    const entry = this._pages.get(targetPageId);
    if (!entry || !entry.page || (typeof entry.page.isClosed === 'function' && entry.page.isClosed())) {
      throw new BrowserManagerError(`Page "${targetPageId}" not found or closed.`, 'PAGE_NOT_FOUND');
    }

    await this.syncDynamicState(targetPageId).catch(() => {});

    if (!this.isSnapshotTokenValid(entry.snapshotToken, targetPageId)) {
      this._invalidateSnapshot(entry.pageId);
    }

    try {
      const result = await inspectForms(entry.page, { ...options, pageId: entry.pageId });
      result.success = true;
      result.pageId = entry.pageId;
      result.documentVersion = entry.documentVersion ?? 1;
      result.semanticRevision = entry.semanticRevision ?? 0;
      result.snapshotToken = entry.snapshotToken;
      result.url = typeof entry.page.url === 'function' ? entry.page.url() : entry.currentUrl;
      return result;
    } catch (err) {
      if (err instanceof BrowserManagerError || err instanceof FormInspectionError) {
        throw err;
      }
      throw new BrowserManagerError(
        'Form inspection failed.',
        'FORM_INSPECTION_FAILED'
      );
    }
  }

  /**
   * Safely populates explicit form fields with preflight atomicity and verification (Brick 33).
   *
   * @param {Object} populateRequest
   * @param {Object} [options={}]
   * @returns {Promise<Object>}
   */
  async fillForm(populateRequest, options = {}) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    const targetPageId = options.pageId || populateRequest?.pageId || this._activePageId;
    const entry = this._pages.get(targetPageId);
    if (!entry || !entry.page || (typeof entry.page.isClosed === 'function' && entry.page.isClosed())) {
      throw new BrowserManagerError(`Page "${targetPageId}" not found or closed.`, 'PAGE_NOT_FOUND');
    }

    try {
      return await populateForm(entry.page, this, populateRequest, { ...options, pageId: entry.pageId });
    } catch (err) {
      if (err instanceof BrowserManagerError || err instanceof FormPopulationError) {
        throw err;
      }
      let safeMsg = 'Form population failed.';
      if (err && typeof err.message === 'string') {
        const firstLine = err.message.split('\n')[0].trim();
        safeMsg = firstLine.replace(/([A-Za-z]:\\[^:\s]+|\/[^\s:]+)/g, '[path]').trim();
      }
      throw new BrowserManagerError(
        safeMsg || 'Form population failed.',
        err.code || 'FORM_POPULATION_FAILED',
        err.details || {}
      );
    }
  }

  /**
   * Prepares deterministic form submission authorization and verification contract (Brick 34).
   * Generates single-use confirmation token without submitting.
   *
   * @param {Object} prepareRequest
   * @param {Object} [options={}]
   * @returns {Promise<Object>}
   */
  async prepareFormSubmission(prepareRequest, options = {}) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    const targetPageId = options.pageId || prepareRequest?.pageId || this._activePageId;
    const entry = this._pages.get(targetPageId);
    if (!entry || !entry.page || (typeof entry.page.isClosed === 'function' && entry.page.isClosed())) {
      throw new BrowserManagerError(`Page "${targetPageId}" not found or closed.`, 'PAGE_NOT_FOUND');
    }

    try {
      return await prepareFormSubmission(entry.page, this, prepareRequest, {
        ...options,
        pageId: entry.pageId,
        ttlMs: options.ttlMs ?? this._submitConfirmationTtlMs
      });
    } catch (err) {
      if (err instanceof BrowserManagerError || err instanceof FormSubmissionError) {
        throw err;
      }
      let safeMsg = 'Form submission preparation failed.';
      if (err && typeof err.message === 'string') {
        const firstLine = err.message.split('\n')[0].trim();
        safeMsg = firstLine.replace(/([A-Za-z]:\\[^:\s]+|\/[^\s:]+)/g, '[path]').trim();
      }
      throw new BrowserManagerError(
        safeMsg || 'Form submission preparation failed.',
        err.code || 'FORM_SUBMISSION_FAILED',
        err.details || {}
      );
    }
  }

  /**
   * Executes a confirmed form submission once using a valid confirmation token (Brick 34).
   *
   * @param {Object} submitRequest
   * @param {Object} [options={}]
   * @returns {Promise<Object>}
   */
  async submitForm(submitRequest, options = {}) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    // Determine target page from token or request
    const token = typeof submitRequest?.confirmationToken === 'string'
      ? submitRequest.confirmationToken.trim()
      : '';
    const tokenRecord = token ? getConfirmationToken(token) : null;
    const targetPageId = options.pageId || submitRequest?.pageId || tokenRecord?.pageId || this._activePageId;

    const entry = this._pages.get(targetPageId);
    if (!entry || !entry.page || (typeof entry.page.isClosed === 'function' && entry.page.isClosed())) {
      throw new BrowserManagerError(`Page "${targetPageId}" not found or closed.`, 'PAGE_NOT_FOUND');
    }

    try {
      return await executeFormSubmission(entry.page, this, submitRequest, {
        ...options,
        pageId: entry.pageId,
        actionTimeoutMs: options.actionTimeoutMs ?? config.browser?.actionTimeoutMs ?? 10000,
        verifyTimeoutMs: options.verifyTimeoutMs ?? this._submitVerifyTimeoutMs,
        popupSettleMs: options.popupSettleMs ?? this._popupSettleMs
      });
    } catch (err) {
      if (err instanceof BrowserManagerError || err instanceof FormSubmissionError) {
        throw err;
      }
      let safeMsg = 'Form submission execution failed.';
      if (err && typeof err.message === 'string') {
        const firstLine = err.message.split('\n')[0].trim();
        safeMsg = firstLine.replace(/([A-Za-z]:\\[^:\s]+|\/[^\s:]+)/g, '[path]').trim();
      }
      throw new BrowserManagerError(
        safeMsg || 'Form submission execution failed.',
        err.code || 'FORM_SUBMISSION_FAILED',
        err.details || {}
      );
    }
  }

  /**
   * Registers a Playwright page instance in the managed page registry (Brick 31).
   *
   * @param {Object} pageInstance
   * @param {Object} [options]
   * @param {string|null} [options.openerPageId=null]
   * @param {string} [options.creationType='manual']
   * @param {boolean} [options.activate=true]
   * @returns {Object} pageEntry
   * @private
   */
  _registerPage(pageInstance, { openerPageId = null, creationType = 'manual', activate = true } = {}) {
    // Check if this page instance is already registered in registry (Brick 31 Live Fix A)
    for (const existingEntry of this._pages.values()) {
      if (existingEntry.page === pageInstance) {
        if (activate) {
          this._activePageId = existingEntry.pageId;
          existingEntry.lastActivatedAt = Date.now();
          this._page = pageInstance;
          this._legacyPage = pageInstance;
          this._snapshotToken = existingEntry.snapshotToken;
          this._snapshotVersion = existingEntry.snapshotVersion;
        }
        return existingEntry;
      }
    }

    if (this._pages.size >= this._maxPages) {
      throw new BrowserManagerError(
        `Maximum page limit of ${this._maxPages} reached.`,
        'PAGE_LIMIT_REACHED',
        { maxPages: this._maxPages, pageCount: this._pages.size }
      );
    }

    const pageId = generatePageId();
    const now = Date.now();
    const snapshotToken = generateSnapshotToken(1, `${pageId}_1_${now.toString(36)}`);

    const entry = {
      pageId,
      page: pageInstance,
      createdAt: now,
      lastActivatedAt: now,
      openerPageId: openerPageId || null,
      creationType: creationType || 'manual',
      snapshotVersion: 1,
      snapshotToken,
      semanticRevision: 1,
      snapshotSemanticRevision: 1,
      spaRouteVersion: 1,
      snapshotRouteVersion: 1,
      lastRelevantMutationTimestamp: now,
      documentVersion: 1,
      currentUrl: typeof pageInstance.url === 'function' ? pageInstance.url() : 'about:blank',
      spaRouteChanged: false
    };

    this._pages.set(pageId, entry);
    this._initDynamicTracker(pageInstance, pageId);

    if (typeof pageInstance.on === 'function') {
      pageInstance.on('close', () => {
        this._handlePageClosed(pageId);
      });
    }

    if (activate || !this._activePageId) {
      this._activePageId = pageId;
      entry.lastActivatedAt = now;
      this._page = pageInstance;
      this._legacyPage = pageInstance;
      this._snapshotToken = entry.snapshotToken;
      this._snapshotVersion = entry.snapshotVersion;
    }

    return entry;
  }

  /**
   * Reconciles removal of a closed page from the registry and selects survivor if active (Brick 31).
   *
   * @param {string} pageId
   * @private
   */
  _handlePageClosed(pageId) {
    const entry = this._pages.get(pageId);
    if (!entry) return;

    // Cancel dynamic waiters for this closed page (Brick 32)
    this._cancelDynamicWaiters(pageId, new BrowserManagerError('Page closed while waiting.', 'PAGE_CLOSED'));

    // Invalidate snapshots for the closed page (Brick 31 Live Fix A)
    entry.snapshotToken = null;
    entry.snapshotVersion = 0;

    this._pages.delete(pageId);

    if (this._activePageId === pageId) {
      let nextActive = null;
      let highestActivatedAt = -1;
      for (const survivor of this._pages.values()) {
        if (survivor.lastActivatedAt > highestActivatedAt && this._isPageReallyOpen(survivor.page)) {
          highestActivatedAt = survivor.lastActivatedAt;
          nextActive = survivor;
        }
      }

      if (nextActive) {
        this._activePageId = nextActive.pageId;
        this._page = nextActive.page;
        this._legacyPage = nextActive.page;
        if (nextActive.page && typeof nextActive.page.bringToFront === 'function') {
          nextActive.page.bringToFront().catch(() => {});
        }
      } else {
        this._activePageId = null;
        this._page = null;
        this._legacyPage = null;
        this._snapshotToken = null;
        this._snapshotVersion = 0;
        this._handleSessionTerminated('all_pages_closed');
      }
    }
  }

  /**
   * Lists safe bounded metadata for all currently managed JARVIS pages (Brick 31).
   *
   * @returns {Promise<{
   *   success: boolean,
   *   activePageId: string|null,
   *   pages: Array<{
   *     pageId: string,
   *     active: boolean,
   *     url: string,
   *     title: string,
   *     openerPageId: string|null,
   *     creationType: string
   *   }>
   * }>}
   */
  async listPages() {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    const pagesList = [];
    for (const entry of this._pages.values()) {
      let url = 'about:blank';
      let title = '';
      try {
        if (entry.page) {
          if (typeof entry.page.url === 'function') {
            url = entry.page.url();
          }
          if (typeof entry.page.title === 'function') {
            title = (await entry.page.title()) || '';
          }
        }
      } catch {
        // safe fallback
      }

      pagesList.push({
        pageId: entry.pageId,
        active: entry.pageId === this._activePageId,
        url,
        title,
        openerPageId: entry.openerPageId,
        creationType: entry.creationType
      });
    }

    return {
      success: true,
      activePageId: this._activePageId,
      pages: pagesList
    };
  }

  /**
   * Opens a new managed browser page, optionally navigating to a validated URL (Brick 31).
   *
   * @param {string} [urlStr]
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   * @param {Function} [options.dnsLookup]
   * @returns {Promise<{
   *   success: boolean,
   *   pageId: string,
   *   previousActivePageId: string|null,
   *   activePageId: string,
   *   url: string,
   *   title: string,
   *   pageCount: number
   * }>}
   */
  async openPage(urlStr, options = {}) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    if (this._pages.size >= this._maxPages) {
      throw new BrowserManagerError(
        `Maximum page limit of ${this._maxPages} reached.`,
        'PAGE_LIMIT_REACHED',
        { maxPages: this._maxPages, pageCount: this._pages.size }
      );
    }

    let requestedUrl = null;
    const allowTestLoopback = Boolean(options.allowTestLoopback || options.allowLoopbackTest || this._allowTestLoopback);
    if (typeof urlStr === 'string' && urlStr.trim().length > 0) {
      requestedUrl = urlStr.trim();
      if (requestedUrl !== 'about:blank') {
        const dnsLookup = options.dnsLookup || this._dnsLookup;
        try {
          await validateUrlSafety(requestedUrl, { dnsLookup, allowTestLoopback });
        } catch (err) {
          if (err instanceof BrowserManagerError) throw err;
          throw new BrowserManagerError(err.message, err.code || 'INVALID_URL', err.details || {});
        }
      }
    }

    let newPageInstance = null;
    const authTicket = this._authorizeNextPageCreation({
      creationType: options.creationType || 'new-page'
    });
    try {
      newPageInstance = await this._context.newPage();
    } catch (err) {
      throw new BrowserManagerError(
        `Failed to create new browser page: ${err.message}`,
        'BROWSER_PAGE_CREATION_FAILED'
      );
    } finally {
      this._clearAuthorizedPageCreation(authTicket);
    }

    const previousActivePageId = this._activePageId;
    const entry = this._registerPage(newPageInstance, {
      openerPageId: previousActivePageId,
      creationType: options.creationType || 'new-page',
      activate: true
    });

    let currentUrl = 'about:blank';
    let currentTitle = '';

    if (requestedUrl && requestedUrl !== 'about:blank') {
      const navTimeout = Math.max(1, Number(options.timeoutMs ?? this._navTimeoutMs)) || 15000;
      const dnsLookup = options.dnsLookup || this._dnsLookup;

      let redirectError = null;
      const routeHandler = async (route) => {
        try {
          const req = typeof route.request === 'function' ? route.request() : null;
          if (req) {
            const redirectedFrom = typeof req.redirectedFrom === 'function' ? req.redirectedFrom() : null;
            if (redirectedFrom) {
              const fromUrl = typeof redirectedFrom.url === 'function' ? redirectedFrom.url() : '';
              const toUrl = typeof req.url === 'function' ? req.url() : '';

              if (fromUrl.startsWith('https:') && toUrl.startsWith('http:')) {
                redirectError = new BrowserManagerError(
                  `Insecure redirect downgrade from HTTPS to HTTP blocked: "${toUrl}"`,
                  'INSECURE_REDIRECT_DOWNGRADE',
                  { requestedUrl, finalUrl: toUrl }
                );
                if (typeof route.abort === 'function') await route.abort('blockedbyclient').catch(() => {});
                return;
              }

              try {
                await validateUrlSafety(toUrl, { dnsLookup, allowTestLoopback });
              } catch (valErr) {
                redirectError = new BrowserManagerError(
                  `Redirect destination blocked: ${valErr.message}`,
                  valErr.code || 'LOCAL_OR_PRIVATE_HOST_BLOCKED',
                  { requestedUrl, redirectUrl: toUrl }
                );
                if (typeof route.abort === 'function') await route.abort('blockedbyclient').catch(() => {});
                return;
              }
            }
          }
          if (typeof route.continue === 'function') await route.continue().catch(() => {});
        } catch (handlerErr) {
          if (!redirectError) {
            redirectError = handlerErr instanceof BrowserManagerError
              ? handlerErr
              : new BrowserManagerError(handlerErr.message || 'Redirect interception failed', 'BROWSER_NAVIGATION_FAILED');
          }
          if (typeof route.abort === 'function') await route.abort('blockedbyclient').catch(() => {});
        }
      };

      if (typeof newPageInstance.route === 'function') {
        try {
          await newPageInstance.route('**/*', routeHandler);
        } catch {}
      }

      let response = null;
      try {
        response = await newPageInstance.goto(requestedUrl, {
          waitUntil: 'domcontentloaded',
          timeout: navTimeout
        });
      } catch (err) {
        if (redirectError) {
          await newPageInstance.close().catch(() => {});
          this._handlePageClosed(entry.pageId);
          throw redirectError;
        }
        if (err.name === 'TimeoutError' || /timeout/i.test(err.message || '')) {
          await newPageInstance.close().catch(() => {});
          this._handlePageClosed(entry.pageId);
          throw new BrowserManagerError(
            `Navigation timed out after ${navTimeout} ms`,
            'BROWSER_NAVIGATION_TIMEOUT',
            { requestedUrl, timeoutMs: navTimeout }
          );
        }
        await newPageInstance.close().catch(() => {});
        this._handlePageClosed(entry.pageId);
        let safeMsg = 'Navigation failed';
        if (err && typeof err.message === 'string') {
          const firstLine = err.message.split('\n')[0].trim();
          safeMsg = firstLine.replace(/([A-Za-z]:\\[^:\s]+|\/[^\s:]+)/g, '[path]').trim();
        }
        throw new BrowserManagerError(safeMsg || 'Navigation failed', 'BROWSER_NAVIGATION_FAILED', { requestedUrl });
      } finally {
        if (typeof newPageInstance.unroute === 'function') {
          await newPageInstance.unroute('**/*', routeHandler).catch(() => {});
        }
      }

      if (redirectError) {
        await newPageInstance.close().catch(() => {});
        this._handlePageClosed(entry.pageId);
        throw redirectError;
      }

      // Secondary check: response request redirect chain
      if (response && typeof response.request === 'function') {
        let currReq = response.request();
        while (currReq && typeof currReq.redirectedFrom === 'function') {
          const prev = currReq.redirectedFrom();
          if (!prev) break;
          const prevUrl = typeof prev.url === 'function' ? prev.url() : '';
          const currUrl = typeof currReq.url === 'function' ? currReq.url() : '';

          if (prevUrl.startsWith('https:') && currUrl.startsWith('http:')) {
            await newPageInstance.close().catch(() => {});
            this._handlePageClosed(entry.pageId);
            throw new BrowserManagerError(
              `Insecure redirect downgrade from HTTPS to HTTP blocked: "${currUrl}"`,
              'INSECURE_REDIRECT_DOWNGRADE',
              { requestedUrl, finalUrl: currUrl }
            );
          }

          try {
            await validateUrlSafety(currUrl, { dnsLookup, allowTestLoopback });
          } catch (valErr) {
            await newPageInstance.close().catch(() => {});
            this._handlePageClosed(entry.pageId);
            throw new BrowserManagerError(
              `Redirect destination blocked: ${valErr.message}`,
              valErr.code || 'LOCAL_OR_PRIVATE_HOST_BLOCKED',
              { requestedUrl, redirectUrl: currUrl }
            );
          }

          currReq = prev;
        }
      }
    }

    try {
      if (typeof newPageInstance.url === 'function') currentUrl = newPageInstance.url();
      if (typeof newPageInstance.title === 'function') currentTitle = (await newPageInstance.title()) || '';
    } catch {}

    return {
      success: true,
      pageId: entry.pageId,
      previousActivePageId,
      activePageId: this._activePageId,
      url: currentUrl,
      title: currentTitle,
      pageCount: this._pages.size
    };
  }

  /**
   * Switches the active page to the specified pageId without navigating or reloading (Brick 31).
   *
   * @param {string} pageId
   * @returns {Promise<{
   *   success: boolean,
   *   pageId: string,
   *   activePageId: string,
   *   url: string,
   *   title: string
   * }>}
   */
  async switchPage(pageId) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    if (typeof pageId !== 'string' || pageId.trim().length === 0) {
      throw new BrowserManagerError('Page ID must be a non-empty string.', 'PAGE_NOT_FOUND');
    }

    const cleanPageId = pageId.trim();
    const entry = this._pages.get(cleanPageId);
    if (!entry) {
      throw new BrowserManagerError(`Page "${cleanPageId}" not found.`, 'PAGE_NOT_FOUND');
    }

    if (entry.page && typeof entry.page.isClosed === 'function' && entry.page.isClosed()) {
      this._handlePageClosed(cleanPageId);
      throw new BrowserManagerError(`Page "${cleanPageId}" is closed.`, 'PAGE_NOT_FOUND');
    }

    const previousActivePageId = this._activePageId;
    if (previousActivePageId && previousActivePageId !== cleanPageId) {
      this._cancelDynamicWaiters(previousActivePageId, new BrowserManagerError('Active page changed while waiting.', 'ACTIVE_PAGE_CHANGED'));
    }

    this._activePageId = cleanPageId;
    entry.lastActivatedAt = Date.now();
    this._page = entry.page;
    this._legacyPage = entry.page;
    this._snapshotToken = entry.snapshotToken || null;
    this._snapshotVersion = entry.snapshotVersion || 0;

    if (entry.page && typeof entry.page.bringToFront === 'function') {
      await entry.page.bringToFront().catch(() => {});
    }

    let currentUrl = 'about:blank';
    let currentTitle = '';
    try {
      if (entry.page) {
        if (typeof entry.page.url === 'function') currentUrl = entry.page.url();
        if (typeof entry.page.title === 'function') currentTitle = (await entry.page.title()) || '';
      }
    } catch {
      // safe fallback
    }

    return {
      success: true,
      pageId: cleanPageId,
      activePageId: cleanPageId,
      url: currentUrl,
      title: currentTitle
    };
  }

  /**
   * Closes the specified managed page safely (Brick 31).
   *
   * @param {string} pageId
   * @returns {Promise<{
   *   success: boolean,
   *   closedPageId: string,
   *   newActivePageId: string|null,
   *   activePageId: string|null,
   *   pageCount: number
   * }>}
   */
  async closePage(pageId) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    if (typeof pageId !== 'string' || pageId.trim().length === 0) {
      throw new BrowserManagerError('Page ID must be a non-empty string.', 'PAGE_NOT_FOUND');
    }

    const cleanPageId = pageId.trim();
    const entry = this._pages.get(cleanPageId);
    if (!entry) {
      throw new BrowserManagerError(`Page "${cleanPageId}" not found.`, 'PAGE_NOT_FOUND');
    }

    try {
      if (entry.page && typeof entry.page.close === 'function') {
        const closePromise = entry.page.close({ runBeforeUnload: false });
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Page close timeout')), 5000));
        await Promise.race([closePromise, timeoutPromise]).catch(() => {});
      }
    } catch {
      // safe fallback
    }

    this._handlePageClosed(cleanPageId);

    return {
      success: true,
      closedPageId: cleanPageId,
      newActivePageId: this._activePageId,
      activePageId: this._activePageId,
      pageCount: this._pages.size
    };
  }

  /**
   * Clears internal references to managed browser, context, and page objects.
   * @private
   */
  _cleanupReferences() {
    if (this._context) {
      if (this._contextPageListener) {
        if (typeof this._context.removeListener === 'function') {
          this._context.removeListener('page', this._contextPageListener);
        } else if (typeof this._context.off === 'function') {
          this._context.off('page', this._contextPageListener);
        }
      }
      if (this._contextCloseListener) {
        if (typeof this._context.removeListener === 'function') {
          this._context.removeListener('close', this._contextCloseListener);
        } else if (typeof this._context.off === 'function') {
          this._context.off('close', this._contextCloseListener);
        }
      }
    }
    if (this._browser && this._browserDisconnectListener) {
      if (typeof this._browser.removeListener === 'function') {
        this._browser.removeListener('disconnected', this._browserDisconnectListener);
      } else if (typeof this._browser.off === 'function') {
        this._browser.off('disconnected', this._browserDisconnectListener);
      }
    }
    this._contextPageListener = null;
    this._contextCloseListener = null;
    this._browserDisconnectListener = null;
    this._browser = null;
    this._context = null;
    this._page = null;
    this._legacyPage = null;
    this._cancelDynamicWaiters(null, new BrowserManagerError('Browser was closed while waiting.', 'BROWSER_NOT_RUNNING'));
    this._dynamicWaiters.clear();
    this._activeDynamicWaits = 0;
    this._pages.clear();
    this._activePageId = null;
    this._pendingAuthorizedCreation = null;
    this._actionPopupWindow = null;
    this._resetSnapshot();
  }

  /**
   * Initializes lightweight in-browser dynamic tracking script on a managed page (Brick 32).
   * Registers init script so all navigations/documents automatically run the tracker.
   *
   * @param {Object} pageInstance
   * @param {string} pageId
   * @private
   */
  _initDynamicTracker(pageInstance, pageId) {
    if (!pageInstance) return;
    try {
      if (typeof pageInstance.addInitScript === 'function') {
        pageInstance.addInitScript(DYNAMIC_TRACKER_SCRIPT).catch(() => {});
      }
    } catch {}
  }

  /**
   * Synchronizes dynamic state between in-page tracker and node-side page registry (Brick 32).
   * Ensures the observer is actively installed and running in the current document.
   *
   * @param {string} [pageId]
   * @returns {Promise<Object|null>}
   */
  async syncDynamicState(pageId = this._activePageId) {
    const pId = pageId || this._activePageId;
    if (!pId || !this._pages.has(pId)) return null;

    const entry = this._pages.get(pId);
    if (!entry || !entry.page) return null;

    if (typeof entry.page.evaluate === 'function') {
      try {
        let inPage = await entry.page.evaluate(() => {
          const t = window.__JARVIS_DYNAMIC_TRACKER__;
          if (!t) return null;
          if (typeof t.ensureObserver === 'function') {
            t.ensureObserver();
          }
          return {
            semanticRevision: t.semanticRevision,
            spaRouteVersion: t.spaRouteVersion,
            lastRelevantMutationTime: t.lastRelevantMutationTime,
            lastUrl: t.lastUrl,
            spaRouteChanged: t.spaRouteChanged,
            observerInstalled: Boolean(t.observerInstalled || t.observer)
          };
        });

        if (!inPage) {
          // If in-page tracker is not yet present in the current document, inject now
          await entry.page.evaluate(DYNAMIC_TRACKER_SCRIPT).catch(() => {});
          inPage = await entry.page.evaluate(() => {
            const t = window.__JARVIS_DYNAMIC_TRACKER__;
            if (!t) return null;
            if (typeof t.ensureObserver === 'function') {
              t.ensureObserver();
            }
            return {
              semanticRevision: t.semanticRevision,
              spaRouteVersion: t.spaRouteVersion,
              lastRelevantMutationTime: t.lastRelevantMutationTime,
              lastUrl: t.lastUrl,
              spaRouteChanged: t.spaRouteChanged,
              observerInstalled: Boolean(t.observerInstalled || t.observer)
            };
          }).catch(() => null);
        }

        if (inPage) {
          entry.dynamicObserverInstalled = Boolean(inPage.observerInstalled);
          if (inPage.semanticRevision > entry.semanticRevision) {
            entry.semanticRevision = inPage.semanticRevision;
            entry.lastRelevantMutationTimestamp = inPage.lastRelevantMutationTime;
            this._invalidateSnapshot(pId);
          } else if (inPage.lastRelevantMutationTime > (entry.lastRelevantMutationTimestamp || 0)) {
            entry.lastRelevantMutationTimestamp = inPage.lastRelevantMutationTime;
          }
          if (inPage.spaRouteVersion > entry.spaRouteVersion || (inPage.lastUrl && inPage.lastUrl !== entry.currentUrl)) {
            entry.spaRouteVersion = inPage.spaRouteVersion;
            entry.currentUrl = inPage.lastUrl;
            entry.spaRouteChanged = true;
            this._invalidateSnapshot(pId);
          }
        }
      } catch {}
    }

    return {
      pageId: pId,
      semanticRevision: entry.semanticRevision,
      spaRouteVersion: entry.spaRouteVersion,
      lastRelevantMutationTimestamp: entry.lastRelevantMutationTimestamp,
      currentUrl: entry.currentUrl,
      dynamicObserverInstalled: Boolean(entry.dynamicObserverInstalled ?? true),
      documentVersion: entry.documentVersion || 1
    };
  }

  /**
   * Manually records a semantic mutation on a page (Brick 32).
   *
   * @param {string} [pageId]
   * @returns {number} new semanticRevision
   */
  recordSemanticMutation(pageId = this._activePageId) {
    const pId = pageId || this._activePageId;
    if (pId && this._pages.has(pId)) {
      const entry = this._pages.get(pId);
      entry.semanticRevision++;
      entry.lastRelevantMutationTimestamp = Date.now();
      return entry.semanticRevision;
    }
    return 1;
  }

  /**
   * Manually records a SPA route change on a page (Brick 32).
   *
   * @param {string} newUrl
   * @param {string} [pageId]
   * @returns {Object|null}
   */
  recordSpaRoute(newUrl, pageId = this._activePageId) {
    const pId = pageId || this._activePageId;
    if (pId && this._pages.has(pId)) {
      const entry = this._pages.get(pId);
      entry.currentUrl = newUrl;
      if (entry.page && typeof entry.page.setUrl === 'function') {
        entry.page.setUrl(newUrl);
      }
      entry.spaRouteVersion++;
      entry.spaRouteChanged = true;
      entry.semanticRevision++;
      entry.lastRelevantMutationTimestamp = Date.now();
      this._invalidateSnapshot(pId);
      return {
        pageId: pId,
        currentUrl: newUrl,
        spaRouteVersion: entry.spaRouteVersion,
        semanticRevision: entry.semanticRevision
      };
    }
    return null;
  }

  /**
   * Cancels active dynamic waiters matching a specific page or all pages (Brick 32).
   *
   * @param {string|null} pageId
   * @param {Error} err
   * @private
   */
  _cancelDynamicWaiters(pageId, err) {
    for (const waiter of Array.from(this._dynamicWaiters)) {
      if (!pageId || waiter.pageId === pageId) {
        try {
          waiter.cancel(err);
        } catch {}
      }
    }
  }

  /**
   * Bounded wait for active page's semantic surface to become quiet (Brick 32).
   *
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.quietMs]
   * @param {number} [options.pollMs]
   * @param {string} [options.pageId]
   * @param {Function} [options.sleeper]
   * @returns {Promise<Object>}
   */
  async waitForStable(options = {}) {
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    if (this._activeDynamicWaits >= this._maxDynamicWaits) {
      throw new BrowserManagerError(
        `Dynamic wait concurrency limit (${this._maxDynamicWaits}) reached.`,
        'DYNAMIC_WAIT_LIMIT_REACHED'
      );
    }

    const targetPageId = (options.pageId || this._activePageId || '').trim();
    const entry = this._pages.get(targetPageId);
    if (!entry || !this._isPageReallyOpen(entry.page)) {
      throw new BrowserManagerError('Page is closed or not found.', 'PAGE_CLOSED');
    }

    const timeoutMs = Math.min(Math.max(Number(options.timeoutMs ?? this._dynamicTimeoutMs) || 5000, 100), 60000);
    const quietMs = Math.min(Math.max(Number(options.quietMs ?? this._domQuietMs) || 300, 50), 5000);
    const pollMs = Math.min(Math.max(Number(options.pollMs ?? this._dynamicPollMs) || 100, 20), 1000);
    const sleeper = typeof options.sleeper === 'function' ? options.sleeper : null;

    let cancelReject = null;
    const cancelPromise = new Promise((_, reject) => {
      cancelReject = reject;
    });

    const waiter = {
      pageId: targetPageId,
      cancel: (err) => {
        if (cancelReject) {
          cancelReject(err);
        }
      }
    };

    this._activeDynamicWaits++;
    this._dynamicWaiters.add(waiter);

    const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    try {
      while (true) {
        this._reconcileLifecycle();
        if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
          throw new BrowserManagerError('Browser is not running. Please launch the browser first.', 'BROWSER_NOT_RUNNING');
        }
        if (!this._pages.has(targetPageId) || !this._isPageReallyOpen(entry.page)) {
          throw new BrowserManagerError('Page is closed.', 'PAGE_CLOSED');
        }
        if (options.pageId === undefined && this._activePageId !== targetPageId) {
          throw new BrowserManagerError('Active page changed while waiting.', 'ACTIVE_PAGE_CHANGED');
        }

        await this.syncDynamicState(targetPageId);

        const now = Date.now();
        const quietForMs = Math.max(0, now - (entry.lastRelevantMutationTimestamp || now));
        const currentElapsed = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now() - startTime
          : Date.now() - startTime;
        const elapsedMs = Math.max(0, currentElapsed);

        if (quietForMs >= quietMs) {
          this._invalidateSnapshot(targetPageId);
          let currentUrl = 'about:blank';
          let title = '';
          try {
            if (entry.page) {
              if (typeof entry.page.url === 'function') currentUrl = entry.page.url();
              if (typeof entry.page.title === 'function') title = (await entry.page.title()) || '';
            }
          } catch {}

          return {
            success: true,
            settled: true,
            pageId: targetPageId,
            currentUrl,
            title,
            semanticRevision: entry.semanticRevision,
            quietForMs,
            waitDurationMs: Number(elapsedMs.toFixed(3)),
            snapshotToken: entry.snapshotToken,
            dynamicObserverInstalled: Boolean(entry.dynamicObserverInstalled ?? true),
            observerDocumentVersion: entry.documentVersion ?? 1
          };
        }

        if (elapsedMs >= timeoutMs) {
          throw new BrowserManagerError(
            `Page did not become quiet within ${timeoutMs}ms.`,
            'PAGE_NOT_STABLE',
            {
              pageId: targetPageId,
              semanticRevision: entry.semanticRevision,
              quietForMs,
              waitDurationMs: Number(elapsedMs.toFixed(3)),
              settled: false,
              dynamicObserverInstalled: Boolean(entry.dynamicObserverInstalled ?? true),
              observerDocumentVersion: entry.documentVersion ?? 1
            }
          );
        }

        const remainingMs = timeoutMs - elapsedMs;
        const sleepTime = Math.min(pollMs, Math.max(20, quietMs - quietForMs), remainingMs);
        const sleepPromise = sleeper ? sleeper(sleepTime) : new Promise((res) => setTimeout(res, sleepTime));
        await Promise.race([sleepPromise, cancelPromise]);
      }
    } finally {
      this._dynamicWaiters.delete(waiter);
      this._activeDynamicWaits = Math.max(0, this._activeDynamicWaits - 1);
    }
  }

  /**
   * Bounded wait for ONE semantic target to appear/become resolvable (Brick 32).
   * Read-only readiness primitive: strictly NO clicks, fills, checks, selects, navigates, or submits.
   *
   * @param {Object} [options]
   * @param {Object} options.target
   * @param {number} [options.timeoutMs]
   * @param {Object} [options={}]
   * @param {Object} [extraOptions={}]
   * @param {Object} options.target
   * @param {number} [options.timeoutMs]
   * @param {number} [options.pollMs]
   * @param {string} [options.pageId]
   * @param {Function} [options.sleeper]
   * @returns {Promise<Object>}
   */
  async waitForTarget(options = {}, extraOptions = {}) {
    let mergedOptions;
    if (options && (options.target || options.timeoutMs !== undefined || options.pollMs !== undefined || options.pageId !== undefined)) {
      mergedOptions = { ...extraOptions, ...options };
      if (!mergedOptions.target && (options.kind || options.text || options.visibleText || options.name)) {
        mergedOptions.target = options;
      }
    } else {
      mergedOptions = { ...extraOptions, target: options };
    }
    this._reconcileLifecycle();

    if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
      throw new BrowserManagerError(
        'Browser is not running. Please launch the browser first.',
        'BROWSER_NOT_RUNNING'
      );
    }

    if (this._activeDynamicWaits >= this._maxDynamicWaits) {
      throw new BrowserManagerError(
        `Dynamic wait concurrency limit (${this._maxDynamicWaits}) reached.`,
        'DYNAMIC_WAIT_LIMIT_REACHED'
      );
    }

    const targetQuery = mergedOptions.target;
    if (!targetQuery || typeof targetQuery !== 'object' || Array.isArray(targetQuery)) {
      throw new BrowserManagerError('Target query must be an object.', 'INVALID_TARGET_QUERY');
    }

    if (targetQuery.selector || targetQuery.css || targetQuery.xpath || targetQuery.locator || targetQuery.js) {
      throw new BrowserManagerError(
        'CSS selectors, XPath, and locator expressions are not accepted.',
        'INVALID_TARGET_QUERY'
      );
    }

    const onlyTargetId = Boolean(
      targetQuery.targetId &&
      !targetQuery.kind &&
      !targetQuery.name &&
      !targetQuery.accessibleName &&
      !targetQuery.label &&
      !targetQuery.visibleText &&
      !targetQuery.text &&
      !targetQuery.placeholder &&
      !targetQuery.role &&
      !targetQuery.inputType
    );
    if (onlyTargetId) {
      throw new BrowserManagerError(
        'Target ID alone cannot authorize target wait. Semantic target description is required.',
        'TARGETID_AUTHORIZATION_NOT_ALLOWED'
      );
    }

    const targetPageId = (mergedOptions.pageId || this._activePageId || '').trim();
    const entry = this._pages.get(targetPageId);
    if (!entry || !this._isPageReallyOpen(entry.page)) {
      throw new BrowserManagerError('Page is closed or not found.', 'PAGE_CLOSED');
    }

    const timeoutMs = Math.min(Math.max(Number(mergedOptions.timeoutMs ?? this._dynamicTimeoutMs) || 5000, 100), 60000);
    const pollMs = Math.min(Math.max(Number(mergedOptions.pollMs ?? this._dynamicPollMs) || 100, 20), 1000);
    const sleeper = typeof mergedOptions.sleeper === 'function' ? mergedOptions.sleeper : null;

    let cancelReject = null;
    const cancelPromise = new Promise((_, reject) => {
      cancelReject = reject;
    });

    const waiter = {
      pageId: targetPageId,
      cancel: (err) => {
        if (cancelReject) {
          cancelReject(err);
        }
      }
    };

    this._activeDynamicWaits++;
    this._dynamicWaiters.add(waiter);

    const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    let lastResolution = null;

    try {
      while (true) {
        this._reconcileLifecycle();
        if (this._state !== BROWSER_STATES.RUNNING || !this.isSessionActive()) {
          throw new BrowserManagerError('Browser is not running. Please launch the browser first.', 'BROWSER_NOT_RUNNING');
        }
        if (!this._pages.has(targetPageId) || !this._isPageReallyOpen(entry.page)) {
          throw new BrowserManagerError('Page is closed.', 'PAGE_CLOSED');
        }
        if (mergedOptions.pageId === undefined && this._activePageId !== targetPageId) {
          throw new BrowserManagerError('Active page changed while waiting.', 'ACTIVE_PAGE_CHANGED');
        }

        await this.syncDynamicState(targetPageId);

        const { target: _t, timeoutMs: _tm, pollMs: _pm, sleeper: _sl, pageId: _pid, ...forwardedResolveOpts } = mergedOptions;

        try {
          lastResolution = await this.resolveTarget(targetQuery, { pageId: targetPageId, ...forwardedResolveOpts });
        } catch (resErr) {
          if (resErr instanceof TargetResolutionError) {
            lastResolution = {
              resolution: resErr.code === 'TARGET_AMBIGUOUS' ? 'ambiguous' : 'not_found',
              confidence: 'low',
              candidateCount: resErr.details?.candidateCount || 0,
              candidates: resErr.details?.candidates || []
            };
          } else {
            throw resErr;
          }
        }

        const currentElapsed = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now() - startTime
          : Date.now() - startTime;
        const elapsedMs = Math.max(0, currentElapsed);

        if (lastResolution && lastResolution.resolution === 'unique' && lastResolution.confidence === 'high') {
          return {
            success: true,
            resolution: 'unique',
            confidence: 'high',
            pageId: targetPageId,
            snapshotToken: lastResolution.snapshotToken || entry.snapshotToken,
            target: createSafeElementSummary(lastResolution.match),
            waitDurationMs: Number(elapsedMs.toFixed(3))
          };
        }

        if (elapsedMs >= timeoutMs) {
          if (lastResolution && lastResolution.resolution === 'ambiguous') {
            throw new BrowserManagerError(
              'Multiple elements matched the target query equally on timeout.',
              'TARGET_AMBIGUOUS',
              {
                pageId: targetPageId,
                candidateCount: lastResolution.candidateCount,
                candidates: lastResolution.candidates,
                waitDurationMs: Number(elapsedMs.toFixed(3))
              }
            );
          }
          if (lastResolution && lastResolution.confidence === 'medium') {
            throw new BrowserManagerError(
              'Target resolved with only medium confidence (high required) within timeout.',
              'TARGET_NOT_READY',
              {
                pageId: targetPageId,
                confidence: 'medium',
                waitDurationMs: Number(elapsedMs.toFixed(3))
              }
            );
          }
          throw new BrowserManagerError(
            'Target element did not become ready within timeout.',
            'TARGET_NOT_READY',
            {
              pageId: targetPageId,
              reason: 'not_found',
              waitDurationMs: Number(elapsedMs.toFixed(3))
            }
          );
        }

        const remainingMs = timeoutMs - elapsedMs;
        const sleepTime = Math.min(pollMs, remainingMs);
        const sleepPromise = sleeper ? sleeper(sleepTime) : new Promise((res) => setTimeout(res, sleepTime));
        await Promise.race([sleepPromise, cancelPromise]);
      }
    } finally {
      this._dynamicWaiters.delete(waiter);
      this._activeDynamicWaits = Math.max(0, this._activeDynamicWaits - 1);
    }
  }
}

export const defaultBrowserManager = new BrowserManager();

export default defaultBrowserManager;
