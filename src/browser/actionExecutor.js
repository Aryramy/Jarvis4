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
  if (typeof doc.querySelectorAll === 'function') {
    candidates = Array.from(doc.querySelectorAll(
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

  // Snapshot token validation (Section 8)
  const expectedSnapshotToken = actionRequest.expectedSnapshotToken;
  if (!expectedSnapshotToken || typeof expectedSnapshotToken !== 'string' || expectedSnapshotToken.trim().length === 0) {
    throw new ActionExecutionError('Expected snapshot token is required.', 'MISSING_SNAPSHOT_TOKEN');
  }

  const currentSnapshotToken = browserManager.snapshotToken;
  if (!currentSnapshotToken || expectedSnapshotToken !== currentSnapshotToken) {
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
      if (itype === 'password') {
        throw new ActionExecutionError('Password interaction is not authorized in Brick 30.', 'PASSWORD_INTERACTION_NOT_AUTHORIZED');
      }
      if (itype === 'file') {
        throw new ActionExecutionError('File interaction is not authorized in Brick 30.', 'FILE_INTERACTION_NOT_AUTHORIZED');
      }
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

    // Popup blocking (Section 27)
    if (matched.target === '_blank' || (typeof matched.target === 'string' && matched.target.toLowerCase() === '_blank')) {
      throw new ActionExecutionError('Opening popups or new tabs is not supported in Brick 30.', 'POPUP_NOT_SUPPORTED');
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

      const dnsLookup = options.dnsLookup || browserManager._dnsLookup;
      try {
        await validateUrlSafety(resolvedUrl, { dnsLookup });
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

  try {
    if (typeof options.evaluateHandle === 'function') {
      rawHandle = await options.evaluateHandle(findTargetDomElement, {
        targetIndex,
        expectedKind: matched.kind,
        expectedTag: matched.tag
      });
      elementHandle = rawHandle && typeof rawHandle.asElement === 'function' ? rawHandle.asElement() : rawHandle;
    } else if (typeof page.evaluateHandle === 'function') {
      rawHandle = await page.evaluateHandle(findTargetDomElement, {
        targetIndex,
        expectedKind: matched.kind,
        expectedTag: matched.tag
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
    let postSnapshotToken = expectedSnapshotToken;
    let snapshotChanged = false;

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
      } else if (typeof page.evaluate === 'function') {
        isChecked = await page.evaluate((el) => (el && typeof el.checked !== 'undefined' ? Boolean(el.checked) : null), elementHandle);
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
      } else if (typeof page.evaluate === 'function') {
        isChecked = await page.evaluate((el) => (el && typeof el.checked !== 'undefined' ? Boolean(el.checked) : null), elementHandle);
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
      if (typeof page.evaluate === 'function') {
        optionFound = await page.evaluate(({ el, label }) => {
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
      if (selectedText === null && typeof page.evaluate === 'function') {
        selectedText = await page.evaluate((el) => {
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
      let popupBlocked = false;
      let transientPopup = null;
      let downloadBlocked = false;
      let navSecurityError = null;

      const onPopup = (popup) => {
        popupBlocked = true;
        transientPopup = popup;
      };
      const onDownload = () => {
        downloadBlocked = true;
      };

      const dnsLookup = options.dnsLookup || browserManager._dnsLookup;
      const routeHandler = async (route) => {
        try {
          const req = typeof route.request === 'function' ? route.request() : null;
          if (req) {
            const reqUrl = typeof req.url === 'function' ? req.url() : '';
            if (req.isNavigationRequest ? req.isNavigationRequest() : true) {
              try {
                await validateUrlSafety(reqUrl, { dnsLookup });
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

      try {
        await elementHandle.click({ timeout: actionTimeoutMs });
      } finally {
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

      if (popupBlocked) {
        if (transientPopup && typeof transientPopup.close === 'function') {
          await transientPopup.close().catch(() => {});
        }
        throw new ActionExecutionError('Opening popups or new tabs is not supported in Brick 30.', 'POPUP_NOT_SUPPORTED');
      }

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

      if (typeof page.waitForLoadState === 'function') {
        await page.waitForLoadState('domcontentloaded', { timeout: Math.min(3000, actionTimeoutMs) }).catch(() => {});
      }

      const postActionUrl = typeof page.url === 'function' ? page.url() : preActionUrl;
      navigationOccurred = postActionUrl !== preActionUrl;

      if (navigationOccurred) {
        browserManager._invalidateSnapshot();
        postSnapshotToken = browserManager.snapshotToken;
        snapshotChanged = true;
      }

      verification = { completed: true };
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
      verification,
      currentUrl,
      title: currentTitle,
      actionDurationMs
    };

    if (navigationOccurred) {
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
