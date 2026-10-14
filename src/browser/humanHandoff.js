/**
 * Human Handoff Subsystem for Authentication Barriers (Brick 36).
 * Handles safe pausing of automation, direct human Edge interaction, explicit continuation,
 * and deterministic evidence-based verification for login, MFA, CAPTCHA, and session barriers.
 *
 * Strict invariants:
 * - Deterministic state machine: IDLE, PAUSED_FOR_HUMAN, RESUMING, VERIFIED, NOT_CLEARED, EXPIRED, CANCELLED.
 * - Human interacts directly in the real isolated JARVIS Edge window.
 * - Zero autonomous credential handling: NO typing/reading/storing passwords, NO reading OTP/MFA secrets, NO CAPTCHA solving.
 * - Atomic binding to browser lifecycle, context, pageId, documentVersion, semanticRevision, snapshot, and loaded session.
 * - Action pause safety: Mutating JARVIS actions on the bound page are blocked with HUMAN_HANDOFF_ACTIVE while handoff is active.
 * - Explicit resume: Automation never resumes automatically; requires explicit human resume trigger.
 * - Fresh state inspection: After resume, re-inspects fresh state from DOM; never reuses old snapshot.
 * - Deterministic verification: Evaluates evidence (url-changed, url-equals, url-contains, target-present, target-absent, text-present, text-absent).
 * - Repeated explicit resume policy: Multiple explicit human resume attempts allowed before expiry; failure reports NOT_CLEARED without auto-retry loop.
 * - Single active handoff per page/browser context.
 * - Opaque IDs: handoff_<timestamp>_<randomHex> (no usernames, emails, or session secrets).
 * - Zero secrets or raw DOM/selectors in metadata or logs.
 * - Automatic screenshots suppressed during sensitive auth handoffs (LOGIN_REQUIRED, MFA_REQUIRED, CAPTCHA_REQUIRED).
 * - Zero AI / 0 LLM calls, 0 search calls.
 */

import crypto from 'node:crypto';
import { clearConfirmationTokens } from './formSubmitter.js';

export class HumanHandoffError extends Error {
  /**
   * @param {string} message
   * @param {string} [code='HANDOFF_ERROR']
   * @param {Object} [details={}]
   */
  constructor(message, code = 'HANDOFF_ERROR', details = {}) {
    super(message);
    this.name = 'HumanHandoffError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Controlled reason codes for human handoff v1.
 */
export const HANDOFF_REASONS = Object.freeze({
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  USER_INTERACTION_REQUIRED: 'USER_INTERACTION_REQUIRED',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  SESSION_EXPIRED: 'SESSION_EXPIRED'
});

/**
 * Deterministic states for human handoff v1.
 */
export const HANDOFF_STATES = Object.freeze({
  IDLE: 'IDLE',
  PAUSED_FOR_HUMAN: 'PAUSED_FOR_HUMAN',
  RESUMING: 'RESUMING',
  VERIFIED: 'VERIFIED',
  NOT_CLEARED: 'NOT_CLEARED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

/**
 * Reasons considered sensitive where automatic screenshots and continuous DOM observation must be suppressed.
 */
export const SENSITIVE_REASONS = new Set([
  HANDOFF_REASONS.LOGIN_REQUIRED,
  HANDOFF_REASONS.MFA_REQUIRED,
  HANDOFF_REASONS.CAPTCHA_REQUIRED,
  HANDOFF_REASONS.SESSION_EXPIRED
]);

/**
 * Standard user guidance texts per reason code.
 */
export const DEFAULT_GUIDANCE = Object.freeze({
  LOGIN_REQUIRED: 'Authentication is required. Complete sign-in in the Edge window, then click Resume.',
  MFA_REQUIRED: 'Multi-factor authentication is required. Complete verification in the Edge window, then click Resume.',
  CAPTCHA_REQUIRED: 'Security verification required. Complete the challenge in the Edge window, then click Resume.',
  SESSION_EXPIRED: 'Your session has expired. Sign in again in the Edge window, then click Resume.',
  CONSENT_REQUIRED: 'User consent is required. Review and accept in the Edge window, then click Resume.',
  USER_INTERACTION_REQUIRED: 'Human interaction is required in the Edge window. Complete the action, then click Resume.'
});

let handoffCounter = 0;

/**
 * Generates an opaque cryptographically random handoff identifier.
 * Example: handoff_<timestamp>_<hex>
 * @returns {string}
 */
export function generateHandoffId() {
  const rnd = crypto.randomBytes(8).toString('hex');
  return `handoff_${Date.now()}_${rnd}`;
}

/**
 * Validates whether a string matches the opaque handoff ID format.
 * @param {string} id
 * @returns {boolean}
 */
export function isValidHandoffId(id) {
  return typeof id === 'string' && /^handoff_\d+_[a-f0-9]{16}$/.test(id);
}

/**
 * Clamps TTL in milliseconds to [1000, 1800000] with default 300,000 ms (5 minutes).
 * @param {number|string|undefined} ttlMs
 * @returns {number}
 */
export function clampHandoffTtl(ttlMs) {
  if (ttlMs === undefined || ttlMs === null || ttlMs === '') return 300000;
  const num = Number(ttlMs);
  if (Number.isNaN(num)) return 300000;
  return Math.min(Math.max(num, 1000), 1800000);
}

/**
 * Converts internal handoff record to safe public metadata without secrets, HTML, or selectors.
 * @param {Object} handoff
 * @returns {Object|null}
 */
export function toSafeHandoffMetadata(handoff) {
  if (!handoff) return null;
  const now = Date.now();
  const expiresAtMs = typeof handoff.expiresAtMs === 'number' ? handoff.expiresAtMs : new Date(handoff.expiresAt).getTime();
  const createdAtMs = typeof handoff.createdAtMs === 'number' ? handoff.createdAtMs : new Date(handoff.createdAt).getTime();
  const elapsedMs = Math.max(0, now - createdAtMs);
  const remainingMs = Math.max(0, expiresAtMs - now);

  return {
    handoffId: handoff.handoffId,
    reason: handoff.reason,
    pageId: handoff.pageId,
    status: handoff.status,
    guidance: handoff.guidance,
    createdAt: handoff.createdAt,
    expiresAt: handoff.expiresAt,
    elapsedMs,
    remainingMs,
    durationMs: handoff.verifiedAtMs ? Math.max(0, handoff.verifiedAtMs - createdAtMs) : elapsedMs,
    verified: handoff.status === HANDOFF_STATES.VERIFIED,
    verificationType: handoff.verification?.type || 'default',
    resumeAttempts: handoff.resumeAttempts || 0
  };
}

/**
 * Evaluates a deterministic verification condition against fresh page state.
 *
 * @param {Object} pageEntry - Concrete page entry in BrowserManager
 * @param {Object} browserManager - BrowserManager instance
 * @param {Object} verification - Verification condition object
 * @param {Object} baseline - Starting baseline state
 * @returns {Promise<boolean>}
 */
export async function evaluateVerificationCondition(pageEntry, browserManager, verification, baseline = {}) {
  if (!verification || typeof verification !== 'object') {
    // Default condition: URL progressed away from start URL
    const currentUrl = typeof pageEntry.page.url === 'function' ? pageEntry.page.url() : pageEntry.currentUrl;
    return Boolean(currentUrl && currentUrl !== baseline.startUrl);
  }

  const currentUrl = typeof pageEntry.page.url === 'function' ? pageEntry.page.url() : pageEntry.currentUrl;
  const type = verification.type;

  if (type === 'all' && Array.isArray(verification.conditions)) {
    for (const cond of verification.conditions) {
      const ok = await evaluateVerificationCondition(pageEntry, browserManager, cond, baseline);
      if (!ok) return false;
    }
    return true;
  }

  if (type === 'any' && Array.isArray(verification.conditions)) {
    for (const cond of verification.conditions) {
      const ok = await evaluateVerificationCondition(pageEntry, browserManager, cond, baseline);
      if (ok) return true;
    }
    return false;
  }

  if (type === 'url-changed') {
    return currentUrl !== baseline.startUrl;
  }

  if (type === 'url-equals') {
    const expected = verification.targetUrl || verification.expectedUrl || verification.url || verification.value || '';
    return currentUrl === expected;
  }

  if (type === 'url-contains') {
    const expected = verification.targetUrl || verification.expectedUrl || verification.value || verification.url || '';
    return Boolean(expected && currentUrl.includes(expected));
  }

  if (type === 'text-present') {
    const query = verification.text || verification.value || '';
    if (!query) return false;
    if (pageEntry.page && typeof pageEntry.page.evaluate === 'function') {
      const found = await pageEntry.page.evaluate(q => {
        const doc = typeof document !== 'undefined' ? document : null;
        if (!doc || !doc.body) return null;
        const text = doc.body.innerText || doc.body.textContent || '';
        return text.includes(q);
      }, query).catch(() => null);
      if (typeof found === 'boolean') return found;
    }
    if (browserManager && typeof browserManager.inspectPage === 'function') {
      const inspectRes = await browserManager.inspectPage({ pageId: pageEntry.pageId }).catch(() => null);
      const visibleText = inspectRes?.visibleText || '';
      return visibleText.includes(query);
    }
    return false;
  }

  if (type === 'text-absent') {
    const query = verification.text || verification.value || '';
    if (!query) return true;
    if (pageEntry.page && typeof pageEntry.page.evaluate === 'function') {
      const found = await pageEntry.page.evaluate(q => {
        const doc = typeof document !== 'undefined' ? document : null;
        if (!doc || !doc.body) return null;
        const text = doc.body.innerText || doc.body.textContent || '';
        return !text.includes(q);
      }, query).catch(() => null);
      if (typeof found === 'boolean') return found;
    }
    if (browserManager && typeof browserManager.inspectPage === 'function') {
      const inspectRes = await browserManager.inspectPage({ pageId: pageEntry.pageId }).catch(() => null);
      const visibleText = inspectRes?.visibleText || '';
      return !visibleText.includes(query);
    }
    return true;
  }

  if (type === 'target-present') {
    const target = verification.target || (verification.targetText ? { kind: 'button', text: verification.targetText } : null);
    if (!target) return false;
    try {
      if (browserManager && typeof browserManager.resolveTarget === 'function') {
        const res = await browserManager.resolveTarget(target, { pageId: pageEntry.pageId });
        return Boolean(res && res.resolution === 'unique' && res.confidence === 'high');
      }
      if (browserManager && typeof browserManager.inspectPage === 'function') {
        const inspectRes = await browserManager.inspectPage({ pageId: pageEntry.pageId }).catch(() => null);
        const elems = inspectRes?.elements || [];
        return elems.some(el => {
          if (target.id && el.id === target.id) return true;
          if (target.text && (el.text || '').includes(target.text)) return true;
          return false;
        });
      }
      return false;
    } catch {
      return false;
    }
  }

  if (type === 'target-absent') {
    const target = verification.target || (verification.targetText ? { kind: 'button', text: verification.targetText } : null);
    if (!target) return true;
    try {
      if (browserManager && typeof browserManager.resolveTarget === 'function') {
        const res = await browserManager.resolveTarget(target, { pageId: pageEntry.pageId });
        return !res || res.resolution === 'not_found';
      }
      if (browserManager && typeof browserManager.inspectPage === 'function') {
        const inspectRes = await browserManager.inspectPage({ pageId: pageEntry.pageId }).catch(() => null);
        const elems = inspectRes?.elements || [];
        return !elems.some(el => {
          if (target.id && el.id === target.id) return true;
          if (target.text && (el.text || '').includes(target.text)) return true;
          return false;
        });
      }
      return true;
    } catch {
      return true;
    }
  }

  if (type === 'document-navigation') {
    const currentDocVersion = pageEntry.documentVersion ?? 1;
    return currentDocVersion > (baseline.startDocVersion ?? 1);
  }

  if (type === 'spa-route-changed') {
    const currentSpaVersion = pageEntry.spaRouteVersion ?? 0;
    return currentSpaVersion > (baseline.startSpaVersion ?? 0) || (currentUrl !== baseline.startUrl && pageEntry.spaRouteChanged);
  }

  // Fallback default
  return currentUrl !== baseline.startUrl;
}

/**
 * Human Handoff Subsystem Manager.
 */
export class HumanHandoffManager {
  /**
   * @param {Object} [options]
   * @param {Object} [options.browserManager]
   * @param {number} [options.defaultTtlMs]
   */
  constructor(options = {}) {
    this._browserManager = options.browserManager || null;
    this._defaultTtlMs = clampHandoffTtl(options.defaultTtlMs ?? 300000);
    /** @type {Map<string, Object>} */
    this._handoffs = new Map();
  }

  setBrowserManager(bm) {
    this._browserManager = bm;
  }

  /**
   * Checks if an active handoff is currently running on the given page.
   * Active states: PAUSED_FOR_HUMAN, RESUMING, NOT_CLEARED.
   *
   * @param {string} [pageId]
   * @returns {boolean}
   */
  isHandoffActive(pageId) {
    this._purgeExpired();
    for (const handoff of this._handoffs.values()) {
      if (handoff.status === HANDOFF_STATES.PAUSED_FOR_HUMAN ||
          handoff.status === HANDOFF_STATES.RESUMING ||
          handoff.status === HANDOFF_STATES.NOT_CLEARED) {
        if (!pageId || handoff.pageId === pageId) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Checks if an active handoff is in an authentication-sensitive reason code.
   *
   * @param {string} [pageId]
   * @returns {boolean}
   */
  isSensitiveHandoffActive(pageId) {
    this._purgeExpired();
    for (const handoff of this._handoffs.values()) {
      if (handoff.status === HANDOFF_STATES.PAUSED_FOR_HUMAN ||
          handoff.status === HANDOFF_STATES.RESUMING ||
          handoff.status === HANDOFF_STATES.NOT_CLEARED) {
        if ((!pageId || handoff.pageId === pageId) && SENSITIVE_REASONS.has(handoff.reason)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Evaluates screenshot policy for diagnostic captures.
   *
   * @param {string} [pageId]
   * @param {Object} [options={}]
   * @returns {{ allowed: boolean, reason?: string, message?: string }}
   */
  canCaptureScreenshot(pageId, options = {}) {
    if (options.explicitUserRequest === true) {
      return { allowed: true };
    }
    if (this.isSensitiveHandoffActive(pageId)) {
      return {
        allowed: false,
        reason: 'SCREENSHOT_SUPPRESSED_DURING_AUTH',
        message: 'Automatic screenshot capture is suppressed during sensitive human authentication.'
      };
    }
    return { allowed: true };
  }

  /**
   * Retrieves active handoff for page.
   *
   * @param {string} [pageId]
   * @returns {Object|null}
   */
  getActiveHandoff(pageId) {
    this._purgeExpired();
    for (const handoff of this._handoffs.values()) {
      if (handoff.status === HANDOFF_STATES.PAUSED_FOR_HUMAN ||
          handoff.status === HANDOFF_STATES.RESUMING ||
          handoff.status === HANDOFF_STATES.NOT_CLEARED) {
        if (!pageId || handoff.pageId === pageId) {
          return toSafeHandoffMetadata(handoff);
        }
      }
    }
    return null;
  }

  /**
   * Retrieves a handoff by ID.
   *
   * @param {string} handoffId
   * @returns {Object|null}
   */
  getHandoff(handoffId) {
    this._purgeExpired();
    const handoff = this._handoffs.get(handoffId);
    return handoff ? toSafeHandoffMetadata(handoff) : null;
  }

  /**
   * Initiates a deterministic human handoff boundary for authentication.
   *
   * @param {Object} request
   * @param {string} request.reason - One of HANDOFF_REASONS
   * @param {string} [request.pageId] - Target page ID (defaults to activePageId)
   * @param {string} [request.expectedSnapshotToken] - Optional snapshot verification
   * @param {Object} [request.verification] - Deterministic verification condition to evaluate on resume
   * @param {number} [request.ttlMs] - Handoff TTL in ms
   * @param {string} [request.guidance] - Custom safe guidance string
   * @param {Object} [options={}]
   * @returns {Promise<Object>}
   */
  async startHandoff(request = {}, options = {}) {
    if (!this._browserManager || !this._browserManager.isBrowserConnected()) {
      throw new HumanHandoffError('Browser is not running. Please launch the browser first.', 'BROWSER_NOT_RUNNING');
    }

    const reason = request.reason;
    if (!reason || !HANDOFF_REASONS[reason]) {
      throw new HumanHandoffError(
        `Invalid handoff reason "${reason}". Supported reasons: ${Object.values(HANDOFF_REASONS).join(', ')}.`,
        'INVALID_HANDOFF_REASON'
      );
    }

    const targetPageId = request.pageId || options.pageId || this._browserManager.activePageId;
    const entry = this._browserManager.getPageEntry(targetPageId);
    if (!entry || !entry.page || (typeof entry.page.isClosed === 'function' && entry.page.isClosed())) {
      throw new HumanHandoffError(`Page "${targetPageId}" not found or closed.`, 'PAGE_NOT_FOUND');
    }

    // Check if expectedSnapshotToken is provided and validate
    if (request.expectedSnapshotToken && entry.snapshotToken && request.expectedSnapshotToken !== entry.snapshotToken) {
      throw new HumanHandoffError(
        'Expected snapshot token does not match current page snapshot.',
        'TARGET_STALE'
      );
    }

    // Single active handoff policy: only one active handoff per browser / context / page
    if (this.isHandoffActive(targetPageId)) {
      throw new HumanHandoffError(
        'A human authentication handoff is already active on this page/context.',
        'HANDOFF_ALREADY_ACTIVE'
      );
    }

    const handoffId = generateHandoffId();
    const ttlMs = clampHandoffTtl(request.ttlMs ?? options.ttlMs ?? this._defaultTtlMs);
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAtMs = now + ttlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();

    const guidance = (typeof request.guidance === 'string' && request.guidance.trim())
      ? request.guidance.trim()
      : (DEFAULT_GUIDANCE[reason] || DEFAULT_GUIDANCE.LOGIN_REQUIRED);

    // Invalidate pre-existing form confirmation tokens on this page (Section 29)
    try {
      clearConfirmationTokens(targetPageId);
    } catch {}

    const handoffRecord = {
      handoffId,
      reason,
      pageId: targetPageId,
      status: HANDOFF_STATES.PAUSED_FOR_HUMAN,
      guidance,
      createdAt,
      createdAtMs: now,
      expiresAt,
      expiresAtMs,
      ttlMs,
      startUrl: entry.currentUrl || (typeof entry.page.url === 'function' ? entry.page.url() : ''),
      documentVersion: entry.documentVersion ?? 1,
      semanticRevision: entry.semanticRevision ?? 0,
      spaRouteVersion: entry.spaRouteVersion ?? 0,
      snapshotToken: entry.snapshotToken || null,
      loadedSessionId: this._browserManager.loadedSessionId || null,
      contextRef: this._browserManager.context,
      verification: request.verification || null,
      resumeAttempts: 0,
      verifiedAt: null,
      verifiedAtMs: null
    };

    this._handoffs.set(handoffId, handoffRecord);

    const safe = toSafeHandoffMetadata(handoffRecord);
    return {
      success: true,
      ...safe,
      handoff: safe
    };
  }

  /**
   * Resumes a paused handoff after human completes interaction in Edge.
   *
   * @param {Object} resumeRequest
   * @param {string} resumeRequest.handoffId
   * @param {Object} [options={}]
   * @returns {Promise<Object>}
   */
  async resumeHandoff(resumeRequest = {}, options = {}) {
    const handoffId = resumeRequest.handoffId;
    if (!handoffId || typeof handoffId !== 'string') {
      throw new HumanHandoffError('Missing required handoffId parameter.', 'INVALID_REQUEST');
    }

    this._purgeExpired();

    const handoff = this._handoffs.get(handoffId);
    if (!handoff) {
      throw new HumanHandoffError(`Human handoff "${handoffId}" not found.`, 'HANDOFF_NOT_FOUND');
    }

    // Context / session profile change check (Section 28)
    if (handoff.contextClosed) {
      throw new HumanHandoffError('Browser context closed during handoff.', 'HANDOFF_CONTEXT_CHANGED');
    }

    // Page closed check (Section 24)
    if (handoff.pageClosed) {
      if (this._browserManager && this._browserManager.pageCount > 0) {
        throw new HumanHandoffError(
          'Bound page was closed. Authentication may have opened a separate tab/window; manual continuation required.',
          'HANDOFF_NEW_PAGE_REQUIRES_USER'
        );
      }
      throw new HumanHandoffError('Bound page has been closed.', 'PAGE_CLOSED');
    }

    // One-time completion check (Section 23)
    if (handoff.status === HANDOFF_STATES.VERIFIED || handoff.status === HANDOFF_STATES.CANCELLED) {
      throw new HumanHandoffError('Human handoff has already been completed or cancelled.', 'HANDOFF_ALREADY_COMPLETED');
    }

    // TTL expiry check (Section 9)
    if (Date.now() > handoff.expiresAtMs) {
      handoff.status = HANDOFF_STATES.EXPIRED;
      throw new HumanHandoffError('Human handoff has expired.', 'HANDOFF_EXPIRED');
    }

    // Context / session profile change check (Section 28)
    if (this._browserManager) {
      const currentContext = this._browserManager.context;
      const currentSessionId = this._browserManager.loadedSessionId || null;
      if (handoff.contextRef && currentContext && handoff.contextRef !== currentContext) {
        handoff.status = HANDOFF_STATES.CANCELLED;
        throw new HumanHandoffError('Browser context changed during handoff.', 'HANDOFF_CONTEXT_CHANGED');
      }
      if (handoff.loadedSessionId !== currentSessionId) {
        handoff.status = HANDOFF_STATES.CANCELLED;
        throw new HumanHandoffError('Browser session profile changed during handoff.', 'HANDOFF_CONTEXT_CHANGED');
      }
    }

    // Bound page check (Section 24, 25, 27)
    const entry = this._browserManager ? this._browserManager.getPageEntry(handoff.pageId) : null;
    if (!entry || !entry.page || (typeof entry.page.isClosed === 'function' && entry.page.isClosed())) {
      handoff.status = HANDOFF_STATES.CANCELLED;
      // Section 27: New page auth flows
      if (this._browserManager && this._browserManager.pageCount > 0) {
        throw new HumanHandoffError(
          'Bound page was closed. Authentication may have opened a separate tab/window; manual continuation required.',
          'HANDOFF_NEW_PAGE_REQUIRES_USER'
        );
      }
      throw new HumanHandoffError('Bound page has been closed.', 'PAGE_CLOSED');
    }

    handoff.status = HANDOFF_STATES.RESUMING;
    handoff.resumeAttempts++;

    // Section 15: Re-inspect the bound page from fresh state. Do not reuse the old snapshot.
    // Invalidate pre-auth form confirmation tokens on page (Section 29)
    try {
      clearConfirmationTokens(handoff.pageId);
    } catch {}

    await this._browserManager.syncDynamicState(handoff.pageId).catch(() => {});
    const freshInspection = await this._browserManager.inspectPage({ pageId: handoff.pageId });

    // Section 16: Evaluate verification condition
    const verified = await evaluateVerificationCondition(
      entry,
      this._browserManager,
      handoff.verification,
      {
        startUrl: handoff.startUrl,
        startDocVersion: handoff.documentVersion,
        startSemanticRev: handoff.semanticRevision,
        startSpaVersion: handoff.spaRouteVersion
      }
    );

    if (verified) {
      handoff.status = HANDOFF_STATES.VERIFIED;
      handoff.verifiedAt = new Date().toISOString();
      handoff.verifiedAtMs = Date.now();

      return {
        success: true,
        verified: true,
        status: HANDOFF_STATES.VERIFIED,
        handoff: toSafeHandoffMetadata(handoff),
        page: {
          pageId: handoff.pageId,
          url: entry.currentUrl || (typeof entry.page.url === 'function' ? entry.page.url() : ''),
          title: entry.title || (typeof entry.page.title === 'function' ? await entry.page.title().catch(() => '') : ''),
          snapshotToken: freshInspection.snapshotToken,
          documentVersion: entry.documentVersion,
          semanticRevision: entry.semanticRevision
        }
      };
    } else {
      // Section 36 & 37: Repeated explicit resume policy without automatic polling loop
      handoff.status = HANDOFF_STATES.NOT_CLEARED;
      return {
        success: false,
        verified: false,
        status: HANDOFF_STATES.NOT_CLEARED,
        code: 'HANDOFF_NOT_CLEARED',
        error: 'HANDOFF_NOT_CLEARED',
        message: 'Authentication barrier was not cleared. Complete the required action in the Edge window and click Resume again.',
        handoff: toSafeHandoffMetadata(handoff),
        page: {
          pageId: handoff.pageId,
          url: entry.currentUrl || (typeof entry.page.url === 'function' ? entry.page.url() : ''),
          title: entry.title || (typeof entry.page.title === 'function' ? await entry.page.title().catch(() => '') : ''),
          snapshotToken: freshInspection.snapshotToken,
          documentVersion: entry.documentVersion,
          semanticRevision: entry.semanticRevision
        }
      };
    }
  }

  /**
   * Retrieves overall handoff status for the specified page or current active page.
   *
   * @param {string} [pageId]
   * @returns {{ active: boolean, status: string, state: string, handoff: Object|null }}
   */
  getStatus(pageId = null) {
    this._purgeExpired();
    const active = this.getActiveHandoff(pageId);
    if (!active) {
      return {
        active: false,
        status: HANDOFF_STATES.IDLE,
        state: HANDOFF_STATES.IDLE,
        handoff: null
      };
    }
    return {
      active: true,
      status: active.status,
      state: active.status,
      handoff: active
    };
  }

  /**
   * Explicitly cancels an active handoff.
   *
   * @param {string|Object} cancelRequest - handoffId or object containing handoffId
   * @returns {Promise<Object>}
   */
  async cancelHandoff(cancelRequest = {}) {
    const handoffId = typeof cancelRequest === 'string' ? cancelRequest : cancelRequest.handoffId;
    if (!handoffId || typeof handoffId !== 'string') {
      throw new HumanHandoffError('Missing required handoffId parameter.', 'INVALID_REQUEST');
    }

    const handoff = this._handoffs.get(handoffId);
    if (!handoff) {
      throw new HumanHandoffError(`Human handoff "${handoffId}" not found.`, 'HANDOFF_NOT_FOUND');
    }

    if (handoff.status === HANDOFF_STATES.VERIFIED || handoff.status === HANDOFF_STATES.CANCELLED) {
      throw new HumanHandoffError('Human handoff has already been completed or cancelled.', 'HANDOFF_ALREADY_COMPLETED');
    }

    handoff.status = HANDOFF_STATES.CANCELLED;

    return {
      success: true,
      status: HANDOFF_STATES.CANCELLED,
      handoff: toSafeHandoffMetadata(handoff)
    };
  }

  /**
   * Cleans up handoff state when a page closes.
   *
   * @param {string} pageId
   */
  onPageClosed(pageId) {
    for (const handoff of this._handoffs.values()) {
      if (handoff.pageId === pageId && (
        handoff.status === HANDOFF_STATES.PAUSED_FOR_HUMAN ||
        handoff.status === HANDOFF_STATES.RESUMING ||
        handoff.status === HANDOFF_STATES.NOT_CLEARED
      )) {
        handoff.status = HANDOFF_STATES.CANCELLED;
        handoff.pageClosed = true;
      }
    }
  }

  /**
   * Cleans up all handoffs when context closes or replaces.
   */
  onContextClosed() {
    for (const handoff of this._handoffs.values()) {
      if (handoff.status === HANDOFF_STATES.PAUSED_FOR_HUMAN ||
          handoff.status === HANDOFF_STATES.RESUMING ||
          handoff.status === HANDOFF_STATES.NOT_CLEARED) {
        handoff.status = HANDOFF_STATES.CANCELLED;
        handoff.contextClosed = true;
      }
    }
  }

  /**
   * Clears internal state (for test isolation).
   */
  clear() {
    this._handoffs.clear();
  }

  _purgeExpired() {
    const now = Date.now();
    for (const handoff of this._handoffs.values()) {
      if ((handoff.status === HANDOFF_STATES.PAUSED_FOR_HUMAN ||
           handoff.status === HANDOFF_STATES.NOT_CLEARED) &&
          now > handoff.expiresAtMs) {
        handoff.status = HANDOFF_STATES.EXPIRED;
      }
    }
  }
}
