/**
 * Deterministic Bounded Recovery & Self-Healing Policy for JARVIS4 (BRICK-041).
 *
 * Invariants:
 * - The MODEL does NOT decide whether a failure is officially recoverable.
 * - Runtime/controller policy determines failure class, recoverability, allowed recovery actions, and budgets.
 * - Never automatic mutation replay (click, fill, check, select, upload, download, submitForm).
 * - Distinguishes EFFECT_VERIFIED, NO_EFFECT_VERIFIED, and OUTCOME_UNCERTAIN.
 * - Consequential (R3) actions with uncertain outcome halt immediately without retry.
 * - Same-failure loop detection stops recovery with RECOVERY_EXHAUSTED after bounded occurrences.
 * - Model receives only sanitized advisory recovery hints (zero secrets, raw selectors, or confirmation tokens).
 * - Model cannot override recovery budgets or retry limits.
 */

export const FAILURE_CLASSES = Object.freeze({
  TARGET_STALE: 'TARGET_STALE',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  SNAPSHOT_STALE: 'SNAPSHOT_STALE',
  CONTEXT_STALE: 'CONTEXT_STALE',
  CONTEXT_DETACHED: 'CONTEXT_DETACHED',
  PAGE_CHANGED: 'PAGE_CHANGED',
  PAGE_CLOSED: 'PAGE_CLOSED',
  PAGE_NOT_ACTIVE: 'PAGE_NOT_ACTIVE',
  WAIT_TIMEOUT: 'WAIT_TIMEOUT',
  DOM_CHANGED: 'DOM_CHANGED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  MODEL_OUTPUT_INVALID: 'MODEL_OUTPUT_INVALID',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  TOOL_FAILURE: 'TOOL_FAILURE',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  CLOSED_SHADOW_UNSUPPORTED: 'CLOSED_SHADOW_UNSUPPORTED',
  MUTATION_OUTCOME_UNCERTAIN: 'MUTATION_OUTCOME_UNCERTAIN',
  CONSEQUENTIAL_OUTCOME_UNCERTAIN: 'CONSEQUENTIAL_OUTCOME_UNCERTAIN',
  RECOVERY_EXHAUSTED: 'RECOVERY_EXHAUSTED',
  UNKNOWN_FAILURE: 'UNKNOWN_FAILURE'
});

export const MUTATION_OUTCOMES = Object.freeze({
  EFFECT_VERIFIED: 'EFFECT_VERIFIED',
  NO_EFFECT_VERIFIED: 'NO_EFFECT_VERIFIED',
  OUTCOME_UNCERTAIN: 'OUTCOME_UNCERTAIN'
});

export const RECOVERY_ACTIONS = Object.freeze({
  RE_INSPECT: 'RE_INSPECT',
  REDISCOVER_CONTEXTS: 'REDISCOVER_CONTEXTS',
  WAIT_FOR_STABLE: 'WAIT_FOR_STABLE',
  SWITCH_PAGE: 'SWITCH_PAGE',
  REPLAN: 'REPLAN',
  HALT_AUTH: 'HALT_AUTH',
  HALT_POLICY: 'HALT_POLICY',
  HALT_UNCERTAIN: 'HALT_UNCERTAIN',
  HALT_EXHAUSTED: 'HALT_EXHAUSTED',
  HALT_BUDGET: 'HALT_BUDGET'
});

export const RECOVERY_BUDGET_DEFAULTS = Object.freeze({
  maxRecoveryCycles: 2,
  maxReplans: 2,
  maxSameFailureOccurrences: 2,
  maxContextRediscoveries: 2,
  maxRecoveryWaits: 2
});

export const RECOVERY_BUDGET_LIMITS = Object.freeze({
  maxRecoveryCycles: 3,
  maxReplans: 3,
  maxSameFailureOccurrences: 2,
  maxContextRediscoveries: 3,
  maxRecoveryWaits: 3
});

export const FORBIDDEN_RECOVERY_OVERRIDE_KEYS = Object.freeze([
  'recoverybudget',
  'maxretries',
  'retrycount',
  'maxrecoverycycles',
  'maxrecoverywaits',
  'maxcontextrediscoveries',
  'resetbudget',
  'extendtimeout',
  'retry',
  'retryoverride',
  'bypassrecovery'
]);

/**
 * Strips model-supplied or unvalidated recovery override parameters.
 *
 * @param {Object} obj
 * @returns {Object}
 */
export function stripRecoveryOverrides(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => stripRecoveryOverrides(item));

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (FORBIDDEN_RECOVERY_OVERRIDE_KEYS.includes(lowerKey)) {
      continue;
    }
    cleaned[key] = (value && typeof value === 'object') ? stripRecoveryOverrides(value) : value;
  }
  return cleaned;
}

/**
 * Deterministically classifies an execution error into a standardized failure class and recovery action.
 *
 * @param {Error|Object|string} error
 * @param {Object} [context={}]
 * @param {string} [context.tool]
 * @param {string} [context.risk]
 * @param {Object} [context.arguments]
 * @param {number} [context.managedPagesCount]
 * @returns {{ failureClass: string, recoverable: boolean, action: string, reason: string }}
 */
export function classifyFailure(error, context = {}) {
  const code = (typeof error === 'object' && error !== null)
    ? (error.code || error.errorCode || error.refusalCode || '')
    : '';
  const message = (typeof error === 'object' && error !== null)
    ? (error.message || error.errorMessage || '')
    : String(error || '');

  const textToScan = `${code} ${message}`.toLowerCase();

  // 1. Policy Blocked & Closed Shadow DOM (Strictly NOT autonomously recoverable)
  if (code === 'CLOSED_SHADOW_ROOT_UNSUPPORTED' || textToScan.includes('closed_shadow') || textToScan.includes('closed shadow root')) {
    return {
      failureClass: FAILURE_CLASSES.CLOSED_SHADOW_UNSUPPORTED,
      recoverable: false,
      action: RECOVERY_ACTIONS.HALT_POLICY,
      reason: 'Closed shadow roots cannot be accessed. Recovery halted safely.'
    };
  }

  if (code === 'BLOCKED_BY_POLICY' || code === 'SECURITY_OVERRIDE_REJECTED' || textToScan.includes('blocked_by_policy') || textToScan.includes('prohibited')) {
    return {
      failureClass: FAILURE_CLASSES.POLICY_BLOCKED,
      recoverable: false,
      action: RECOVERY_ACTIONS.HALT_POLICY,
      reason: 'Action is blocked by autonomous safety policy. Recovery halted safely.'
    };
  }

  // 2. Execution Budget Exceeded (Strictly NOT autonomously recoverable)
  if (code === 'BUDGET_EXCEEDED' || textToScan.includes('budget_exceeded') || textToScan.includes('budget limit')) {
    return {
      failureClass: FAILURE_CLASSES.BUDGET_EXCEEDED,
      recoverable: false,
      action: RECOVERY_ACTIONS.HALT_BUDGET,
      reason: 'Agent execution budget exhausted. Recovery halted safely.'
    };
  }

  // 3. Authentication & Human Barriers (Requires Human Handoff)
  if (
    code === 'HUMAN_HANDOFF_ACTIVE' ||
    code === 'LOGIN_REQUIRED' ||
    code === 'MFA_REQUIRED' ||
    code === 'CAPTCHA_REQUIRED' ||
    code === 'SESSION_EXPIRED' ||
    textToScan.includes('login_required') ||
    textToScan.includes('mfa_required') ||
    textToScan.includes('captcha_required') ||
    textToScan.includes('human_handoff_active')
  ) {
    return {
      failureClass: FAILURE_CLASSES.AUTH_REQUIRED,
      recoverable: false,
      action: RECOVERY_ACTIONS.HALT_AUTH,
      reason: 'Authentication barrier requires human interaction. Autonomous recovery halted.'
    };
  }

  // 4. Consequential / Uncertain Mutations
  if (code === 'CONSEQUENTIAL_OUTCOME_UNCERTAIN' || (context.risk === 'R3' && (code === 'MUTATION_OUTCOME_UNCERTAIN' || textToScan.includes('uncertain')))) {
    return {
      failureClass: FAILURE_CLASSES.CONSEQUENTIAL_OUTCOME_UNCERTAIN,
      recoverable: false,
      action: RECOVERY_ACTIONS.HALT_UNCERTAIN,
      reason: 'Consequential action outcome is uncertain. Replay and automated retry are strictly prohibited.'
    };
  }

  if (code === 'MUTATION_OUTCOME_UNCERTAIN' || textToScan.includes('outcome is uncertain') || textToScan.includes('mutation_outcome_uncertain')) {
    return {
      failureClass: FAILURE_CLASSES.MUTATION_OUTCOME_UNCERTAIN,
      recoverable: false,
      action: RECOVERY_ACTIONS.HALT_UNCERTAIN,
      reason: 'Action execution outcome cannot be verified. Automatic repeat is prohibited.'
    };
  }

  // 5. Stale Targets & Stale Snapshots (Recoverable via fresh inspect)
  if (
    code === 'TARGET_STALE' ||
    code === 'SNAPSHOT_STALE' ||
    textToScan.includes('target_stale') ||
    textToScan.includes('snapshot_stale') ||
    textToScan.includes('stale') ||
    textToScan.includes('execution context was destroyed')
  ) {
    return {
      failureClass: FAILURE_CLASSES.TARGET_STALE,
      recoverable: true,
      action: RECOVERY_ACTIONS.RE_INSPECT,
      reason: 'Target or snapshot became stale. Fresh page observation required.'
    };
  }

  // 6. Detached Contexts / Recreated Iframes (Recoverable via inspectContexts)
  if (
    code === 'CONTEXT_DETACHED' ||
    code === 'CONTEXT_NOT_ATTACHED' ||
    code === 'CONTEXT_NOT_FOUND' ||
    textToScan.includes('context_detached') ||
    textToScan.includes('context not attached') ||
    textToScan.includes('frame was detached')
  ) {
    return {
      failureClass: FAILURE_CLASSES.CONTEXT_DETACHED,
      recoverable: true,
      action: RECOVERY_ACTIONS.REDISCOVER_CONTEXTS,
      reason: 'Subcontext detached or frame recreated. Context rediscovery required.'
    };
  }

  // 7. Page Changed or Dynamic DOM Revision (Recoverable via fresh inspect)
  if (code === 'PAGE_CHANGED' || code === 'DOM_CHANGED' || textToScan.includes('page_changed') || textToScan.includes('dom_changed')) {
    return {
      failureClass: FAILURE_CLASSES.PAGE_CHANGED,
      recoverable: true,
      action: RECOVERY_ACTIONS.RE_INSPECT,
      reason: 'Page structure changed dynamically. Fresh observation required.'
    };
  }

  // 8. Dynamic Wait Timeout / Dynamic Loading (Recoverable via waitForStable)
  if (
    code === 'WAIT_TIMEOUT' ||
    code === 'BROWSER_PAGE_BUSY' ||
    textToScan.includes('wait_timeout') ||
    textToScan.includes('page is still changing') ||
    textToScan.includes('timeout exceeded')
  ) {
    return {
      failureClass: FAILURE_CLASSES.WAIT_TIMEOUT,
      recoverable: true,
      action: RECOVERY_ACTIONS.WAIT_FOR_STABLE,
      reason: 'Page is dynamic or loading. Bounded stability wait required.'
    };
  }

  // 9. Target Not Found (Recoverable via wait / re-inspect)
  if (code === 'TARGET_NOT_FOUND' || textToScan.includes('target_not_found') || textToScan.includes('no matching element')) {
    return {
      failureClass: FAILURE_CLASSES.TARGET_NOT_FOUND,
      recoverable: true,
      action: RECOVERY_ACTIONS.RE_INSPECT,
      reason: 'Element target not found on current page. Re-observation required.'
    };
  }

  // 10. Page Not Active / Page State Changed (Recoverable via switchPage if valid managed page exists)
  if (code === 'PAGE_NOT_ACTIVE' || code === 'PAGE_CLOSED' || textToScan.includes('page_not_active') || textToScan.includes('page closed')) {
    if ((context.managedPagesCount || 0) > 1) {
      return {
        failureClass: FAILURE_CLASSES.PAGE_NOT_ACTIVE,
        recoverable: true,
        action: RECOVERY_ACTIONS.SWITCH_PAGE,
        reason: 'Active tab state changed. Verified page switch required.'
      };
    }
    return {
      failureClass: FAILURE_CLASSES.PAGE_CLOSED,
      recoverable: false,
      action: RECOVERY_ACTIONS.HALT_POLICY,
      reason: 'Managed page was closed without surviving task page. Halted safely.'
    };
  }

  // 11. Verification Failed
  if (code === 'VERIFICATION_FAILED' || textToScan.includes('verification_failed')) {
    // Non-consequential safe verification failure can trigger replan
    return {
      failureClass: FAILURE_CLASSES.VERIFICATION_FAILED,
      recoverable: true,
      action: RECOVERY_ACTIONS.REPLAN,
      reason: 'Action executed but expected verification condition was not observed. Re-observation and replan required.'
    };
  }

  // 12. Model Timeout & Output Validation
  if (code === 'AGENT_MODEL_TIMEOUT' || textToScan.includes('model timeout')) {
    return {
      failureClass: FAILURE_CLASSES.MODEL_TIMEOUT,
      recoverable: false,
      action: RECOVERY_ACTIONS.HALT_POLICY,
      reason: 'Model turn timed out. Autonomous recovery halted.'
    };
  }

  if (code === 'AGENT_OUTPUT_INVALID') {
    return {
      failureClass: FAILURE_CLASSES.MODEL_OUTPUT_INVALID,
      recoverable: true,
      action: RECOVERY_ACTIONS.REPLAN,
      reason: 'Model output was invalid JSON schema. Bounded repair attempt allowed.'
    };
  }

  // Default fallback: general tool failure
  return {
    failureClass: FAILURE_CLASSES.TOOL_FAILURE,
    recoverable: true,
    action: RECOVERY_ACTIONS.RE_INSPECT,
    reason: message || 'Tool execution encountered an unexpected error. Re-observation required.'
  };
}

/**
 * Classifies whether an attempted mutation action had a verified effect, no effect, or an uncertain outcome.
 *
 * @param {Object} params
 * @param {string} params.tool
 * @param {string} [params.risk='R1']
 * @param {boolean} params.executed
 * @param {boolean} params.verified
 * @param {Error|Object} [params.error]
 * @param {Object} [params.rawResult]
 * @returns {string} One of MUTATION_OUTCOMES
 */
export function classifyMutationOutcome({ tool, risk = 'R1', executed, verified, error = null, rawResult = null }) {
  // If explicitly verified with positive evidence
  if (executed && verified) {
    return MUTATION_OUTCOMES.EFFECT_VERIFIED;
  }

  const errCode = (error && typeof error === 'object') ? (error.code || error.errorCode || '') : '';
  const errMsg = (error && typeof error === 'object') ? (error.message || '') : String(error || '');

  // If execution failed before DOM mutation (e.g. stale snapshot check, validation, target not found, disabled target)
  const preMutationCodes = [
    'POPUP_NOT_SUPPORTED',
    'TARGET_STALE',
    'SNAPSHOT_STALE',
    'TARGET_NOT_FOUND',
    'TARGET_DISABLED',
    'TARGET_AMBIGUOUS',
    'TARGET_CONFIDENCE_TOO_LOW',
    'TOOL_ARGUMENT_INVALID',
    'SECURITY_OVERRIDE_REJECTED',
    'BLOCKED_BY_POLICY',
    'CONTEXT_DETACHED',
    'CONTEXT_NOT_ATTACHED',
    'CLOSED_SHADOW_ROOT_UNSUPPORTED',
    'SUBCONTEXT_OPERATION_NOT_SUPPORTED',
    'HUMAN_HANDOFF_ACTIVE'
  ];

  if (!executed && (preMutationCodes.includes(errCode) || /before interaction|preflight|stale|not found/i.test(errMsg))) {
    return MUTATION_OUTCOMES.NO_EFFECT_VERIFIED;
  }

  // If action was executed but verification explicitly proves no DOM change occurred
  if (executed && rawResult && rawResult.verified === false && rawResult.domMutated === false) {
    return MUTATION_OUTCOMES.NO_EFFECT_VERIFIED;
  }

  // In all other failed or partially executed cases, the outcome is UNCERTAIN
  return MUTATION_OUTCOMES.OUTCOME_UNCERTAIN;
}

/**
 * Computes a safe, privacy-preserving fingerprint for failure recurrence tracking.
 * Strictly excludes full page text, secrets, authentication tokens, and long text bodies.
 *
 * @param {Object} params
 * @param {string} params.failureClass
 * @param {string} [params.tool]
 * @param {string} [params.pageId]
 * @param {string} [params.contextId]
 * @param {Object} [params.target]
 * @param {string} [params.milestoneId]
 * @returns {string}
 */
export function computeFailureFingerprint({ failureClass, tool = '', pageId = '', contextId = '', target = null, milestoneId = '' }) {
  let targetKey = '';
  if (target && typeof target === 'object') {
    const kind = target.kind || target.type || '';
    const label = target.text || target.accessibleName || target.name || target.id || '';
    targetKey = `${kind}:${label.slice(0, 30).trim().toLowerCase()}`;
  }

  return [
    failureClass || 'UNKNOWN',
    tool || '',
    pageId || '',
    contextId || '',
    targetKey,
    milestoneId || ''
  ].join('|');
}

/**
 * Generates an advisory sanitized hint for the agent model turn.
 * Must NOT expose hidden expected evidence, secrets, confirmation tokens, or raw paths.
 *
 * @param {string} failureClass
 * @param {string} recoveryAction
 * @param {Object} [context={}]
 * @returns {string}
 */
export function getRecoveryHint(failureClass, recoveryAction, context = {}) {
  switch (failureClass) {
    case FAILURE_CLASSES.TARGET_STALE:
    case FAILURE_CLASSES.SNAPSHOT_STALE:
      return 'Target or snapshot became stale due to dynamic DOM update. Re-observe the page to obtain a fresh snapshotToken before proposing an action. Do not replay the same stale target without fresh observation.';

    case FAILURE_CLASSES.TARGET_NOT_FOUND:
      return 'Target element was not found on the page in the current observation. Observe the refreshed page structure or wait for stability before acting.';

    case FAILURE_CLASSES.CONTEXT_DETACHED:
      return 'Iframe or shadow root context was detached or recreated. Discover active contexts with browser.inspectContexts before interacting inside subcontexts.';

    case FAILURE_CLASSES.WAIT_TIMEOUT:
      return 'Page was busy or dynamic content was delayed. Perform a stability observation or re-inspect the page before next proposal.';

    case FAILURE_CLASSES.PAGE_CHANGED:
      return 'Working page structure updated dynamically. Re-inspect the page to ground your next action.';

    case FAILURE_CLASSES.PAGE_NOT_ACTIVE:
      return 'Active working page state changed. Inspect open pages and switch to the intended task page with browser.switchPage.';

    case FAILURE_CLASSES.VERIFICATION_FAILED:
      return 'Action executed but expected evidence was not verified. Re-observe the page to verify current state before replanning.';

    case FAILURE_CLASSES.MUTATION_OUTCOME_UNCERTAIN:
    case FAILURE_CLASSES.CONSEQUENTIAL_OUTCOME_UNCERTAIN:
      return 'Previous mutation outcome is uncertain. Do NOT repeat or resubmit this mutation.';

    default:
      return 'Previous action encountered a recoverable condition. Re-observe page state before proposing your next step.';
  }
}

/**
 * Deterministic recovery manager coordinating budget limits and loop prevention.
 */
export class RecoveryManager {
  /**
   * @param {Object} [budgetOverrides={}]
   */
  constructor(budgetOverrides = {}) {
    this.budget = Object.freeze({
      maxRecoveryCycles: Math.min(
        Math.max(Number(budgetOverrides.maxRecoveryCycles) || RECOVERY_BUDGET_DEFAULTS.maxRecoveryCycles, 1),
        RECOVERY_BUDGET_LIMITS.maxRecoveryCycles
      ),
      maxReplans: Math.min(
        Math.max(Number(budgetOverrides.maxReplans) || RECOVERY_BUDGET_DEFAULTS.maxReplans, 1),
        RECOVERY_BUDGET_LIMITS.maxReplans
      ),
      maxSameFailureOccurrences: Math.min(
        Math.max(Number(budgetOverrides.maxSameFailureOccurrences) || RECOVERY_BUDGET_DEFAULTS.maxSameFailureOccurrences, 1),
        RECOVERY_BUDGET_LIMITS.maxSameFailureOccurrences
      ),
      maxContextRediscoveries: Math.min(
        Math.max(Number(budgetOverrides.maxContextRediscoveries) || RECOVERY_BUDGET_DEFAULTS.maxContextRediscoveries, 1),
        RECOVERY_BUDGET_LIMITS.maxContextRediscoveries
      ),
      maxRecoveryWaits: Math.min(
        Math.max(Number(budgetOverrides.maxRecoveryWaits) || RECOVERY_BUDGET_DEFAULTS.maxRecoveryWaits, 1),
        RECOVERY_BUDGET_LIMITS.maxRecoveryWaits
      )
    });

    this.recoveryCycles = 0;
    this.replans = 0;
    this.contextRediscoveries = 0;
    this.recoveryWaits = 0;
    this.failureCounts = new Map();
    this.lastFailureClass = null;
    this.lastRecoveryAction = null;
    this.lastMutationOutcome = null;
    this.loopExhausted = false;
  }

  /**
   * Evaluates if a failure can be recovered under deterministic recovery policy.
   *
   * @param {Object} classification - Output of classifyFailure()
   * @param {string} fingerprint - Output of computeFailureFingerprint()
   * @returns {{ canRecover: boolean, reason?: string }}
   */
  canRecover(classification, fingerprint) {
    if (!classification.recoverable) {
      return { canRecover: false, reason: classification.reason };
    }

    const currentSameCount = (this.failureCounts.get(fingerprint) || 0) + 1;
    if (currentSameCount > this.budget.maxSameFailureOccurrences) {
      this.loopExhausted = true;
      return {
        canRecover: false,
        reason: `Repeated failure loop detected: identical failure pattern recurred ${currentSameCount} times (limit: ${this.budget.maxSameFailureOccurrences}).`
      };
    }

    if (this.recoveryCycles >= this.budget.maxRecoveryCycles) {
      this.loopExhausted = true;
      return {
        canRecover: false,
        reason: `Recovery cycle budget of ${this.budget.maxRecoveryCycles} reached.`
      };
    }

    if (this.replans >= this.budget.maxReplans) {
      this.loopExhausted = true;
      return {
        canRecover: false,
        reason: `Replan budget of ${this.budget.maxReplans} reached.`
      };
    }

    if (classification.action === RECOVERY_ACTIONS.REDISCOVER_CONTEXTS) {
      if (this.contextRediscoveries >= this.budget.maxContextRediscoveries) {
        return {
          canRecover: false,
          reason: `Context rediscovery limit of ${this.budget.maxContextRediscoveries} reached.`
        };
      }
    }

    if (classification.action === RECOVERY_ACTIONS.WAIT_FOR_STABLE) {
      if (this.recoveryWaits >= this.budget.maxRecoveryWaits) {
        return {
          canRecover: false,
          reason: `Recovery wait limit of ${this.budget.maxRecoveryWaits} reached.`
        };
      }
    }

    return { canRecover: true };
  }

  /**
   * Records a recoverable failure occurrence.
   *
   * @param {Object} classification
   * @param {string} fingerprint
   */
  recordFailure(classification, fingerprint) {
    this.recoveryCycles++;
    this.lastFailureClass = classification.failureClass;
    this.lastRecoveryAction = classification.action;

    const count = (this.failureCounts.get(fingerprint) || 0) + 1;
    this.failureCounts.set(fingerprint, count);

    if (classification.action === RECOVERY_ACTIONS.REDISCOVER_CONTEXTS) {
      this.contextRediscoveries++;
    } else if (classification.action === RECOVERY_ACTIONS.WAIT_FOR_STABLE) {
      this.recoveryWaits++;
    }
  }

  /**
   * Records a recovery replan turn.
   */
  recordReplan() {
    this.replans++;
  }

  /**
   * Sets the outcome of the latest mutation.
   * @param {string} outcome
   */
  setMutationOutcome(outcome) {
    this.lastMutationOutcome = outcome;
  }

  /**
   * Returns sanitized telemetry for inclusion in trajectory.
   * @returns {Object}
   */
  getTelemetry() {
    return {
      recoveryCycles: this.recoveryCycles,
      replans: this.replans,
      contextRediscoveries: this.contextRediscoveries,
      recoveryWaits: this.recoveryWaits,
      lastFailureClass: this.lastFailureClass,
      lastRecoveryAction: this.lastRecoveryAction,
      lastMutationOutcome: this.lastMutationOutcome,
      loopExhausted: this.loopExhausted
    };
  }
}
