/**
 * DOM Context Manager for JARVIS4 (Brick 39).
 * Manages semantic DOM context identity and scoped lifecycle beyond top-level documents:
 * - Main document (root)
 * - Same-origin and cross-origin iframes
 * - Nested iframes
 * - Open Shadow DOM roots
 * - Nested open Shadow DOM roots
 * - Mixed context trees (e.g. main -> iframe -> open shadow root)
 *
 * Strict invariants:
 * - Zero AI / LLM / OpenRouter / Exa calls.
 * - Zero arbitrary CSS selector, XPath, or arbitrary JS execution APIs exposed.
 * - Closed shadow roots are strictly unsupported (CLOSED_SHADOW_ROOT_UNSUPPORTED). Zero bypass.
 * - Opaque context IDs (ctx_...) with lifecycle binding. Never expose selectors or backend handles.
 * - Context-scoped snapshot tokens and independent semantic revisions.
 * - Bounded depth (BROWSER_MAX_CONTEXT_DEPTH) and context count (BROWSER_MAX_DOM_CONTEXTS).
 */

import { config } from '../config/index.js';
import { generateSnapshotToken } from './targetResolver.js';

export class DomContextError extends Error {
  /**
   * @param {string} message
   * @param {string} [code='CONTEXT_ERROR']
   * @param {Object} [details={}]
   */
  constructor(message, code = 'CONTEXT_ERROR', details = {}) {
    super(message);
    this.name = 'DomContextError';
    this.code = code;
    this.details = details;
  }
}

export const CONTEXT_TYPES = Object.freeze({
  MAIN: 'main',
  FRAME: 'frame',
  SHADOW_ROOT: 'shadow-root'
});

let contextCounter = 0;

/**
 * Generates an opaque, stable lifecycle-bound context identifier (Section 5).
 * Format: ctx_<type>_<timestamp>_<random>_<counter>
 *
 * @param {string} type - 'main' | 'frame' | 'shadow-root'
 * @param {string} [pageId=''] - Optional page ID for main context
 * @returns {string}
 */
export function generateContextId(type = CONTEXT_TYPES.FRAME, pageId = '') {
  if (type === CONTEXT_TYPES.MAIN && pageId) {
    return `ctx_main_${pageId}`;
  }
  contextCounter = (contextCounter + 1) % 1000000;
  const rnd = Math.random().toString(36).slice(2, 8);
  const typeTag = type === CONTEXT_TYPES.SHADOW_ROOT ? 'shadow' : type;
  return `ctx_${typeTag}_${Date.now().toString(36)}_${rnd}_${contextCounter.toString(36)}`;
}

/**
 * Client-side script injected into page/frames to discover open shadow roots
 * and track independent shadow root mutations without piercing closed roots.
 */
export const SHADOW_DISCOVERY_SCRIPT = `
(function() {
  if (!window.__JARVIS_SHADOW_REGISTRY__) {
    window.__JARVIS_SHADOW_REGISTRY__ = new Map();
  }
  if (!window.__JARVIS_SHADOW_MUTATION_OBSERVERS__) {
    window.__JARVIS_SHADOW_MUTATION_OBSERVERS__ = new Map();
  }
  if (!window.__JARVIS_SHADOW_REVISIONS__) {
    window.__JARVIS_SHADOW_REVISIONS__ = new Map();
  }
})();
`;

/**
 * In-browser evaluation function to discover open shadow roots inside a document or parent shadow root.
 * Bounded by maxDepth and maxContexts. Detects closed roots truthfully without circumvention.
 *
 * @param {Object} args
 * @param {number} args.maxDepth
 * @param {number} args.maxElements
 * @returns {{
 *   shadowRoots: Array<Object>,
 *   closedShadowRootDetected: boolean
 * }}
 */
export function inPageDiscoverShadowRoots({ maxDepth = 6, maxElements = 64 } = {}) {
  const registry = window.__JARVIS_SHADOW_REGISTRY__ || new Map();
  const observers = window.__JARVIS_SHADOW_MUTATION_OBSERVERS__ || new Map();
  const revisions = window.__JARVIS_SHADOW_REVISIONS__ || new Map();
  window.__JARVIS_SHADOW_REGISTRY__ = registry;
  window.__JARVIS_SHADOW_MUTATION_OBSERVERS__ = observers;
  window.__JARVIS_SHADOW_REVISIONS__ = revisions;

  let closedDetected = false;
  const results = [];

  function getAccessibleName(el) {
    if (!el) return null;
    const ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    const title = el.getAttribute ? el.getAttribute('title') : null;
    if (title && title.trim()) return title.trim();
    if (typeof el.innerText === 'string' && el.innerText.trim().length > 0 && el.innerText.trim().length <= 100) {
      return el.innerText.trim().split('\\n')[0].slice(0, 80);
    }
    return null;
  }

  function traverse(rootNode, parentShadowHandleId = null, currentDepth = 1) {
    if (!rootNode || currentDepth > maxDepth || results.length >= maxElements) {
      return;
    }

    let allElements = [];
    try {
      if (typeof rootNode.querySelectorAll === 'function') {
        allElements = Array.from(rootNode.querySelectorAll('*'));
      }
    } catch {
      return;
    }

    for (const el of allElements) {
      if (results.length >= maxElements) break;

      const tag = (el.tagName || '').toLowerCase();

      // Detection of closed shadow root without bypass
      // If element is a custom element (tag contains '-') and el.shadowRoot is null,
      // it might be closed mode or unattached. We record closedShadowRootDetected.
      if (tag.includes('-') && !el.shadowRoot) {
        if (typeof customElements !== 'undefined' && customElements.get && customElements.get(tag)) {
          // It is a registered custom element without open shadow root
          closedDetected = true;
        }
      }

      // Open shadow root check
      if (el.shadowRoot && el.shadowRoot.mode === 'open') {
        let shadowHandleId = null;
        // Search if already in registry
        for (const [id, reg] of registry.entries()) {
          if (reg.shadowRoot === el.shadowRoot) {
            shadowHandleId = id;
            break;
          }
        }
        if (!shadowHandleId) {
          shadowHandleId = 'sh_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
          registry.set(shadowHandleId, {
            shadowRoot: el.shadowRoot,
            host: el,
            createdAt: Date.now()
          });

          // Set initial revision
          if (!revisions.has(shadowHandleId)) {
            revisions.set(shadowHandleId, {
              semanticRevision: 1,
              lastRelevantMutationTime: Date.now()
            });
          }

          // Install shadow MutationObserver for independent revision tracking
          if (typeof MutationObserver !== 'undefined' && !observers.has(shadowHandleId)) {
            try {
              const obs = new MutationObserver(() => {
                const revState = revisions.get(shadowHandleId);
                if (revState) {
                  revState.semanticRevision++;
                  revState.lastRelevantMutationTime = Date.now();
                }
              });
              obs.observe(el.shadowRoot, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true
              });
              observers.set(shadowHandleId, obs);
            } catch {}
          }
        }

        const hostMetadata = {
          tag,
          accessibleName: getAccessibleName(el),
          role: el.getAttribute ? (el.getAttribute('role') || null) : null
        };

        const revState = revisions.get(shadowHandleId) || { semanticRevision: 1, lastRelevantMutationTime: Date.now() };

        results.push({
          shadowHandleId,
          parentShadowHandleId,
          depth: currentDepth,
          host: hostMetadata,
          semanticRevision: revState.semanticRevision,
          lastRelevantMutationTime: revState.lastRelevantMutationTime
        });

        // Recurse into nested open shadow roots
        traverse(el.shadowRoot, shadowHandleId, currentDepth + 1);
      }
    }
  }

  traverse(document, null, 1);

  return {
    shadowRoots: results,
    closedShadowRootDetected: closedDetected
  };
}

/**
 * Manages all DOM contexts for a specific managed page.
 */
export class DomContextManager {
  /**
   * @param {Object} options
   * @param {string} options.pageId
   * @param {Object} options.pageEntry - BrowserManager page entry
   * @param {number} [options.maxDomContexts]
   * @param {number} [options.maxContextDepth]
   */
  constructor({ pageId, pageEntry, maxDomContexts, maxContextDepth }) {
    if (!pageId || typeof pageId !== 'string') {
      throw new DomContextError('DomContextManager requires valid pageId.', 'INVALID_PAGE_ID');
    }
    this._pageId = pageId;
    this._pageEntry = pageEntry;
    this._maxDomContexts = Math.min(Math.max(Number(maxDomContexts ?? config.browser?.maxDomContexts ?? 64) || 64, 1), 256);
    this._maxContextDepth = Math.min(Math.max(Number(maxContextDepth ?? config.browser?.maxContextDepth ?? 6) || 6, 1), 16);

    this._mainContextId = generateContextId(CONTEXT_TYPES.MAIN, pageId);

    // Map: contextId -> contextRecord
    this._contexts = new Map();

    // Map: Playwright Frame instance -> contextId
    this._frameToContextId = new Map();

    // Map: shadowHandleId -> contextId
    this._shadowHandleToContextId = new Map();

    // Frame lifecycle listeners stored for cleanup
    this._frameAttachedListener = null;
    this._frameDetachedListener = null;
    this._frameNavigatedListener = null;

    // Initialize root main context
    this._initMainContext();

    // Attach Playwright frame listeners if page is available
    this._attachFrameListeners();
  }

  get pageId() {
    return this._pageId;
  }

  get mainContextId() {
    return this._mainContextId;
  }

  get maxDomContexts() {
    return this._maxDomContexts;
  }

  get maxContextDepth() {
    return this._maxContextDepth;
  }

  get contextCount() {
    return this._contexts.size;
  }

  /**
   * Initializes or refreshes the main document context.
   * @private
   */
  _initMainContext() {
    const existing = this._contexts.get(this._mainContextId);
    const now = Date.now();
    const docVer = this._pageEntry?.documentVersion ?? 1;
    const semRev = this._pageEntry?.semanticRevision ?? 1;
    const snapVer = this._pageEntry?.snapshotVersion ?? 1;
    const snapTok = this._pageEntry?.snapshotToken ?? generateSnapshotToken(1, `${this._pageId}_${semRev}_${now.toString(36)}`);

    const mainRecord = {
      contextId: this._mainContextId,
      pageId: this._pageId,
      type: CONTEXT_TYPES.MAIN,
      parentContextId: null,
      depth: 0,
      attached: true,
      documentVersion: docVer,
      semanticRevision: semRev,
      snapshotVersion: snapVer,
      snapshotToken: snapTok,
      snapshotSemanticRevision: semRev,
      lastMutationTimestamp: this._pageEntry?.lastRelevantMutationTimestamp ?? now,
      createdAt: existing ? existing.createdAt : now,
      url: typeof this._pageEntry?.page?.url === 'function' ? this._pageEntry.page.url() : (this._pageEntry?.currentUrl || 'about:blank'),
      title: this._pageEntry?.title || '',
      frame: typeof this._pageEntry?.page?.mainFrame === 'function' ? this._pageEntry.page.mainFrame() : null
    };

    if (mainRecord.frame) {
      this._frameToContextId.set(mainRecord.frame, this._mainContextId);
    }
    this._contexts.set(this._mainContextId, mainRecord);
  }

  /**
   * Attaches frame lifecycle listeners to the Playwright Page instance.
   * @private
   */
  _attachFrameListeners() {
    const page = this._pageEntry?.page;
    if (!page || typeof page.on !== 'function') return;

    this._frameAttachedListener = (frame) => {
      this._handleFrameAttached(frame);
    };

    this._frameDetachedListener = (frame) => {
      this._handleFrameDetached(frame);
    };

    this._frameNavigatedListener = (frame) => {
      this._handleFrameNavigated(frame);
    };

    page.on('frameattached', this._frameAttachedListener);
    page.on('framedetached', this._frameDetachedListener);
    page.on('framenavigated', this._frameNavigatedListener);
  }

  /**
   * Removes attached frame listeners.
   * @private
   */
  _detachFrameListeners() {
    const page = this._pageEntry?.page;
    if (!page) return;

    if (this._frameAttachedListener && typeof page.removeListener === 'function') {
      page.removeListener('frameattached', this._frameAttachedListener);
    }
    if (this._frameDetachedListener && typeof page.removeListener === 'function') {
      page.removeListener('framedetached', this._frameDetachedListener);
    }
    if (this._frameNavigatedListener && typeof page.removeListener === 'function') {
      page.removeListener('framenavigated', this._frameNavigatedListener);
    }
    this._frameAttachedListener = null;
    this._frameDetachedListener = null;
    this._frameNavigatedListener = null;
  }

  /**
   * Calculates depth of a frame relative to main frame.
   * @param {Object} frame
   * @returns {number}
   */
  _calculateFrameDepth(frame) {
    let depth = 0;
    let curr = frame;
    while (curr && typeof curr.parentFrame === 'function') {
      const parent = curr.parentFrame();
      if (!parent) break;
      depth++;
      curr = parent;
      if (depth > this._maxContextDepth) break;
    }
    return depth;
  }

  /**
   * Validates frame URL safety (Section 15).
   * HTTP, HTTPS, about:blank, srcdoc are normal candidates.
   * Unsupported protocols (javascript:, file:, data:) rejected unless explicitly permitted.
   * @param {string} url
   * @returns {boolean}
   */
  _isSafeFrameUrl(url) {
    if (!url || typeof url !== 'string') return true;
    const trimmed = url.trim().toLowerCase();
    if (trimmed === 'about:blank' || trimmed === 'about:srcdoc' || trimmed.startsWith('srcdoc')) {
      return true;
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return true;
    }
    // Block unsafe frame protocols
    if (trimmed.startsWith('javascript:') || trimmed.startsWith('file:') || trimmed.startsWith('data:')) {
      return false;
    }
    return true;
  }

  /**
   * Handles frameattached event.
   * @param {Object} frame
   * @private
   */
  _handleFrameAttached(frame) {
    if (!frame) return;
    if (this._frameToContextId.has(frame)) return;

    const mainFrame = typeof this._pageEntry?.page?.mainFrame === 'function' ? this._pageEntry.page.mainFrame() : null;
    if (frame === mainFrame) {
      this._frameToContextId.set(frame, this._mainContextId);
      return;
    }

    if (this._contexts.size >= this._maxDomContexts) {
      return;
    }

    const depth = this._calculateFrameDepth(frame);
    if (depth > this._maxContextDepth) {
      return;
    }

    const parentFrame = typeof frame.parentFrame === 'function' ? frame.parentFrame() : null;
    let parentContextId = this._mainContextId;
    if (parentFrame && this._frameToContextId.has(parentFrame)) {
      parentContextId = this._frameToContextId.get(parentFrame);
    }

    const frameUrl = typeof frame.url === 'function' ? frame.url() : '';
    if (!this._isSafeFrameUrl(frameUrl)) {
      return;
    }

    const contextId = generateContextId(CONTEXT_TYPES.FRAME);
    const now = Date.now();
    const mainUrl = this._pageEntry?.currentUrl || 'about:blank';
    let sameOrigin = true;
    try {
      if (frameUrl && frameUrl !== 'about:blank' && mainUrl && mainUrl !== 'about:blank') {
        sameOrigin = new URL(frameUrl).origin === new URL(mainUrl).origin;
      }
    } catch {
      sameOrigin = false;
    }

    const frameRecord = {
      contextId,
      pageId: this._pageId,
      type: CONTEXT_TYPES.FRAME,
      parentContextId,
      depth,
      attached: true,
      documentVersion: 1,
      semanticRevision: 1,
      snapshotVersion: 1,
      snapshotToken: generateSnapshotToken(1, `${this._pageId}_${contextId}_1_${now.toString(36)}`),
      snapshotSemanticRevision: 1,
      lastMutationTimestamp: now,
      createdAt: now,
      url: frameUrl,
      name: typeof frame.name === 'function' ? frame.name() : '',
      sameOrigin,
      frame
    };

    this._frameToContextId.set(frame, contextId);
    this._contexts.set(contextId, frameRecord);
  }

  /**
   * Handles framedetached event (Section 11).
   * When a frame detaches, its contextId becomes invalid.
   * All associated snapshots, targets, revisions, and waiters become invalid.
   * @param {Object} frame
   * @private
   */
  _handleFrameDetached(frame) {
    if (!frame) return;
    const contextId = this._frameToContextId.get(frame);
    if (!contextId) return;

    this._frameToContextId.delete(frame);
    const record = this._contexts.get(contextId);
    if (record) {
      record.attached = false;
      record.snapshotToken = null;
      record.snapshotVersion = 0;
      record.frame = null;
    }
    this._contexts.delete(contextId);

    // Invalidate child contexts whose parent was this detached frame
    for (const [cId, ctx] of Array.from(this._contexts.entries())) {
      if (ctx.parentContextId === contextId) {
        ctx.attached = false;
        ctx.snapshotToken = null;
        ctx.snapshotVersion = 0;
        this._contexts.delete(cId);
      }
    }
  }

  /**
   * Handles framenavigated event (Section 12).
   * Frame navigation increments documentVersion and invalidates old context snapshots.
   * @param {Object} frame
   * @private
   */
  _handleFrameNavigated(frame) {
    if (!frame) return;
    const mainFrame = typeof this._pageEntry?.page?.mainFrame === 'function' ? this._pageEntry.page.mainFrame() : null;

    if (frame === mainFrame) {
      // Main frame navigation is handled by BrowserManager.
      return;
    }

    let contextId = this._frameToContextId.get(frame);
    if (!contextId) {
      this._handleFrameAttached(frame);
      contextId = this._frameToContextId.get(frame);
    }

    if (!contextId) return;

    const record = this._contexts.get(contextId);
    if (!record) return;

    const frameUrl = typeof frame.url === 'function' ? frame.url() : '';
    record.url = frameUrl;
    record.documentVersion = (record.documentVersion || 1) + 1;
    record.semanticRevision = 1;
    record.snapshotSemanticRevision = 1;
    record.lastMutationTimestamp = Date.now();

    // Old snapshots MUST become stale
    record.snapshotVersion = (record.snapshotVersion || 1) + 1;
    record.snapshotToken = generateSnapshotToken(record.snapshotVersion, `${this._pageId}_${contextId}_${record.documentVersion}_${Date.now().toString(36)}`);

    // Invalidate shadow contexts that were inside this frame before navigation
    for (const [cId, ctx] of Array.from(this._contexts.entries())) {
      if (ctx.type === CONTEXT_TYPES.SHADOW_ROOT && ctx.parentContextId === contextId) {
        ctx.attached = false;
        ctx.snapshotToken = null;
        this._contexts.delete(cId);
      }
    }
  }

  /**
   * Discovers and synchronizes all DOM contexts (frames and open shadow roots) for this page (Sections 7, 8, 47).
   * Reconciles current reality without ghost contexts. Bounded by limits.
   *
   * @param {Object} [options]
   * @returns {Promise<{
   *   pageId: string,
   *   contextCount: number,
   *   contexts: Array<Object>,
   *   contextLimitReached: boolean,
   *   maxDepthReached: boolean,
   *   closedShadowRootDetected: boolean
   * }>}
   */
  async discoverContexts(options = {}) {
    this._initMainContext();

    const page = this._pageEntry?.page;
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
      throw new DomContextError('Page is closed.', 'PAGE_CLOSED', { pageId: this._pageId });
    }

    let closedShadowDetected = false;
    let limitReached = false;
    let maxDepthReached = false;

    // 1. Reconcile frames from Playwright page.frames()
    if (typeof page.frames === 'function') {
      const liveFrames = page.frames();
      const mainFrame = typeof page.mainFrame === 'function' ? page.mainFrame() : null;

      for (const frame of liveFrames) {
        if (frame === mainFrame) continue;
        if (!this._frameToContextId.has(frame)) {
          this._handleFrameAttached(frame);
        } else {
          // Update frame record
          const cId = this._frameToContextId.get(frame);
          const rec = this._contexts.get(cId);
          if (rec) {
            rec.url = typeof frame.url === 'function' ? frame.url() : rec.url;
            rec.name = typeof frame.name === 'function' ? frame.name() : rec.name;
          }
        }
      }

      // Remove frames that are no longer in page.frames()
      for (const [frame, cId] of Array.from(this._frameToContextId.entries())) {
        if (frame !== mainFrame && !liveFrames.includes(frame)) {
          this._handleFrameDetached(frame);
        }
      }
    }

    // 2. Discover open shadow roots in main document and all live frames
    // We scan each frame execution context for open shadow roots
    const activeFrameEntries = [];
    const mainCtx = this._contexts.get(this._mainContextId);
    if (mainCtx) activeFrameEntries.push({ contextId: this._mainContextId, frame: page });

    for (const ctx of this._contexts.values()) {
      if (ctx.type === CONTEXT_TYPES.FRAME && ctx.frame && ctx.attached) {
        activeFrameEntries.push({ contextId: ctx.contextId, frame: ctx.frame });
      }
    }

    const currentDiscoveredShadowIds = new Set();

    for (const { contextId: parentFrameCtxId, frame } of activeFrameEntries) {
      if (this._contexts.size >= this._maxDomContexts) {
        limitReached = true;
        break;
      }

      try {
        if (typeof frame.evaluate !== 'function') continue;

        const scanRes = await frame.evaluate(inPageDiscoverShadowRoots, {
          maxDepth: this._maxContextDepth,
          maxElements: this._maxDomContexts - this._contexts.size
        });

        if (scanRes && scanRes.closedShadowRootDetected) {
          closedShadowDetected = true;
        }

        if (scanRes && Array.isArray(scanRes.shadowRoots)) {
          for (const sRoot of scanRes.shadowRoots) {
            if (this._contexts.size >= this._maxDomContexts) {
              limitReached = true;
              break;
            }

            const frameDepth = parentFrameCtxId === this._mainContextId ? 0 : (this._contexts.get(parentFrameCtxId)?.depth ?? 1);
            const totalDepth = frameDepth + sRoot.depth;
            if (totalDepth > this._maxContextDepth) {
              maxDepthReached = true;
              continue;
            }

            currentDiscoveredShadowIds.add(sRoot.shadowHandleId);

            // Determine parentContextId: either parent shadow root or the frame
            let parentCtxId = parentFrameCtxId;
            if (sRoot.parentShadowHandleId && this._shadowHandleToContextId.has(sRoot.parentShadowHandleId)) {
              parentCtxId = this._shadowHandleToContextId.get(sRoot.parentShadowHandleId);
            }

            let shadowCtxId = this._shadowHandleToContextId.get(sRoot.shadowHandleId);
            if (!shadowCtxId) {
              shadowCtxId = generateContextId(CONTEXT_TYPES.SHADOW_ROOT);
              this._shadowHandleToContextId.set(sRoot.shadowHandleId, shadowCtxId);

              const now = Date.now();
              const shadowRecord = {
                contextId: shadowCtxId,
                pageId: this._pageId,
                type: CONTEXT_TYPES.SHADOW_ROOT,
                parentContextId: parentCtxId,
                depth: totalDepth,
                attached: true,
                documentVersion: 1,
                semanticRevision: sRoot.semanticRevision || 1,
                snapshotVersion: 1,
                snapshotToken: generateSnapshotToken(1, `${this._pageId}_${shadowCtxId}_1_${now.toString(36)}`),
                snapshotSemanticRevision: sRoot.semanticRevision || 1,
                lastMutationTimestamp: sRoot.lastRelevantMutationTime || now,
                createdAt: now,
                shadowHandleId: sRoot.shadowHandleId,
                host: sRoot.host,
                frameCtxId: parentFrameCtxId,
                frame
              };
              this._contexts.set(shadowCtxId, shadowRecord);
            } else {
              // Refresh existing shadow record
              const rec = this._contexts.get(shadowCtxId);
              if (rec) {
                rec.attached = true;
                rec.depth = totalDepth;
                rec.host = sRoot.host;
                rec.semanticRevision = sRoot.semanticRevision || rec.semanticRevision;
                rec.lastMutationTimestamp = sRoot.lastRelevantMutationTime || rec.lastMutationTimestamp;
              }
            }
          }
        }
      } catch {
        // Safe capture: frame might be loading or cross-origin restricted
      }
    }

    // Clean up shadow roots that were detached / removed from DOM
    for (const [sHandleId, cId] of Array.from(this._shadowHandleToContextId.entries())) {
      if (!currentDiscoveredShadowIds.has(sHandleId)) {
        const rec = this._contexts.get(cId);
        if (rec) {
          rec.attached = false;
          rec.snapshotToken = null;
        }
        this._contexts.delete(cId);
        this._shadowHandleToContextId.delete(sHandleId);
      }
    }

    // Build safe return metadata (Section 7, 8, 10, 18)
    const contextsList = [];
    for (const ctx of this._contexts.values()) {
      if (!ctx.attached) continue;

      const item = {
        contextId: ctx.contextId,
        type: ctx.type,
        parentContextId: ctx.parentContextId,
        depth: ctx.depth
      };

      if (ctx.type === CONTEXT_TYPES.FRAME) {
        item.url = ctx.url;
        item.name = ctx.name || '';
        item.sameOrigin = Boolean(ctx.sameOrigin);
        item.attached = true;
      } else if (ctx.type === CONTEXT_TYPES.SHADOW_ROOT) {
        item.host = {
          tag: ctx.host?.tag || 'custom-element',
          accessibleName: ctx.host?.accessibleName || null,
          role: ctx.host?.role || null
        };
        item.attached = true;
      } else if (ctx.type === CONTEXT_TYPES.MAIN) {
        item.url = ctx.url;
        item.attached = true;
      }

      contextsList.push(item);
    }

    return {
      pageId: this._pageId,
      contextCount: contextsList.length,
      contexts: contextsList,
      contextLimitReached: limitReached || contextsList.length >= this._maxDomContexts,
      maxDepthReached,
      closedShadowRootDetected: closedShadowDetected
    };
  }

  /**
   * Resolves a contextId to an active, validated context record (Section 24).
   * Atomic binding: verifies page and context match.
   *
   * @param {string} [contextId] - If omitted, defaults to main document context
   * @returns {Object} contextRecord
   */
  resolveContext(contextId) {
    const targetCtxId = (contextId && typeof contextId === 'string' && contextId.trim().length > 0)
      ? contextId.trim()
      : this._mainContextId;

    if (targetCtxId === 'main') {
      targetCtxId = this._mainContextId;
    }

    const record = this._contexts.get(targetCtxId);
    if (!record || !record.attached) {
      if (record && !record.attached) {
        if (record.type === CONTEXT_TYPES.FRAME) {
          throw new DomContextError(`Frame context "${targetCtxId}" has detached.`, 'FRAME_DETACHED', { contextId: targetCtxId, pageId: this._pageId });
        }
        if (record.type === CONTEXT_TYPES.SHADOW_ROOT) {
          throw new DomContextError(`Shadow root context "${targetCtxId}" has detached.`, 'SHADOW_CONTEXT_DETACHED', { contextId: targetCtxId, pageId: this._pageId });
        }
        throw new DomContextError(`Context "${targetCtxId}" is stale.`, 'CONTEXT_STALE', { contextId: targetCtxId, pageId: this._pageId });
      }
      throw new DomContextError(`Context "${targetCtxId}" not found for page "${this._pageId}".`, 'CONTEXT_NOT_FOUND', { contextId: targetCtxId, pageId: this._pageId });
    }

    if (record.pageId !== this._pageId) {
      throw new DomContextError(`Context "${targetCtxId}" belongs to a different page.`, 'CONTEXT_PAGE_MISMATCH', { contextId: targetCtxId, expectedPageId: this._pageId, actualPageId: record.pageId });
    }

    if (record.type === CONTEXT_TYPES.MAIN && this._pageEntry) {
      record.documentVersion = this._pageEntry.documentVersion ?? record.documentVersion ?? 1;
      record.semanticRevision = this._pageEntry.semanticRevision ?? record.semanticRevision ?? 1;
      record.snapshotVersion = this._pageEntry.snapshotVersion ?? record.snapshotVersion ?? 1;
      record.snapshotSemanticRevision = this._pageEntry.snapshotSemanticRevision ?? this._pageEntry.semanticRevision ?? record.snapshotSemanticRevision ?? 1;
      record.snapshotToken = this._pageEntry.snapshotToken ?? record.snapshotToken;
      record.url = (typeof this._pageEntry.page?.url === 'function' && this._pageEntry.page.url() !== 'about:blank') ? this._pageEntry.page.url() : (this._pageEntry.currentUrl || record.url || 'about:blank');
      record.title = this._pageEntry.title || record.title || '';
    }

    return record;
  }

  /**
   * Validates that an expectedSnapshotToken matches the exact context (Section 22, 23).
   * Cross-context snapshot usage strictly blocked (TARGET_STALE or CONTEXT_MISMATCH).
   *
   * @param {string} token
   * @param {string} [contextId]
   * @returns {boolean}
   */
  isSnapshotValid(token, contextId) {
    if (!token || typeof token !== 'string' || token.trim().length === 0) return false;

    let targetCtx = null;
    try {
      targetCtx = this.resolveContext(contextId);
    } catch {
      return false;
    }

    if (!targetCtx || !targetCtx.snapshotToken) return false;
    if (targetCtx.snapshotToken !== token) return false;
    if (targetCtx.type === CONTEXT_TYPES.MAIN && this._pageEntry) {
      if (this._pageEntry.semanticRevision !== this._pageEntry.snapshotSemanticRevision) return false;
      if (this._pageEntry.spaRouteVersion !== this._pageEntry.snapshotRouteVersion) return false;
      return true;
    }
    if (targetCtx.semanticRevision !== targetCtx.snapshotSemanticRevision) return false;

    return true;
  }

  /**
   * Invalidates and generates a fresh snapshot token for a specific context.
   *
   * @param {string} [contextId]
   * @returns {string} freshSnapshotToken
   */
  invalidateSnapshot(contextId) {
    const ctx = this.resolveContext(contextId);
    ctx.snapshotVersion = (ctx.snapshotVersion || 1) + 1;
    ctx.snapshotSemanticRevision = ctx.semanticRevision;
    const now = Date.now();
    ctx.snapshotToken = generateSnapshotToken(ctx.snapshotVersion, `${this._pageId}_${ctx.contextId}_${ctx.semanticRevision}_${now.toString(36)}`);

    if (ctx.type === CONTEXT_TYPES.MAIN && this._pageEntry) {
      this._pageEntry.snapshotVersion = ctx.snapshotVersion;
      this._pageEntry.snapshotToken = ctx.snapshotToken;
      this._pageEntry.snapshotSemanticRevision = ctx.snapshotSemanticRevision;
    }

    return ctx.snapshotToken;
  }

  /**
   * Synchronizes dynamic mutation state for a specific context.
   *
   * @param {string} contextId
   * @returns {Promise<Object>}
   */
  async syncContext(contextId) {
    const ctx = this.resolveContext(contextId);
    if (!ctx || !ctx.attached) return ctx;

    if (ctx.type === CONTEXT_TYPES.MAIN) {
      return ctx;
    }

    if (ctx.type === CONTEXT_TYPES.FRAME) {
      if (ctx.frame && typeof ctx.frame.evaluate === 'function') {
        try {
          const inPage = await ctx.frame.evaluate(() => {
            const t = window.__JARVIS_DYNAMIC_TRACKER__;
            if (!t) return null;
            if (typeof t.ensureObserver === 'function') t.ensureObserver();
            return {
              semanticRevision: t.semanticRevision,
              lastRelevantMutationTime: t.lastRelevantMutationTime
            };
          });
          if (inPage) {
            if (inPage.semanticRevision > ctx.semanticRevision) {
              ctx.semanticRevision = inPage.semanticRevision;
              ctx.lastMutationTimestamp = inPage.lastRelevantMutationTime;
              this.invalidateSnapshot(ctx.contextId);
            } else if (inPage.lastRelevantMutationTime > (ctx.lastMutationTimestamp || 0)) {
              ctx.lastMutationTimestamp = inPage.lastRelevantMutationTime;
            }
          }
        } catch {}
      }
      return ctx;
    }

    if (ctx.type === CONTEXT_TYPES.SHADOW_ROOT) {
      if (ctx.frame && typeof ctx.frame.evaluate === 'function' && ctx.shadowHandleId) {
        try {
          const shadowState = await ctx.frame.evaluate((sId) => {
            const reg = window.__JARVIS_SHADOW_REGISTRY__?.get(sId);
            if (!reg || !reg.host || !reg.host.isConnected) {
              return { detached: true };
            }
            const revState = window.__JARVIS_SHADOW_REVISIONS__?.get(sId);
            return {
              detached: false,
              semanticRevision: revState?.semanticRevision || 1,
              lastRelevantMutationTime: revState?.lastRelevantMutationTime || Date.now()
            };
          }, ctx.shadowHandleId);

          if (shadowState?.detached) {
            ctx.attached = false;
            ctx.snapshotToken = null;
            throw new DomContextError(`Shadow root context "${contextId}" has detached.`, 'SHADOW_CONTEXT_DETACHED', { contextId, pageId: this._pageId });
          }

          if (shadowState) {
            if (shadowState.semanticRevision > ctx.semanticRevision) {
              ctx.semanticRevision = shadowState.semanticRevision;
              ctx.lastMutationTimestamp = shadowState.lastRelevantMutationTime;
              this.invalidateSnapshot(ctx.contextId);
            } else if (shadowState.lastRelevantMutationTime > (ctx.lastMutationTimestamp || 0)) {
              ctx.lastMutationTimestamp = shadowState.lastRelevantMutationTime;
            }
          }
        } catch (err) {
          if (err instanceof DomContextError) throw err;
        }
      }
      return ctx;
    }

    return ctx;
  }

  /**
   * Manually records a semantic mutation for a specific context.
   *
   * @param {string} contextId
   * @returns {number} new semanticRevision
   */
  touchMutation(contextId) {
    const ctx = this.resolveContext(contextId);
    ctx.semanticRevision = (ctx.semanticRevision || 1) + 1;
    ctx.lastMutationTimestamp = Date.now();
    this.invalidateSnapshot(ctx.contextId);
    return ctx.semanticRevision;
  }

  /**
   * Destroys and cleans up all context state for this page.
   */
  destroy() {
    this._detachFrameListeners();
    for (const ctx of this._contexts.values()) {
      ctx.attached = false;
      ctx.snapshotToken = null;
      ctx.frame = null;
    }
    this._contexts.clear();
    this._frameToContextId.clear();
    this._shadowHandleToContextId.clear();
  }
}
