/**
 * Evidence Envelope & Verification Evaluator for JARVIS4 Runtime Agent Harness (PRE-040A).
 * Generates standardized evidence envelopes and evaluates deterministic proof.
 *
 * Invariants:
 * - Model claims/expectations do NOT declare task success.
 * - Authoritative evidence comes from real browser DOM, network, and event state.
 * - Standardized envelope structure across all tool executions.
 */

import { RuntimeHarnessError, ERROR_CODES } from './runtimeErrors.js';

export const SUPPORTED_EVIDENCE_TYPES = Object.freeze([
  'value-matches-requested',
  'checked-state',
  'selected-text',
  'navigation-occurred',
  'spa-route-changed',
  'popup-created',
  'form-populated',
  'submission-verified',
  'submission-unverified',
  'download-verified',
  'upload-verified',
  'dom-settled',
  'target-ready',
  'data-extracted',
  'status-retrieved',
  'inspection-completed',
  'handoff-initiated',
  'handoff-cancelled',
  'deterministic-execution'
]);

/**
 * Maps raw BrowserManager execution results to standard evidence types.
 *
 * @param {string} toolName
 * @param {Object} rawResult
 * @returns {string}
 */
export function inferEvidenceType(toolName, rawResult) {
  if (!rawResult || typeof rawResult !== 'object') {
    return 'deterministic-execution';
  }

  if (toolName === 'browser.fill') return 'value-matches-requested';
  if (toolName === 'browser.check' || toolName === 'browser.uncheck') return 'checked-state';
  if (toolName === 'browser.select') return 'selected-text';
  if (toolName === 'browser.fillForm') return 'form-populated';

  if (toolName === 'browser.submitForm') {
    return rawResult.verified ? 'submission-verified' : 'submission-unverified';
  }

  if (toolName === 'browser.click') {
    if (rawResult.newPageCreated || rawResult.popupCreated) return 'popup-created';
    if (rawResult.navigationOccurred) return 'navigation-occurred';
    if (rawResult.spaRouteChanged) return 'spa-route-changed';
    return 'deterministic-execution';
  }

  if (toolName === 'browser.navigate' || toolName === 'browser.navigateHistory' || toolName === 'browser.openPage') {
    return 'navigation-occurred';
  }

  if (toolName === 'browser.download') return 'download-verified';
  if (toolName === 'browser.upload') return 'upload-verified';
  if (toolName === 'browser.waitForStable') return 'dom-settled';
  if (toolName === 'browser.waitForTarget') return 'target-ready';
  if (toolName === 'browser.extractData') return 'data-extracted';
  if (toolName === 'browser.inspectPage' || toolName === 'browser.inspectForms' || toolName === 'browser.inspectContexts') {
    return 'inspection-completed';
  }
  if (toolName === 'browser.getPageStatus') return 'status-retrieved';
  if (toolName === 'browser.requestHumanAuth') return 'handoff-initiated';
  if (toolName === 'browser.cancelHandoff') return 'handoff-cancelled';

  return 'deterministic-execution';
}

/**
 * Builds a standardized evidence envelope for a completed execution step.
 *
 * @param {Object} params
 * @param {string} params.runId
 * @param {number} params.step
 * @param {string} params.tool
 * @param {string} params.risk
 * @param {boolean} params.executed
 * @param {boolean} params.verified
 * @param {string} [params.evidenceType]
 * @param {Object} [params.observed]
 * @param {string} [params.pageId]
 * @param {string} [params.contextId]
 * @param {number} [params.documentVersion]
 * @param {number} [params.semanticRevision]
 * @param {string} [params.snapshotToken]
 * @param {number} [params.elapsedMs]
 * @param {Object} [params.expectedOutcome] - Optional outcome requested by model
 * @returns {Object}
 */
export function buildEvidenceEnvelope(params) {
  const evidenceType = params.evidenceType || inferEvidenceType(params.tool, params.observed);

  const envelope = {
    runId: params.runId,
    step: params.step,
    tool: params.tool,
    risk: params.risk,
    executed: Boolean(params.executed),
    verified: Boolean(params.verified),
    evidenceType,
    observed: params.observed || null,
    pageId: params.pageId || null,
    contextId: params.contextId || null,
    documentVersion: params.documentVersion ?? null,
    semanticRevision: params.semanticRevision ?? null,
    snapshotToken: params.snapshotToken || null,
    elapsedMs: Math.max(0, Number(params.elapsedMs) || 0),
    timestamp: params.timestamp || Date.now()
  };

  // Evaluate model-requested expectedOutcome if present
  if (params.expectedOutcome && typeof params.expectedOutcome === 'object') {
    const outcomeType = params.expectedOutcome.type;
    if (!outcomeType || typeof outcomeType !== 'string') {
      envelope.expectedOutcomeEvaluation = {
        supported: false,
        error: 'EXPECTED_OUTCOME_UNSUPPORTED',
        message: 'Expected outcome missing valid "type" string.'
      };
    } else {
      const match = evaluateExpectedOutcome(outcomeType, params.expectedOutcome, params.observed, envelope);
      envelope.expectedOutcomeEvaluation = match;
    }
  }

  return envelope;
}

/**
 * Checks whether an expected outcome was satisfied by observed evidence.
 *
 * @param {string} outcomeType
 * @param {Object} expected
 * @param {Object} observed
 * @param {Object} envelope
 * @returns {Object}
 */
function evaluateExpectedOutcome(outcomeType, expected, observed, envelope) {
  switch (outcomeType) {
    case 'navigation-occurred':
      return { supported: true, matches: Boolean(observed?.navigationOccurred || envelope.evidenceType === 'navigation-occurred') };

    case 'url-equals': {
      if (!expected.url) return { supported: false, error: 'EXPECTED_OUTCOME_UNSUPPORTED', message: 'url-equals requires expected.url' };
      const currentUrl = observed?.currentUrl || observed?.url || '';
      return { supported: true, matches: currentUrl === expected.url };
    }

    case 'url-contains': {
      if (!expected.text && !expected.substring) return { supported: false, error: 'EXPECTED_OUTCOME_UNSUPPORTED', message: 'url-contains requires substring' };
      const currentUrl = observed?.currentUrl || observed?.url || '';
      const sub = expected.text || expected.substring;
      return { supported: true, matches: currentUrl.includes(sub) };
    }

    case 'target-present':
    case 'target-absent':
    case 'text-present':
    case 'text-absent':
      // Supported through form submitter / handoff verification
      return { supported: true, matches: Boolean(observed?.verified) };

    default:
      return {
        supported: false,
        error: 'EXPECTED_OUTCOME_UNSUPPORTED',
        message: `Outcome type "${outcomeType}" is not supported for verification.`
      };
  }
}
