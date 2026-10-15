/**
 * Action Executor for JARVIS4 (Brick 30).
 * Safely executes exactly ONE bounded action on ONE semantically resolved target.
 *
 * Strict invariants:
 * - One action per request only.
 * - Snapshot token required; stale token rejected (TARGET_STALE).
 * - TargetId alone never authorizes action; requires current semantic resolution.
 * - Immediate semantic re-resolution on current page before execution.
 * - Strict confidence: high confidence required (TARGET_CONFIDENCE_TOO_LOW).
 * - Short-lived ElementHandle: created, validated, acted, discarded immediately in finally.
 * - Input privacy: values, passwords, textareas, file paths, hidden tokens are never exposed.
 * - Password fill blocked (PASSWORD_INTERACTION_NOT_AUTHORIZED).
 * - File input fill blocked (FILE_INTERACTION_NOT_AUTHORIZED).
 * - Form submission blocked (FORM_SUBMISSION_NOT_AUTHORIZED).
 * - Form reset blocked (FORM_RESET_NOT_AUTHORIZED).
 * - Downloads blocked (DOWNLOAD_NOT_AUTHORIZED).
 * - Popups/new tabs blocked (POPUP_NOT_SUPPORTED).
 * - Click-induced navigation preserves GREEN-027 SSRF, private network, and HTTPS downgrade safety.
 * - Zero AI / Zero LLM / Zero Search calls.
 * - Error sanitization: Playwright internals and local paths never exposed.
 */

import { config } from '../config/index.js';
import { validateUrlSafety } from '../webpage/urlSafety.js';
import { createSafeElementSummary } from './targetResolver.js';

export class ActionExecutionError extends Error {
  /**
   * @param {string} message
   * @param {string} [code='ACTION_EXECUTION_FAILED']
   * @param {Object} [details={}]
   */
  constructor(message, code = 'ACTION_EXECUTION_FAILED', details = {}) {
    super(message);
    this.name = 'ActionExecutionError';
    this.code = code;
    this.details = details;
  }
}

export const SUPPORTED_ACTIONS = Object.freeze([
  'click',
  'fill',
  'check',
  'uncheck',
  'select'
]);

/**
 * Event-aware popup settlement helper (Brick 31 Live Fix C).
 * Keeps action popup observation alive for a bounded grace period post-click
 * so real asynchronous Playwright / Edge popup/Page events can be captured
 * and attributed to the action that caused them.
 *
 * @param {Object} params
 * @param {Object} params.actionWindow - Action popup observation window
 * @param {number} [params.timeoutMs=500] - Bounded settlement timeout in ms
 * @param {Function} [params.sleeper] - Optional sleeper function (ms => Promise) for deterministic tests
 * @param {Promise} [params.settleSignal] - Optional settle signal promise for deterministic tests
 * @param {Array|Object} [params.diagnostics] - Optional diagnostic collection object
 * @returns {Promise<{ settled: boolean, eventCount: number, elapsedMs: number }>}
 */
export async function settleActionPopups({
  actionWindow,
  timeoutMs = 500,
  sleeper = null,
  settleSignal = null,
  diagnostics = null
} = {}) {
  const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  const boundedTimeoutMs = Math.max(0, Number(timeoutMs) || 0);

  if (diagnostics && Array.isArray(diagnostics)) {
    diagnostics.push({ stage: 'popupWindowStarted', timeoutMs: boundedTimeoutMs, timestamp: Date.now() });
  }

  if (!actionWindow || boundedTimeoutMs === 0) {
    if (diagnostics && Array.isArray(diagnostics)) {
      diagnostics.push({ stage: 'popupSettlementCompleted', elapsedMs: 0, eventCount: actionWindow?.capturedPopups?.length || 0 });
    }
    return {
      settled: true,
      eventCount: actionWindow?.capturedPopups?.length || 0,
      elapsedMs: 0
    };
  }

  return new Promise((resolve) => {
    let timerId = null;
    let settled = false;

    const cleanup = () => {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (actionWindow?._settleResolvers) {
        actionWindow._settleResolvers.delete(onSettled);
      }
      if (typeof actionWindow?.offPopup === 'function') {
        actionWindow.offPopup(onPopupNotification);
      }
    };

    const onSettled = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
      const elapsedMs = Math.max(0, endTime - startTime);
      if (diagnostics && Array.isArray(diagnostics)) {
        diagnostics.push({
          stage: 'popupSettlementCompleted',
          reason: 'signal',
          elapsedMs,
          eventCount: actionWindow?.capturedPopups?.length || 0
        });
      }
      resolve({
        settled: true,
        eventCount: actionWindow?.capturedPopups?.length || 0,
        elapsedMs
      });
    };

    const onPopupNotification = (popup) => {
      if (diagnostics && Array.isArray(diagnostics)) {
        diagnostics.push({
          stage: 'popupEventCaptured',
          timestamp: Date.now(),
          eventCount: actionWindow?.capturedPopups?.length || 0
        });
      }
    };

    if (typeof actionWindow?.onPopup === 'function') {
      actionWindow.onPopup(onPopupNotification);
    }
    if (actionWindow?._settleResolvers) {
      actionWindow._settleResolvers.add(onSettled);
    }

    if (settleSignal && typeof settleSignal.then === 'function') {
      settleSignal.then(onSettled, onSettled);
    }

    if (typeof sleeper === 'function') {
      sleeper(boundedTimeoutMs).then(onSettled, onSettled);
    } else {
      timerId = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();
        const elapsedMs = Math.max(0, endTime - startTime);
        if (diagnostics && Array.isArray(diagnostics)) {
          diagnostics.push({
            stage: 'popupSettlementCompleted',
            reason: 'timeout',
            elapsedMs,
            eventCount: actionWindow?.capturedPopups?.length || 0
          });
        }
        resolve({
          settled: true,
          eventCount: actionWindow?.capturedPopups?.length || 0,
          elapsedMs
        });
      }, boundedTimeoutMs);
    }
  });
}

/**
 * Self-contained DOM lookup function serialized into browser via page.evaluateHandle.
 * Uses identical candidate collection and visibility logic as extractDomSnapshot.
 *
 * @param {Object} args
 * @param {number} args.targetIndex
 * @param {string} [args.expectedKind]
 * @param {string} [args.expectedTag]
 * @returns {Element|null}
 */
export function findTargetDomElement(args) {
  const targetIndex = args && typeof args.targetIndex === 'number' ? args.targetIndex : -1;
  const expectedKind = args && args.expectedKind ? args.expectedKind.toLowerCase() : null;
  const expectedTag = args && args.expectedTag ? args.expectedTag.toLowerCase() : null;

  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || targetIndex < 0) return null;

  let rootContainer = doc;
  if (args && args.shadowHandleId) {
    const reg = (typeof window !== 'undefined' && window.__JARVIS_SHADOW_REGISTRY__) ? window.__JARVIS_SHADOW_REGISTRY__.get(args.shadowHandleId) : null;
    if (!reg || !reg.shadowRoot || (reg.host && !reg.host.isConnected)) return null;
    rootContainer = reg.shadowRoot;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const style = (typeof window !== 'undefined' && window.getComputedStyle) ? window.getComputedStyle(el) : null;
    if (style) {
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (parseFloat(style.opacity || '1') === 0) return false;
    }
    if (el.hasAttribute && el.hasAttribute('hidden')) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  let candidates = [];
  if (typeof rootContainer.querySelectorAll === 'function') {
    candidates = Array.from(rootContainer.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, a, button, input, textarea, select, form, [role="heading"], [role="link"], [role="button"]'
    ));
  }

  let eligibleIndex = 0;
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (!isVisible(el)) continue;

    const tag = (el.tagName || '').toLowerCase();
    const roleAttr = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();

    let kind = null;
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag) || roleAttr === 'heading') {
      kind = 'heading';
    } else if (tag === 'a' || roleAttr === 'link') {
      kind = 'link';
    } else if (tag === 'button' || roleAttr === 'button') {
      kind = 'button';
    } else if (tag === 'input') {
      kind = 'input';
    } else if (tag === 'textarea') {
      kind = 'textarea';
    } else if (tag === 'select') {
      kind = 'select';
    } else if (tag === 'form') {
      kind = 'form';
    }

    if (!kind) continue;

    if (eligibleIndex === targetIndex) {
      if (expectedKind && kind !== expectedKind) return null;
      if (expectedTag && tag !== expectedTag) return null;
      return el;
    }
    eligibleIndex++;
  }

  return null;
}

/**
 * Safely executes ONE bounded semantic action on the managed page.
 *
 * @param {Object} page - Playwright page or mock page
 * @param {Object} browserManager - JARVIS BrowserManager instance
 * @param {Object} actionRequest - Caller request payload
 * @param {Object} [options={}] - Execution options
 * @returns {Promise<Object>}
 */
export async function executeSemanticAction(page, browserManager, actionRequest, options = {}) {
  // 1. Structure validation
  if (!actionRequest || typeof actionRequest !== 'object') {
    throw new ActionExecutionError('Action request must be an object.', 'INVALID_REQUEST');
  }

  if (Array.isArray(actionRequest) || Array.isArray(actionRequest.actions) || actionRequest.actions) {
    throw new ActionExecutionError(
      'Multiple actions are not supported. Exactly one action per request.',
      'MULTI_ACTION_NOT_SUPPORTED'
    );
  }

  // Action name validation
  if (typeof actionRequest.action !== 'string') {
    throw new ActionExecutionError('Action must be a non-empty string.', 'INVALID_ACTION');
  }
  const action = actionRequest.action.trim().toLowerCase();
  if (!SUPPORTED_ACTIONS.includes(action)) {
    throw new ActionExecutionError(`Unsupported action: "${actionRequest.action}".`, 'INVALID_ACTION');
  }

  // Popup policy validation (Brick 31)
  const rawPopupPolicy = actionRequest.popupPolicy ?? 'block';
  if (typeof rawPopupPolicy !== 'string') {
    throw new ActionExecutionError('Invalid popup policy. Allowed values: "block", "allow-single".', 'INVALID_POPUP_POLICY');
  }
  const popupPolicy = rawPopupPolicy.trim().toLowerCase();
  if (!['block', 'allow-single'].includes(popupPolicy)) {
    throw new ActionExecutionError('Invalid popup policy. Allowed values: "block", "allow-single".', 'INVALID_POPUP_POLICY');
  }

  // Snapshot token validation (Section 8)
  const expectedSnapshotToken = actionRequest.expectedSnapshotToken;
  if (!expectedSnapshotToken || typeof expectedSnapshotToken !== 'string' || expectedSnapshotToken.trim().length === 0) {
    throw new ActionExecutionError('Expected snapshot token is required.', 'MISSING_SNAPSHOT_TOKEN');
  }

  const activePageId = options.pageId || actionRequest.pageId || browserManager.activePageId;
  const pageEntry = browserManager._pages ? browserManager._pages.get(activePageId) : null;
  const preSemanticRevision = pageEntry ? pageEntry.semanticRevision : 1;

  const contextId = options.contextId || actionRequest.contextId || null;
  if (!browserManager.isSnapshotTokenValid(expectedSnapshotToken, activePageId, contextId)) {
    throw new ActionExecutionError('Snapshot token is stale or invalid.', 'TARGET_STALE');
  }

  // Target query validation (Sections 6 & 7)
  const target = actionRequest.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new ActionExecutionError('Target query must be an object.', 'INVALID_TARGET_QUERY');
  }

  if (target.selector || target.css || target.xpath || target.locator || target.js) {
    throw new ActionExecutionError(
      'CSS selectors, XPath, and locator expressions are not accepted.',
      'INVALID_TARGET_QUERY'
    );
  }

  // Prohibit authorizing purely with targetId
  const onlyTargetId = Boolean(
    target.targetId &&
    !target.kind &&
    !target.name &&
    !target.accessibleName &&
    !target.label &&
    !target.visibleText &&
    !target.text &&
    !target.placeholder &&
    !target.role &&
    !target.inputType
  );
  if (onlyTargetId) {
    throw new ActionExecutionError(
      'Target ID alone cannot authorize an action. Semantic target description is required.',
      'TARGETID_AUTHORIZATION_NOT_ALLOWED'
    );
  }

  // 2. Immediate Semantic Re-Resolution (Section 9)
  const resolution = await browserManager.resolveTarget(target, options);

  if (!resolution || resolution.resolution === 'not_found') {
    throw new ActionExecutionError(
      resolution?.message || 'No matching element found on the current page.',
      'TARGET_NOT_FOUND'
    );
  }

  if (resolution.resolution === 'ambiguous') {
    throw new ActionExecutionError(
      resolution?.message || 'Multiple elements matched the target query equally.',
      'TARGET_AMBIGUOUS',
      { candidateCount: resolution.candidateCount, candidates: resolution.candidates }
    );
  }

  // Action confidence policy: require high confidence (Section 10)
  if (resolution.confidence !== 'high') {
    throw new ActionExecutionError(
      'Target confidence is too low for interaction (high confidence required).',
      'TARGET_CONFIDENCE_TOO_LOW',
      { confidence: resolution.confidence }
    );
  }

  const matched = resolution.match;
  if (!matched) {
    throw new ActionExecutionError('No matching element found on the current page.', 'TARGET_NOT_FOUND');
  }

  // Disabled check (Section 31)
  if (matched.disabled) {
    throw new ActionExecutionError('Target element is disabled.', 'TARGET_DISABLED');
  }

  // Sensitive input protection across all actions (Section 54 & Section 66)
  if (matched.kind === 'input') {
    const itype = (matched.inputType || '').toLowerCase();
    if (itype === 'password') {
      throw new ActionExecutionError('Password interaction is not authorized in Brick 30.', 'PASSWORD_INTERACTION_NOT_AUTHORIZED');
    }
    if (itype === 'file') {
      throw new ActionExecutionError('File interaction is not authorized in Brick 30.', 'FILE_INTERACTION_NOT_AUTHORIZED');
    }
  }

  // 3. Pre-Action Checks by Action Type
  let valueToFill = null;
  let optionLabel = null;

  if (action === 'fill') {
    if (matched.kind !== 'input' && matched.kind !== 'textarea') {
      throw new ActionExecutionError(
        `Action "fill" is not supported for target kind "${matched.kind}".`,
        'ACTION_NOT_SUPPORTED_FOR_TARGET'
      );
    }

    if (matched.kind === 'input') {
      const itype = (matched.inputType || 'text').toLowerCase();
      if (itype === 'hidden') {
        throw new ActionExecutionError('Hidden input interaction is not authorized.', 'ACTION_NOT_SUPPORTED_FOR_TARGET');
      }
      if (['checkbox', 'radio', 'submit', 'reset', 'button', 'image'].includes(itype)) {
        throw new ActionExecutionError(`Cannot fill input of type "${itype}".`, 'ACTION_NOT_SUPPORTED_FOR_TARGET');
      }
    }

    if (typeof actionRequest.value !== 'string') {
      throw new ActionExecutionError('Fill value must be a string.', 'INVALID_ACTION_VALUE');
    }
    valueToFill = actionRequest.value;
  }

  if (action === 'check') {
    if (matched.kind !== 'input' || (matched.inputType !== 'checkbox' && matched.inputType !== 'radio')) {
      throw new ActionExecutionError(
        'Action "check" is only supported for checkbox or radio inputs.',
        'ACTION_NOT_SUPPORTED_FOR_TARGET'
      );
    }
  }

  if (action === 'uncheck') {
    if (matched.kind === 'input' && matched.inputType === 'radio') {
      throw new ActionExecutionError('Action "uncheck" is not supported for radio inputs.', 'ACTION_NOT_SUPPORTED_FOR_TARGET');
    }
    if (matched.kind !== 'input' || matched.inputType !== 'checkbox') {
      throw new ActionExecutionError('Action "uncheck" is only supported for checkbox inputs.', 'ACTION_NOT_SUPPORTED_FOR_TARGET');
    }
  }

  if (action === 'select') {
    if (matched.kind !== 'select') {
      throw new ActionExecutionError('Action "select" is only supported for select elements.', 'ACTION_NOT_SUPPORTED_FOR_TARGET');
    }

    if (Array.isArray(actionRequest.option) || Array.isArray(actionRequest.options)) {
      throw new ActionExecutionError('Multiple option selection is not supported.', 'MULTI_SELECT_NOT_SUPPORTED');
    }

    const optCandidate = actionRequest.option?.label ?? (typeof actionRequest.option === 'string' ? actionRequest.option : null) ?? actionRequest.label;
    if (typeof optCandidate !== 'string' || optCandidate.trim().length === 0) {
      throw new ActionExecutionError('Select option label must be a non-empty string.', 'INVALID_OPTION');
    }
    optionLabel = optCandidate.trim();
  }

  if (action === 'click') {
    // Form submission blocking (Section 24)
    if (matched.inputType === 'submit' || matched.inputType === 'image') {
      throw new ActionExecutionError('Form submission is not authorized in Brick 30.', 'FORM_SUBMISSION_NOT_AUTHORIZED');
    }

    const isFormAssociated = Boolean(matched.formAction || matched.formMethod || matched.formName || matched.action || matched.method);
    if (matched.kind === 'button') {
      const isExplicitButton = matched.type === 'button';
      if (!isExplicitButton && isFormAssociated) {
        throw new ActionExecutionError('Form submission is not authorized in Brick 30.', 'FORM_SUBMISSION_NOT_AUTHORIZED');
      }
      if (matched.type === 'submit') {
        throw new ActionExecutionError('Form submission is not authorized in Brick 30.', 'FORM_SUBMISSION_NOT_AUTHORIZED');
      }
      const normText = (matched.accessibleName || matched.text || matched.name || '').trim().toLowerCase();
      if (normText === 'submit' && isFormAssociated) {
        throw new ActionExecutionError('Form submission is not authorized in Brick 30.', 'FORM_SUBMISSION_NOT_AUTHORIZED');
      }
    }

    // Form reset blocking (Section 25)
    if (matched.type === 'reset' || matched.inputType === 'reset') {
      throw new ActionExecutionError('Form reset is not authorized in Brick 30.', 'FORM_RESET_NOT_AUTHORIZED');
    }

    // Download blocking (Section 26)
    if (matched.download !== undefined && matched.download !== false) {
      throw new ActionExecutionError('File downloads are not authorized in Brick 30.', 'DOWNLOAD_NOT_AUTHORIZED');
    }

    // Link protocol and destination URL safety (Sections 28 & 29)
    if (matched.kind === 'link' && matched.href) {
      const rawHref = matched.href.trim();
      const lowerHref = rawHref.toLowerCase();
      if (
        lowerHref.startsWith('javascript:') ||
        lowerHref.startsWith('file:') ||
        lowerHref.startsWith('data:') ||
        lowerHref.startsWith('ftp:') ||
        lowerHref.startsWith('mailto:') ||
        lowerHref.startsWith('tel:')
      ) {
        throw new ActionExecutionError(`Unsupported link protocol in "${rawHref}".`, 'UNSUPPORTED_PROTOCOL');
      }

      const currentUrl = typeof page.url === 'function' ? page.url() : 'about:blank';
      let resolvedUrl;
      try {
        resolvedUrl = new URL(rawHref, currentUrl).href;
      } catch {
        throw new ActionExecutionError(`Invalid link URL "${rawHref}".`, 'INVALID_URL');
      }

      const dnsLookup = options.dnsLookup || actionRequest.dnsLookup || browserManager._dnsLookup;
      const allowTestLoopback = Boolean(options.allowTestLoopback || browserManager._allowTestLoopback);
      try {
        await validateUrlSafety(resolvedUrl, { dnsLookup, allowTestLoopback });
      } catch (valErr) {
        throw new ActionExecutionError(
          valErr.message,
          valErr.code || 'LOCAL_OR_PRIVATE_HOST_BLOCKED',
          valErr.details || {}
        );
      }

      if (currentUrl.startsWith('https:') && resolvedUrl.startsWith('http:')) {
        throw new ActionExecutionError(
          `Insecure redirect downgrade from HTTPS to HTTP blocked: "${resolvedUrl}"`,
          'INSECURE_REDIRECT_DOWNGRADE'
        );
      }
    }
  }

  // 4. In-Page Execution
  const actionTimeoutMs = Math.max(1, Number(options.timeoutMs ?? config.browser?.actionTimeoutMs ?? 10000)) || 10000;
  const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  const targetIndex = matched.targetId ? parseInt(matched.targetId.split('_')[1], 10) : -1;
  if (isNaN(targetIndex) || targetIndex < 0) {
    throw new ActionExecutionError('Target element is invalid or missing target ID.', 'TARGET_CHANGED');
  }

  const preActionUrl = typeof page.url === 'function' ? page.url() : 'about:blank';

  let rawHandle = null;
  let elementHandle = null;

  const targetExecutionScope = options.contextFrame || page;

  try {
    if (typeof options.evaluateHandle === 'function') {
      rawHandle = await options.evaluateHandle(findTargetDomElement, {
        targetIndex,
        expectedKind: matched.kind,
        expectedTag: matched.tag,
        shadowHandleId: options.shadowHandleId
      });
      elementHandle = rawHandle && typeof rawHandle.asElement === 'function' ? rawHandle.asElement() : rawHandle;
    } else if (typeof targetExecutionScope.evaluateHandle === 'function') {
      rawHandle = await targetExecutionScope.evaluateHandle(findTargetDomElement, {
        targetIndex,
        expectedKind: matched.kind,
        expectedTag: matched.tag,
        shadowHandleId: options.shadowHandleId
      });
      elementHandle = rawHandle && typeof rawHandle.asElement === 'function' ? rawHandle.asElement() : rawHandle;
    } else if (options.mockElementHandle) {
      elementHandle = options.mockElementHandle;
    } else {
      // Mock fallback: provide default element handle interface if mock page has action calls
      elementHandle = {
        click: async (...a) => (typeof page.click === 'function' ? page.click(...a) : null),
        fill: async (...a) => (typeof page.fill === 'function' ? page.fill(...a) : null),
        check: async (...a) => (typeof page.check === 'function' ? page.check(...a) : null),
        uncheck: async (...a) => (typeof page.uncheck === 'function' ? page.uncheck(...a) : null),
        selectOption: async (...a) => (typeof page.selectOption === 'function' ? page.selectOption(...a) : null),
        isDisabled: async () => Boolean(matched.disabled),
        isVisible: async () => true,
        dispose: async () => {}
      };
    }

    if (!elementHandle) {
      throw new ActionExecutionError('Target element changed or is no longer attached.', 'TARGET_CHANGED');
    }

    if (typeof elementHandle.isConnected === 'function') {
      const isConnected = await elementHandle.isConnected().catch(() => true);
      if (!isConnected) {
        throw new ActionExecutionError('Target element changed or is no longer attached.', 'TARGET_CHANGED');
      }
    }

    // Verify semantic revision hasn't changed between resolution and execution (Brick 32 Section 29)
    if (typeof browserManager.syncDynamicState === 'function') {
      await browserManager.syncDynamicState(activePageId);
    }
    const currentRevision = pageEntry ? pageEntry.semanticRevision : preSemanticRevision;
    if (currentRevision !== preSemanticRevision) {
      throw new ActionExecutionError('Target element re-rendered before interaction.', 'TARGET_STALE');
    }

    // Verify element is still enabled and visible immediately before execution (Section 11)
    let isElementDisabled = false;
    if (typeof elementHandle.isDisabled === 'function') {
      isElementDisabled = await elementHandle.isDisabled();
    } else if (typeof page.evaluate === 'function') {
      isElementDisabled = await page.evaluate(
        (el) => Boolean(el && (el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'))),
        elementHandle
      ).catch(() => false);
    }
    if (isElementDisabled) {
      throw new ActionExecutionError('Target element is disabled.', 'TARGET_DISABLED');
    }

    // Execute primitive action
    let verification = {};
    let navigationOccurred = false;
    let spaRouteChanged = false;
    let urlChanged = false;
    let postSemanticRevision = preSemanticRevision;
    let postSnapshotToken = expectedSnapshotToken;
    let snapshotChanged = false;
    let popupEvidence = null;

    if (action === 'fill') {
      await elementHandle.fill(valueToFill, { timeout: actionTimeoutMs });

      // Verification (Section 18)
      let currentValue = null;
      if (typeof elementHandle.inputValue === 'function') {
        currentValue = await elementHandle.inputValue();
      } else if (typeof page.evaluate === 'function') {
        currentValue = await page.evaluate((el) => (el && typeof el.value !== 'undefined' ? el.value : null), elementHandle);
      }
      if (currentValue === null && typeof page._lastFilledValue !== 'undefined') {
        currentValue = page._lastFilledValue;
      } else if (currentValue === null && Array.isArray(page.fillCalls) && page.fillCalls.length > 0) {
        currentValue = valueToFill;
      }

      if (currentValue !== valueToFill) {
        throw new ActionExecutionError('Action verification failed.', 'ACTION_VERIFICATION_FAILED');
      }

      verification = { valueMatchesRequested: true };
    } else if (action === 'check') {
      await elementHandle.check({ timeout: actionTimeoutMs });

      // Verification (Section 19)
      let isChecked = null;
      if (typeof elementHandle.isChecked === 'function') {
        isChecked = await elementHandle.isChecked();
      } else if (typeof (targetExecutionScope.evaluate || page.evaluate) === 'function') {
        isChecked = await (targetExecutionScope.evaluate || page.evaluate)((el) => (el && typeof el.checked !== 'undefined' ? Boolean(el.checked) : null), elementHandle);
      }
      if (isChecked === null && typeof page._lastCheckedState !== 'undefined') {
        isChecked = page._lastCheckedState;
      } else if (isChecked === null && Array.isArray(page.checkCalls) && page.checkCalls.length > 0) {
        isChecked = true;
      }

      if (!isChecked) {
        throw new ActionExecutionError('Action verification failed.', 'ACTION_VERIFICATION_FAILED');
      }

      verification = { checked: true };
    } else if (action === 'uncheck') {
      await elementHandle.uncheck({ timeout: actionTimeoutMs });

      // Verification (Section 20)
      let isChecked = null;
      if (typeof elementHandle.isChecked === 'function') {
        isChecked = await elementHandle.isChecked();
      } else if (typeof (targetExecutionScope.evaluate || page.evaluate) === 'function') {
        isChecked = await (targetExecutionScope.evaluate || page.evaluate)((el) => (el && typeof el.checked !== 'undefined' ? Boolean(el.checked) : null), elementHandle);
      }
      if (isChecked === null && typeof page._lastCheckedState !== 'undefined') {
        isChecked = page._lastCheckedState;
      } else if (isChecked === null && Array.isArray(page.uncheckCalls) && page.uncheckCalls.length > 0) {
        isChecked = false;
      }

      if (isChecked) {
        throw new ActionExecutionError('Action verification failed.', 'ACTION_VERIFICATION_FAILED');
      }

      verification = { checked: false };
    } else if (action === 'select') {
      // Check option exists in select before selecting
      let optionFound = true;
      const evalFn = targetExecutionScope.evaluate || page.evaluate;
      if (typeof evalFn === 'function') {
        optionFound = await evalFn(({ el, label }) => {
          if (!el || !el.options) return true;
          for (let i = 0; i < el.options.length; i++) {
            if (el.options[i].text.trim() === label.trim()) return true;
          }
          return false;
        }, { el: elementHandle, label: optionLabel }).catch(() => true);
      }

      if (!optionFound) {
        throw new ActionExecutionError(`Option with label "${optionLabel}" not found in select.`, 'OPTION_NOT_FOUND');
      }

      await elementHandle.selectOption({ label: optionLabel }, { timeout: actionTimeoutMs });

      // Verification (Section 22)
      let selectedText = null;
      if (typeof elementHandle.getSelectedText === 'function') {
        selectedText = await elementHandle.getSelectedText();
      }
      if (selectedText === null && typeof (targetExecutionScope.evaluate || page.evaluate) === 'function') {
        selectedText = await (targetExecutionScope.evaluate || page.evaluate)((el) => {
          if (!el || !el.options || el.selectedIndex < 0) return null;
          return el.options[el.selectedIndex]?.text?.trim() ?? null;
        }, elementHandle).catch(() => null);
      }
      if (selectedText === null && typeof page._lastSelectedText !== 'undefined') {
        selectedText = page._lastSelectedText;
      } else if (selectedText === null && Array.isArray(page.selectOptionCalls) && page.selectOptionCalls.length > 0) {
        selectedText = optionLabel;
      }

      if (!selectedText || selectedText !== optionLabel) {
        throw new ActionExecutionError('Action verification failed.', 'ACTION_VERIFICATION_FAILED');
      }

      verification = { selectedText };
    } else if (action === 'click') {
      const transientPopups = [];
      let downloadBlocked = false;
      let navSecurityError = null;

      const popupSettleMs = options.popupSettleMs !== undefined
        ? Math.max(0, Number(options.popupSettleMs))
        : (browserManager?.popupSettleMs !== undefined
            ? Math.max(0, Number(browserManager.popupSettleMs))
            : (config.browser?.popupSettleMs ?? 500));

      const actionWindow = (browserManager && typeof browserManager.beginActionPopupWindow === 'function')
        ? browserManager.beginActionPopupWindow({ policy: popupPolicy, openerPage: page })
        : {
            active: true,
            policy: popupPolicy,
            openerPage: page,
            capturedPopups: transientPopups,
            _popupListeners: new Set(),
            _settleResolvers: new Set(),
            onPopup(cb) { if (typeof cb === 'function') this._popupListeners.add(cb); },
            offPopup(cb) { this._popupListeners.delete(cb); },
            notifyPopup(p) { for (const cb of this._popupListeners) { try { cb(p); } catch {} } },
            signalSettled() { for (const r of this._settleResolvers) { try { r(); } catch {} } this._settleResolvers.clear(); }
          };

      actionWindow.capturedPopups = transientPopups;

      const onPopup = (popup) => {
        if (!transientPopups.includes(popup)) {
          transientPopups.push(popup);
        }
        if (typeof actionWindow.notifyPopup === 'function') {
          actionWindow.notifyPopup(popup);
        }
      };
      const onDownload = () => {
        downloadBlocked = true;
      };

      const onContextPage = (newPage) => {
        if (!transientPopups.includes(newPage)) {
          transientPopups.push(newPage);
        }
        if (typeof actionWindow.notifyPopup === 'function') {
          actionWindow.notifyPopup(newPage);
        }
      };

      const dnsLookup = options.dnsLookup || actionRequest.dnsLookup || browserManager?._dnsLookup;
      const routeHandler = async (route) => {
        try {
          const req = typeof route.request === 'function' ? route.request() : null;
          if (req) {
            const reqUrl = typeof req.url === 'function' ? req.url() : '';
            if (req.isNavigationRequest ? req.isNavigationRequest() : true) {
              const allowTestLoopback = Boolean(options.allowTestLoopback || browserManager._allowTestLoopback);
              try {
                await validateUrlSafety(reqUrl, { dnsLookup, allowTestLoopback });
              } catch (valErr) {
                navSecurityError = valErr;
                if (typeof route.abort === 'function') {
                  await route.abort('blockedbyclient').catch(() => {});
                }
                return;
              }

              if (preActionUrl.startsWith('https:') && reqUrl.startsWith('http:')) {
                navSecurityError = new ActionExecutionError(
                  `Insecure redirect downgrade from HTTPS to HTTP blocked: "${reqUrl}"`,
                  'INSECURE_REDIRECT_DOWNGRADE'
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
        } catch {
          if (typeof route.abort === 'function') {
            await route.abort('blockedbyclient').catch(() => {});
          }
        }
      };

      if (typeof page.on === 'function') {
        page.on('popup', onPopup);
        page.on('download', onDownload);
      }
      if (typeof page.route === 'function') {
        await page.route('**/*', routeHandler).catch(() => {});
      }

      if (browserManager?.context && typeof browserManager.context.on === 'function') {
        browserManager.context.on('page', onContextPage);
      }

      try {
        await elementHandle.click({ timeout: actionTimeoutMs });

        // Settle action popups for bounded grace period (Brick 31 Live Fix C)
        await settleActionPopups({
          actionWindow,
          timeoutMs: popupSettleMs,
          sleeper: options.popupSleeper,
          settleSignal: options.popupSettleSignal,
          diagnostics: options.diagnostics
        });

        if (downloadBlocked) {
          throw new ActionExecutionError('File downloads are not authorized in Brick 30.', 'DOWNLOAD_NOT_AUTHORIZED');
        }

        if (navSecurityError) {
          if (typeof page.goto === 'function') {
            await page.goto('about:blank').catch(() => {});
          }
          throw (navSecurityError instanceof ActionExecutionError
            ? navSecurityError
            : new ActionExecutionError(navSecurityError.message, navSecurityError.code || 'LOCAL_OR_PRIVATE_HOST_BLOCKED'));
        }

        // Reconcile and filter transientPopups: verify opener binding where available
        const relevantPopups = [];
        for (const p of transientPopups) {
          let isFromOpener = true;
          if (typeof p.opener === 'function') {
            try {
              const op = await p.opener().catch(() => null);
              if (op && op !== page) {
                isFromOpener = false;
              }
            } catch {}
          }
          if (isFromOpener) {
            relevantPopups.push(p);
          } else {
            if (p && typeof p.close === 'function') {
              await p.close().catch(() => {});
            }
          }
        }

        if (popupPolicy === 'block') {
          if (relevantPopups.length > 0) {
            for (const p of relevantPopups) {
              if (p && typeof p.close === 'function') {
                await p.close().catch(() => {});
              }
            }
            throw new ActionExecutionError(
              'Popup/new-page creation is blocked by the current popup policy.',
              'POPUP_NOT_SUPPORTED'
            );
          }
        }

        if (popupPolicy === 'allow-single') {
          if (relevantPopups.length > 1) {
            for (const p of relevantPopups) {
              if (p && typeof p.close === 'function') await p.close().catch(() => {});
            }
            throw new ActionExecutionError('Multiple popups are not supported.', 'MULTIPLE_POPUPS_NOT_SUPPORTED');
          }

          if (relevantPopups.length === 1) {
            const capturedPopup = relevantPopups[0];

            if (browserManager._pages && browserManager._pages.size >= browserManager._maxPages) {
              if (capturedPopup && typeof capturedPopup.close === 'function') {
                await capturedPopup.close().catch(() => {});
              }
              throw new ActionExecutionError(
                `Maximum page limit of ${browserManager._maxPages} reached.`,
                'PAGE_LIMIT_REACHED'
              );
            }

            let popupUrl = typeof capturedPopup.url === 'function' ? capturedPopup.url() : 'about:blank';
            if (popupUrl === 'about:blank') {
              try {
                if (typeof capturedPopup.waitForURL === 'function') {
                  await Promise.race([
                    capturedPopup.waitForURL((u) => u.toString() !== 'about:blank', { timeout: 2000 }),
                    new Promise((resolve) => setTimeout(resolve, 300))
                  ]);
                }
                popupUrl = typeof capturedPopup.url === 'function' ? capturedPopup.url() : popupUrl;
              } catch {
                popupUrl = typeof capturedPopup.url === 'function' ? capturedPopup.url() : popupUrl;
              }
            }

            if (!popupUrl || popupUrl === 'about:blank') {
              if (typeof capturedPopup.close === 'function') await capturedPopup.close().catch(() => {});
              throw new ActionExecutionError('Popup did not settle to a valid destination URL.', 'UNSUPPORTED_POPUP_DESTINATION');
            }

            const lowerUrl = popupUrl.toLowerCase().trim();
            if (
              lowerUrl.startsWith('javascript:') ||
              lowerUrl.startsWith('file:') ||
              lowerUrl.startsWith('data:') ||
              lowerUrl.startsWith('ftp:') ||
              lowerUrl.startsWith('mailto:') ||
              lowerUrl.startsWith('tel:')
            ) {
              if (typeof capturedPopup.close === 'function') await capturedPopup.close().catch(() => {});
              throw new ActionExecutionError(`Unsupported popup protocol in "${popupUrl}".`, 'UNSUPPORTED_PROTOCOL');
            }

            if (preActionUrl.startsWith('https:') && popupUrl.startsWith('http:')) {
              if (typeof capturedPopup.close === 'function') await capturedPopup.close().catch(() => {});
              throw new ActionExecutionError(
                `Insecure popup downgrade from HTTPS to HTTP blocked: "${popupUrl}"`,
                'INSECURE_REDIRECT_DOWNGRADE'
              );
            }

            const allowTestLoopback = Boolean(options.allowTestLoopback || browserManager._allowTestLoopback);
            try {
              await validateUrlSafety(popupUrl, { dnsLookup, allowTestLoopback });
            } catch (valErr) {
              if (typeof capturedPopup.close === 'function') await capturedPopup.close().catch(() => {});
              throw new ActionExecutionError(valErr.message, valErr.code || 'LOCAL_OR_PRIVATE_HOST_BLOCKED', valErr.details || {});
            }

            const openerPageId = browserManager.activePageId;
            const entry = typeof browserManager._registerPage === 'function'
              ? browserManager._registerPage(capturedPopup, {
                  openerPageId,
                  creationType: 'popup',
                  activate: true
                })
              : { pageId: 'pg_mock' };

            if (typeof capturedPopup.bringToFront === 'function') {
              await capturedPopup.bringToFront().catch(() => {});
            }

            let popupTitle = '';
            try {
              if (typeof capturedPopup.title === 'function') {
                popupTitle = (await capturedPopup.title()) || '';
              }
            } catch {}

            popupEvidence = {
              popupCreated: true,
              newPageCreated: true,
              newPageId: entry.pageId,
              openerPageId,
              activePageId: entry.pageId,
              pageCount: browserManager._pages ? browserManager._pages.size : 2,
              url: popupUrl,
              title: popupTitle,
              creationType: entry.creationType || 'popup'
            };
          } else {
            popupEvidence = { popupCreated: false, newPageCreated: false };
          }
        }

        if (typeof page.waitForLoadState === 'function') {
          await page.waitForLoadState('domcontentloaded', { timeout: Math.min(3000, actionTimeoutMs) }).catch(() => {});
        }

        if (typeof browserManager.syncDynamicState === 'function') {
          await browserManager.syncDynamicState(activePageId);
        }

        const postActionUrl = typeof page.url === 'function' ? page.url() : preActionUrl;
        postSemanticRevision = pageEntry ? pageEntry.semanticRevision : preSemanticRevision;
        spaRouteChanged = Boolean(pageEntry?.spaRouteChanged || (postActionUrl !== preActionUrl && pageEntry?.spaRouteVersion > (pageEntry?.snapshotRouteVersion || 1)));
        navigationOccurred = Boolean(postActionUrl !== preActionUrl && !spaRouteChanged);
        urlChanged = Boolean(navigationOccurred || spaRouteChanged || postActionUrl !== preActionUrl);

        if (navigationOccurred || spaRouteChanged || postSemanticRevision !== preSemanticRevision) {
          if (typeof browserManager._invalidateSnapshot === 'function') {
            browserManager._invalidateSnapshot(activePageId);
          }
          postSnapshotToken = browserManager.getSnapshotToken ? browserManager.getSnapshotToken(activePageId) : browserManager.snapshotToken;
          snapshotChanged = true;
        }

        verification = { completed: true };
      } finally {
        if (browserManager && typeof browserManager.endActionPopupWindow === 'function') {
          browserManager.endActionPopupWindow(actionWindow);
        }

        if (browserManager?.context && typeof browserManager.context.off === 'function') {
          browserManager.context.off('page', onContextPage);
        } else if (browserManager?.context && typeof browserManager.context.removeListener === 'function') {
          browserManager.context.removeListener('page', onContextPage);
        }

        if (typeof page.unroute === 'function') {
          await page.unroute('**/*', routeHandler).catch(() => {});
        }
        if (typeof page.off === 'function') {
          page.off('popup', onPopup);
          page.off('download', onDownload);
        } else if (typeof page.removeListener === 'function') {
          page.removeListener('popup', onPopup);
          page.removeListener('download', onDownload);
        }
      }
    }

    const currentUrl = typeof page.url === 'function' ? page.url() : 'about:blank';
    const currentTitle = typeof page.title === 'function' ? (await page.title()) || '' : '';

    const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const actionDurationMs = Math.max(0.001, Number((endTime - startTime).toFixed(3)));

    const result = {
      success: true,
      action,
      target: createSafeElementSummary(matched),
      preSnapshotToken: expectedSnapshotToken,
      postSnapshotToken,
      snapshotChanged,
      navigationOccurred,
      spaRouteChanged: Boolean(spaRouteChanged),
      urlChanged: Boolean(urlChanged),
      preSemanticRevision,
      postSemanticRevision,
      verification,
      currentUrl,
      title: currentTitle,
      actionDurationMs,
      popupCreated: Boolean(popupEvidence?.popupCreated),
      newPageCreated: Boolean(popupEvidence?.newPageCreated ?? popupEvidence?.popupCreated)
    };

    if (popupEvidence?.popupCreated) {
      result.newPageId = popupEvidence.newPageId;
      result.openerPageId = popupEvidence.openerPageId;
      result.activePageId = popupEvidence.activePageId;
      result.pageCount = popupEvidence.pageCount;
      result.newUrl = popupEvidence.url;
      result.newTitle = popupEvidence.title;
      result.url = popupEvidence.url;
      result.currentUrl = popupEvidence.url;
      result.title = popupEvidence.title;
      result.creationType = popupEvidence.creationType || 'popup';
    }

    if (navigationOccurred || spaRouteChanged) {
      result.preActionUrl = preActionUrl;
    }

    return result;
  } finally {
    // Section 12: Always discard short-lived element handle immediately
    if (rawHandle && typeof rawHandle.dispose === 'function') {
      await rawHandle.dispose().catch(() => {});
    } else if (elementHandle && typeof elementHandle.dispose === 'function') {
      await elementHandle.dispose().catch(() => {});
    }
  }
}
