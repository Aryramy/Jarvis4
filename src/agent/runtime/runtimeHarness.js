/**
 * Runtime Agent Harness for JARVIS4 (PRE-040A).
 * Deterministic governance layer sitting between future agent planner / LLM
 * and the verified GREEN-039 browser execution engine.
 *
 * Invariants:
 * - Exactly 0 LLM / OpenRouter / search calls.
 * - Strict argument and schema validation on all proposals.
 * - Deterministic risk classification (R0 to R4).
 * - Consequential actions (R3) pause for human confirmation (WAITING_USER_CONFIRMATION).
 * - The MODEL NEVER receives or presents confirmation tokens.
 * - Budget bounds (tool calls, navigations, mutations, submissions, time) enforced.
 * - Finite state machine with validated transitions.
 * - Standardized evidence envelopes and sanitized observations.
 * - Full audit trail with zero credential or secret logging.
 */

import crypto from 'node:crypto';
import { RuntimeHarnessError, ERROR_CODES } from './runtimeErrors.js';
import { getRegisteredTool, RISK_LEVELS, TOOL_CATEGORIES } from './toolRegistry.js';
import { validateToolProposal } from './toolValidator.js';
import { calculateToolRisk } from './riskPolicy.js';
import { ExecutionBudget } from './executionBudget.js';
import { ConfirmationGate } from './confirmationGate.js';
import { RuntimeStateMachine, RUN_STATES, TERMINAL_STATES } from './runtimeState.js';
import { sanitizeObservation, markUntrustedWebData } from './observationSanitizer.js';
import { buildEvidenceEnvelope } from './evidence.js';
import { defaultBrowserManager } from '../../browser/browserManager.js';

export class RuntimeAgentHarness {
  /**
   * @param {Object} [options={}]
   * @param {import('../../browser/browserManager.js').BrowserManager} [options.browserManager]
   * @param {Object} [options.budgetOptions]
   * @param {ConfirmationGate} [options.confirmationGate]
   */
  constructor(options = {}) {
    this.browserManager = options.browserManager || defaultBrowserManager;
    this.confirmationGate = options.confirmationGate || new ConfirmationGate();
    this.defaultBudgetOptions = options.budgetOptions || {};
    this.runs = new Map();
    this.auditLogs = new Map();
  }

  /**
   * Generates an opaque run identifier.
   * Example: 'run_mva1b2_9f8e7d6c'
   * @returns {string}
   */
  generateRunId() {
    const rnd = crypto.randomBytes(6).toString('hex');
    return `run_${Date.now().toString(36)}_${rnd}`;
  }

  /**
   * Initializes a new governed agent execution run.
   *
   * @param {Object} [options={}]
   * @param {string} [options.task] - User task intent string
   * @param {Object} [options.budget] - Run-specific budget limits
   * @returns {{ runId: string, state: string, createdAt: number }}
   */
  createRun(options = {}) {
    const runId = this.generateRunId();
    const stateMachine = new RuntimeStateMachine(RUN_STATES.RECEIVED);
    stateMachine.transitionTo(RUN_STATES.READY);

    const budget = new ExecutionBudget({
      ...this.defaultBudgetOptions,
      ...(options.budget || {})
    });

    const runRecord = {
      runId,
      task: typeof options.task === 'string' ? options.task.slice(0, 2000) : '',
      stateMachine,
      budget,
      stepCount: 0,
      activePendingActionId: null,
      createdAt: Date.now()
    };

    this.runs.set(runId, runRecord);
    this.auditLogs.set(runId, []);

    this.recordAudit(runId, {
      type: 'RUN_CREATED',
      state: RUN_STATES.READY,
      message: 'Governed run initialized successfully'
    });

    return {
      runId,
      state: stateMachine.state,
      createdAt: runRecord.createdAt
    };
  }

  /**
   * Retrieves a run record by runId.
   * @param {string} runId
   * @returns {Object}
   */
  getRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      throw new RuntimeHarnessError(`Run "${runId}" not found.`, ERROR_CODES.RUN_NOT_FOUND);
    }
    return {
      runId: run.runId,
      state: run.stateMachine.state,
      isTerminal: run.stateMachine.isTerminal,
      stepCount: run.stepCount,
      budget: run.budget.getSnapshot(),
      activePendingActionId: run.activePendingActionId,
      createdAt: run.createdAt
    };
  }

  /**
   * Retrieves sanitized audit log entries for a run.
   * @param {string} runId
   * @returns {Array<Object>}
   */
  getAuditLog(runId) {
    return this.auditLogs.get(runId) || [];
  }

  /**
   * Records a sanitized audit log entry.
   *
   * @param {string} runId
   * @param {Object} entry
   */
  recordAudit(runId, entry) {
    const logs = this.auditLogs.get(runId);
    if (!logs) return;

    logs.push({
      timestamp: Date.now(),
      runId,
      step: entry.step ?? null,
      tool: entry.tool ?? null,
      risk: entry.risk ?? null,
      decision: entry.decision ?? entry.type ?? null,
      elapsedMs: entry.elapsedMs ?? null,
      errorCode: entry.errorCode ?? null,
      message: entry.message ? String(entry.message).slice(0, 500) : null
    });
  }

  /**
   * Executes a model-proposed tool call through the strict 13-step governance pipeline.
   *
   * @param {string} runId
   * @param {Object} proposal - Structured tool call proposal
   * @returns {Promise<Object>}
   */
  async executeToolProposal(runId, proposal) {
    const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    const getElapsedMs = () => {
      const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
      return Math.max(0, Math.round(now - startTime));
    };

    // 1. Verify Run Identity & Terminal Status
    const run = this.runs.get(runId);
    if (!run) {
      throw new RuntimeHarnessError(`Run "${runId}" not found.`, ERROR_CODES.RUN_NOT_FOUND);
    }
    if (run.stateMachine.isTerminal) {
      throw new RuntimeHarnessError(
        `Run "${runId}" has already terminated with status "${run.stateMachine.state}".`,
        ERROR_CODES.RUN_ALREADY_TERMINATED
      );
    }

    // 2. Transition State to TOOL_PROPOSED
    run.stateMachine.transitionTo(RUN_STATES.TOOL_PROPOSED);
    run.stepCount++;
    const stepNumber = run.stepCount;

    let validated;
    try {
      // 3. Schema & Syntax Validation (Rejects raw selectors, code, and model security overrides)
      validated = validateToolProposal(proposal);
    } catch (valErr) {
      run.budget.recordFailure();
      this.recordAudit(runId, {
        step: stepNumber,
        tool: proposal?.tool || 'unknown',
        decision: 'VALIDATION_FAILED',
        errorCode: valErr.code || ERROR_CODES.TOOL_ARGUMENT_INVALID,
        message: valErr.message,
        elapsedMs: getElapsedMs()
      });
      const targetState = (valErr.code === ERROR_CODES.BLOCKED_BY_POLICY || valErr.code === ERROR_CODES.CLOSED_SHADOW_ROOT_UNSUPPORTED)
        ? RUN_STATES.BLOCKED_BY_POLICY
        : RUN_STATES.TOOL_FAILURE;
      run.stateMachine.transitionTo(targetState);
      throw valErr;
    }

    // 4. Transition State to VALIDATING
    run.stateMachine.transitionTo(RUN_STATES.VALIDATING);

    // 5. Gather Runtime Context (Current page URL, active pageId, snapshot token)
    const activePageId = validated.pageId || this.browserManager.activePageId;
    const currentUrl = typeof this.browserManager.currentUrl === 'string' ? this.browserManager.currentUrl : 'about:blank';
    const runtimeContext = {
      currentUrl,
      activePageId,
      currentSnapshotToken: this.browserManager.snapshotToken
    };

    // 6. Calculate Authoritative Risk Level (R0 through R4)
    const riskLevel = calculateToolRisk(validated.toolEntry, validated, runtimeContext);

    // 7. Prohibited Action Gate (R4)
    if (riskLevel === RISK_LEVELS.R4 || validated.toolEntry.category === TOOL_CATEGORIES.PROHIBITED) {
      run.budget.recordFailure();
      this.recordAudit(runId, {
        step: stepNumber,
        tool: validated.tool,
        risk: RISK_LEVELS.R4,
        decision: 'BLOCKED_BY_POLICY',
        errorCode: ERROR_CODES.BLOCKED_BY_POLICY,
        message: `Tool "${validated.tool}" is prohibited by autonomous agent policy.`,
        elapsedMs: getElapsedMs()
      });
      run.stateMachine.transitionTo(RUN_STATES.BLOCKED_BY_POLICY);
      throw new RuntimeHarnessError(
        `Action "${validated.tool}" is classified as R4 (Prohibited) and cannot be executed autonomously.`,
        ERROR_CODES.BLOCKED_BY_POLICY
      );
    }

    // 8. Execution Budget Check
    const transferType = validated.tool === 'browser.upload' ? 'upload' : (validated.tool === 'browser.download' ? 'download' : null);
    try {
      run.budget.checkBudget(validated.toolEntry.category, riskLevel, { transferType });
    } catch (budgetErr) {
      run.budget.recordFailure();
      this.recordAudit(runId, {
        step: stepNumber,
        tool: validated.tool,
        risk: riskLevel,
        decision: 'BUDGET_EXCEEDED',
        errorCode: budgetErr.code || ERROR_CODES.BUDGET_EXCEEDED,
        message: budgetErr.message,
        elapsedMs: getElapsedMs()
      });
      run.stateMachine.transitionTo(RUN_STATES.BUDGET_EXCEEDED);
      throw budgetErr;
    }

    // 9. Subcontext Safety Enforcement (GREEN-039 Section 55)
    if (validated.contextId && !validated.contextId.startsWith('ctx_main_')) {
      if (['browser.submitForm', 'browser.prepareFormSubmit', 'browser.upload', 'browser.download'].includes(validated.tool)) {
        run.budget.recordFailure();
        this.recordAudit(runId, {
          step: stepNumber,
          tool: validated.tool,
          risk: riskLevel,
          decision: 'SUBCONTEXT_OPERATION_NOT_SUPPORTED',
          errorCode: ERROR_CODES.SUBCONTEXT_OPERATION_NOT_SUPPORTED,
          message: 'Subcontext form submissions and file transfers are strictly not supported.',
          elapsedMs: getElapsedMs()
        });
        run.stateMachine.transitionTo(RUN_STATES.TOOL_FAILURE);
        throw new RuntimeHarnessError(
          `Subcontext operation "${validated.tool}" is prohibited inside iframe or shadow contexts.`,
          ERROR_CODES.SUBCONTEXT_OPERATION_NOT_SUPPORTED
        );
      }
    }

    // 10. Human Handoff Active Check (GREEN-036 Section 23)
    if (this.browserManager && typeof this.browserManager.isHandoffActive === 'function' && this.browserManager.isHandoffActive(activePageId)) {
      if (validated.toolEntry.isMutating) {
        run.budget.recordFailure();
        this.recordAudit(runId, {
          step: stepNumber,
          tool: validated.tool,
          risk: riskLevel,
          decision: 'HUMAN_HANDOFF_ACTIVE',
          errorCode: ERROR_CODES.HUMAN_HANDOFF_ACTIVE,
          message: 'Mutating tool calls are paused while Human Handoff is active.',
          elapsedMs: getElapsedMs()
        });
        run.stateMachine.transitionTo(RUN_STATES.NEEDS_HUMAN_AUTH);
        throw new RuntimeHarnessError(
          'Mutating browser actions are paused because a human authentication handoff is active on this page.',
          ERROR_CODES.HUMAN_HANDOFF_ACTIVE
        );
      }
    }

    // 11. Consequential Action Gating (R3) & Human Confirmation
    if (riskLevel === RISK_LEVELS.R3) {
      // Form submission requires preparation and human confirmation
      let internalPrepData = null;
      if (validated.tool === 'browser.submitForm') {
        try {
          // Perform deterministic pre-submission validity check via BrowserManager
          internalPrepData = await this.browserManager.prepareFormSubmission({
            form: validated.arguments.form,
            submitter: validated.arguments.submitter,
            expectedSnapshotToken: validated.snapshotToken,
            pageId: activePageId
          });
        } catch (prepErr) {
          run.budget.recordFailure();
          this.recordAudit(runId, {
            step: stepNumber,
            tool: validated.tool,
            risk: riskLevel,
            decision: 'PREPARATION_FAILED',
            errorCode: prepErr.code || 'PREPARATION_FAILED',
            message: prepErr.message,
            elapsedMs: getElapsedMs()
          });
          run.stateMachine.transitionTo(RUN_STATES.TOOL_FAILURE);
          throw prepErr;
        }
      }

      // Create pending action record (Internal token is stored here; NEVER given to model)
      const pendingAction = this.confirmationGate.createPendingAction({
        runId,
        tool: validated.tool,
        arguments: validated.arguments,
        pageId: activePageId,
        contextId: validated.contextId,
        snapshotToken: validated.snapshotToken,
        internalPreparationData: internalPrepData,
        summary: `Human confirmation required before executing ${validated.tool}`
      });

      run.activePendingActionId = pendingAction.pendingActionId;
      run.stateMachine.transitionTo(RUN_STATES.WAITING_USER_CONFIRMATION);

      this.recordAudit(runId, {
        step: stepNumber,
        tool: validated.tool,
        risk: riskLevel,
        decision: 'WAITING_USER_CONFIRMATION',
        message: `Action paused awaiting human approval. Pending Action ID: ${pendingAction.pendingActionId}`,
        elapsedMs: getElapsedMs()
      });

      // Return paused execution envelope to caller (Model receives pendingActionId; zero confirmationToken!)
      return {
        success: false,
        status: RUN_STATES.WAITING_USER_CONFIRMATION,
        runId,
        step: stepNumber,
        requiresConfirmation: true,
        risk: riskLevel,
        pendingAction: {
          pendingActionId: pendingAction.pendingActionId,
          tool: pendingAction.tool,
          summary: pendingAction.summary,
          pageId: pendingAction.pageId,
          contextId: pendingAction.contextId,
          snapshotToken: pendingAction.snapshotToken,
          expiresAt: pendingAction.expiresAt
        },
        message: 'Action paused. Explicit human confirmation is required through the operator boundary before execution.'
      };
    }

    // 12. Execution Boundary
    run.stateMachine.transitionTo(RUN_STATES.EXECUTING);
    run.budget.consume(validated.toolEntry.category, riskLevel, { transferType });

    let rawResult;
    try {
      rawResult = await validated.toolEntry.handler(this.browserManager, validated.arguments, {
        runId,
        pageId: activePageId,
        contextId: validated.contextId
      });
    } catch (execErr) {
      run.budget.recordFailure();
      this.recordAudit(runId, {
        step: stepNumber,
        tool: validated.tool,
        risk: riskLevel,
        decision: 'EXECUTION_FAILED',
        errorCode: execErr.code || 'EXECUTION_FAILED',
        message: execErr.message,
        elapsedMs: getElapsedMs()
      });
      if (run.budget.counters.consecutiveFailures <= run.budget.limits.maxConsecutiveFailures) {
        run.stateMachine.transitionTo(RUN_STATES.OBSERVING);
        run.stateMachine.transitionTo(RUN_STATES.READY);
      } else {
        run.stateMachine.transitionTo(RUN_STATES.TOOL_FAILURE);
      }
      throw execErr;
    }

    // 13. Deterministic Verification & Sanitized Evidence
    run.stateMachine.transitionTo(RUN_STATES.VERIFYING);

    const verified = Boolean(rawResult && (rawResult.verified !== false && rawResult.success !== false));
    if (!verified) {
      run.budget.recordFailure();
    } else {
      run.budget.recordSuccess();
    }

    run.stateMachine.transitionTo(RUN_STATES.OBSERVING);

    // Sanitize result: redact secrets, passwords, cookies, DPAPI, format untrusted web data
    const sanitizedObs = sanitizeObservation(rawResult, validated.tool);

    const evidenceEnvelope = buildEvidenceEnvelope({
      runId,
      step: stepNumber,
      tool: validated.tool,
      risk: riskLevel,
      executed: true,
      verified,
      observed: sanitizedObs,
      pageId: activePageId,
      contextId: validated.contextId,
      documentVersion: rawResult?.documentVersion,
      semanticRevision: rawResult?.semanticRevision,
      snapshotToken: rawResult?.snapshotToken || validated.snapshotToken,
      elapsedMs: getElapsedMs(),
      expectedOutcome: validated.expectedOutcome
    });

    this.recordAudit(runId, {
      step: stepNumber,
      tool: validated.tool,
      risk: riskLevel,
      decision: verified ? 'VERIFIED' : 'UNVERIFIED',
      elapsedMs: getElapsedMs()
    });

    // Reset machine to READY for next step
    run.stateMachine.transitionTo(RUN_STATES.READY);

    return {
      success: true,
      status: RUN_STATES.READY,
      runId,
      step: stepNumber,
      evidence: evidenceEnvelope
    };
  }

  /**
   * Approves and executes a pending action through the trusted human operator boundary.
   *
   * @param {string} runId
   * @param {string} pendingActionId
   * @param {Object} [operatorApproval={}]
   * @param {boolean} [operatorApproval.approved=true]
   * @returns {Promise<Object>}
   */
  async approvePendingAction(runId, pendingActionId, operatorApproval = { approved: true }) {
    const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    const getElapsedMs = () => {
      const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
      return Math.max(0, Math.round(now - startTime));
    };

    const run = this.runs.get(runId);
    if (!run) {
      throw new RuntimeHarnessError(`Run "${runId}" not found.`, ERROR_CODES.RUN_NOT_FOUND);
    }
    const pendingRecord = this.confirmationGate.getPendingAction(pendingActionId);
    if (!pendingRecord) {
      throw new RuntimeHarnessError(`Pending action "${pendingActionId}" not found.`, ERROR_CODES.PENDING_ACTION_NOT_FOUND);
    }
    if (pendingRecord.consumed) {
      throw new RuntimeHarnessError(`Pending action "${pendingActionId}" has already been used. Replay blocked.`, ERROR_CODES.PENDING_ACTION_ALREADY_USED);
    }

    if (run.stateMachine.state !== RUN_STATES.WAITING_USER_CONFIRMATION) {
      throw new RuntimeHarnessError(
        `Run is not waiting for confirmation (current state: "${run.stateMachine.state}").`,
        ERROR_CODES.INVALID_STATE_TRANSITION
      );
    }

    const currentSnapshotToken = this.browserManager.snapshotToken;
    const approvedRecord = this.confirmationGate.approvePendingAction(
      pendingActionId,
      operatorApproval,
      { currentSnapshotToken }
    );

    run.stepCount++;
    const stepNumber = run.stepCount;

    // Transition to EXECUTING
    run.stateMachine.transitionTo(RUN_STATES.EXECUTING);
    run.budget.consume(TOOL_CATEGORIES.CONSEQUENTIAL, RISK_LEVELS.R3);

    let rawResult;
    try {
      if (pendingRecord.tool === 'browser.submitForm') {
        const prep = pendingRecord.internalPreparationData;
        if (!prep || !prep.confirmationToken) {
          throw new RuntimeHarnessError('Internal confirmation preparation token is missing.', ERROR_CODES.TOOL_FAILURE);
        }

        // Execute submitForm through BrowserManager using internal confirmation token
        rawResult = await this.browserManager.submitForm({
          confirmationToken: prep.confirmationToken,
          expectedSnapshotToken: pendingRecord.snapshotToken,
          pageId: pendingRecord.pageId
        });
      } else {
        // Fallback for other approved consequential actions
        const toolEntry = getRegisteredTool(pendingRecord.tool);
        rawResult = await toolEntry.handler(this.browserManager, pendingRecord.arguments, {
          runId,
          pageId: pendingRecord.pageId,
          contextId: pendingRecord.contextId
        });
      }
    } catch (execErr) {
      run.budget.recordFailure();
      this.recordAudit(runId, {
        step: stepNumber,
        tool: pendingRecord.tool,
        risk: RISK_LEVELS.R3,
        decision: 'EXECUTION_FAILED',
        errorCode: execErr.code || 'EXECUTION_FAILED',
        message: execErr.message,
        elapsedMs: getElapsedMs()
      });
      run.stateMachine.transitionTo(RUN_STATES.TOOL_FAILURE);
      throw execErr;
    }

    run.stateMachine.transitionTo(RUN_STATES.VERIFYING);
    const verified = Boolean(rawResult && rawResult.verified);
    if (!verified) {
      run.budget.recordFailure();
    } else {
      run.budget.recordSuccess();
    }

    run.stateMachine.transitionTo(RUN_STATES.OBSERVING);
    run.activePendingActionId = null;

    const sanitizedObs = sanitizeObservation(rawResult, pendingRecord.tool);

    const evidenceEnvelope = buildEvidenceEnvelope({
      runId,
      step: stepNumber,
      tool: pendingRecord.tool,
      risk: RISK_LEVELS.R3,
      executed: true,
      verified,
      observed: sanitizedObs,
      pageId: pendingRecord.pageId,
      contextId: pendingRecord.contextId,
      documentVersion: rawResult?.documentVersion,
      semanticRevision: rawResult?.semanticRevision,
      snapshotToken: rawResult?.snapshotToken || pendingRecord.snapshotToken,
      elapsedMs: getElapsedMs()
    });

    this.recordAudit(runId, {
      step: stepNumber,
      tool: pendingRecord.tool,
      risk: RISK_LEVELS.R3,
      decision: verified ? 'VERIFIED' : 'UNVERIFIED',
      elapsedMs: getElapsedMs()
    });

    run.stateMachine.transitionTo(RUN_STATES.READY);

    return {
      success: true,
      status: RUN_STATES.READY,
      runId,
      step: stepNumber,
      evidence: evidenceEnvelope
    };
  }

  /**
   * Cancels an active governed run.
   *
   * @param {string} runId
   * @param {string} [reason='Operator cancelled']
   */
  cancelRun(runId, reason = 'Operator cancelled') {
    const run = this.runs.get(runId);
    if (!run) {
      throw new RuntimeHarnessError(`Run "${runId}" not found.`, ERROR_CODES.RUN_NOT_FOUND);
    }
    if (run.stateMachine.isTerminal) {
      return;
    }

    if (run.activePendingActionId) {
      try {
        this.confirmationGate.cancelPendingAction(run.activePendingActionId, reason);
      } catch {}
      run.activePendingActionId = null;
    }

    run.stateMachine.transitionTo(RUN_STATES.CANCELLED);
    this.recordAudit(runId, {
      type: 'RUN_CANCELLED',
      state: RUN_STATES.CANCELLED,
      message: reason
    });
  }

  /**
   * Prepares a safe routing context for future LLM integration (PRE-040B).
   * Maps governed runId to safe sessionId and resolves profile without allowing caller overrides.
   * NOTE: PRE-040B foundation only — zero model/LLM execution is triggered.
   *
   * @param {string} runId - Active run identifier
   * @param {Object} [options={}]
   * @param {'FAST'|'REASONING'} [options.profile='FAST'] - Application-selected profile
   * @returns {{ runId: string, sessionId: string, profile: 'FAST'|'REASONING' }}
   */
  createRoutingContext(runId, options = {}) {
    const run = this.runs.get(runId);
    if (!run) {
      throw new RuntimeHarnessError(`Run "${runId}" not found.`, ERROR_CODES.RUN_NOT_FOUND);
    }

    const requestedProfile = options.profile || 'FAST';
    const profile = String(requestedProfile).trim().toUpperCase();
    if (profile !== 'FAST' && profile !== 'REASONING') {
      throw new RuntimeHarnessError(`[${ERROR_CODES.SECURITY_OVERRIDE_REJECTED}] Invalid profile "${requestedProfile}". Only FAST and REASONING are permitted.`, ERROR_CODES.SECURITY_OVERRIDE_REJECTED);
    }

    // Model and caller cannot override security/routing controls (model, models, cost_tier, etc.)
    if (options.model || options.models || options.cost_tier || options.costTier || options.provider) {
      this.recordAudit(runId, {
        type: 'SECURITY_OVERRIDE_BLOCKED',
        message: 'Caller attempted to override routing controls; ignored'
      });
    }

    return {
      runId,
      sessionId: runId,
      profile
    };
  }

  /**
   * Resolves routing profile based on governance risk or task complexity.
   * Bounded policy mapping without automatic runtime escalation loops.
   *
   * @param {string} purpose - 'routine' | 'recovery' | 'reasoning'
   * @returns {'FAST'|'REASONING'}
   */
  resolveRoutingProfile(purpose) {
    if (purpose === 'recovery' || purpose === 'reasoning') {
      return 'REASONING';
    }
    return 'FAST';
  }
}

export const defaultRuntimeAgentHarness = new RuntimeAgentHarness();

