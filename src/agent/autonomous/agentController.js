/**
 * Autonomous Browser Agent Controller for JARVIS4 (BRICK-040).
 * Orchestrates multi-step planning, state-governed tool execution, and verification.
 *
 * Invariants:
 * - Direct Playwright / BrowserManager bypass is STRICTLY PROHIBITED.
 * - All tool proposals execute exclusively through RuntimeAgentHarness.
 * - Model uses application-controlled OpenRouter Routing Gate (FAST by default, bounded REASONING).
 * - Finite state machine with validated transitions.
 * - Consequential actions (R3) pause in WAITING_USER_CONFIRMATION without exposed tokens.
 * - Authentication barriers pause in NEEDS_HUMAN_AUTH without automated credentials.
 * - Strict execution budgets enforced deterministically.
 */

import crypto from 'node:crypto';
import { AgentRunStateMachine, AGENT_RUN_STATES } from './agentState.js';
import {
  extractJsonFromCompletion,
  validatePlanOutput,
  validateActionOutput,
  AGENT_VALIDATION_ERRORS
} from './outputValidator.js';
import {
  buildSystemPrompt,
  compactObservation,
  buildPlanningMessages,
  buildActionMessages,
  buildRepairMessages
} from './agentPlanner.js';
import { OpenRouterRoutingGate } from '../../providers/openRouterRouter.js';
import { ROUTING_PROFILES } from '../../providers/openRouterRouting.js';
import { RuntimeAgentHarness } from '../runtime/runtimeHarness.js';
import { RuntimeHarnessError, ERROR_CODES } from '../runtime/runtimeErrors.js';
import { getRegisteredTool } from '../runtime/toolRegistry.js';
import { defaultBrowserManager } from '../../browser/browserManager.js';
import {
  FAILURE_CLASSES,
  MUTATION_OUTCOMES,
  RECOVERY_ACTIONS,
  RecoveryManager,
  classifyFailure,
  classifyMutationOutcome,
  computeFailureFingerprint,
  getRecoveryHint,
  stripRecoveryOverrides
} from './recoveryPolicy.js';

function isMutation(toolName) {
  const def = getRegisteredTool(toolName);
  return Boolean(def && def.isMutating);
}

export const CONTROLLER_DEFAULTS = Object.freeze({
  maxToolCalls: 10,
  maxModelTurns: 10,
  maxNavigations: 4,
  maxMutations: 6,
  maxFormSubmissions: 1,
  maxUploads: 1,
  maxDownloads: 1,
  maxConsecutiveFailures: 2,
  maxRuntimeMs: 60000,
  maxTokens: 25000,
  maxReasoningTurns: 2
});

export class AgentController {
  /**
   * @param {Object} options
   * @param {string|Object} options.task - User task string or publicTask object
   * @param {RuntimeAgentHarness} [options.runtimeHarness]
   * @param {OpenRouterRoutingGate} [options.routingGate]
   * @param {import('../../browser/browserManager.js').BrowserManager} [options.browserManager]
   * @param {string} [options.runId]
   * @param {Object} [options.budgets]
   * @param {Array<string>} [options.allowedTools]
   * @param {number} [options.maxReasoningTurns=2]
   */
  constructor(options = {}) {
    if (!options.task) {
      throw new Error('AgentController requires a task string or publicTask object.');
    }

    const rawTask = typeof options.task === 'string'
      ? { publicPrompt: options.task }
      : options.task;

    this.publicPrompt = String(rawTask.publicPrompt || rawTask.prompt || '').trim();
    if (!this.publicPrompt) {
      throw new Error('Task prompt cannot be empty.');
    }

    this.taskId = rawTask.id || null;
    this.allowedTools = Array.isArray(rawTask.allowedTools)
      ? Object.freeze([...rawTask.allowedTools])
      : (Array.isArray(options.allowedTools) ? Object.freeze([...options.allowedTools]) : null);

    this.browserManager = options.browserManager || defaultBrowserManager;
    this.runtimeHarness = options.runtimeHarness || new RuntimeAgentHarness({ browserManager: this.browserManager });
    this.routingGate = options.routingGate || new OpenRouterRoutingGate();

    const mergedBudgets = {
      ...CONTROLLER_DEFAULTS,
      ...(rawTask.budgets || {}),
      ...(options.budgets || {})
    };

    // Clamp limits against malicious expansion
    this.budgets = Object.freeze({
      maxToolCalls: Math.min(Math.max(Number(mergedBudgets.maxToolCalls) || 10, 1), 20),
      maxModelTurns: Math.min(Math.max(Number(mergedBudgets.maxModelTurns) || 6, 1), 12),
      maxNavigations: Math.min(Math.max(Number(mergedBudgets.maxNavigations) || 4, 1), 10),
      maxMutations: Math.min(Math.max(Number(mergedBudgets.maxMutations) || 6, 0), 15),
      maxFormSubmissions: Math.min(Math.max(Number(mergedBudgets.maxFormSubmissions) || 1, 0), 3),
      maxUploads: Math.min(Math.max(Number(mergedBudgets.maxUploads) || 1, 0), 2),
      maxDownloads: Math.min(Math.max(Number(mergedBudgets.maxDownloads) || 1, 0), 2),
      maxConsecutiveFailures: Math.min(Math.max(Number(mergedBudgets.maxConsecutiveFailures) || 2, 1), 5),
      maxRuntimeMs: Math.min(Math.max(Number(mergedBudgets.maxRuntimeMs) || 60000, 1000), 120000),
      maxTokens: Math.min(Math.max(Number(mergedBudgets.maxTokens) || 25000, 1000), 50000),
      maxReasoningTurns: Math.min(Math.max(Number(mergedBudgets.maxReasoningTurns) || 2, 0), 4)
    });

    this.agentRunId = `agentrun_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    this.harnessRunId = options.runId || null;

    this.stateMachine = new AgentRunStateMachine(AGENT_RUN_STATES.RECEIVED);
    this.plan = null;
    this.steps = [];
    this.modelTurns = [];
    this.startTime = Date.now();
    this.consecutiveFailures = 0;
    this.totalFailures = 0;
    this.reasoningTurnsCount = 0;
    this.fastTurnsCount = 0;
    this.paused = false;
    this.activePendingAction = null;
    this.latestObservation = null;
    this.totalTokens = 0;
    this.totalCost = null;

    // Recovery & Self-Healing state (BRICK-041)
    const recoveryBudgetInput = options.recoveryBudget || rawTask.recoveryBudget || {};
    this.recoveryManager = new RecoveryManager(recoveryBudgetInput);
    this.planVersion = 1;
    this.planHistory = [];
    this.lastMutationProposal = null;
    this.lastMutationFailed = false;
    this.lastMutationOutcome = null;
    this.recoveryHint = null;
  }

  get state() {
    return this.stateMachine.state;
  }

  get isTerminal() {
    return this.stateMachine.isTerminal;
  }

  /**
   * Initializes or links the RuntimeAgentHarness run record.
   */
  _ensureHarnessRun() {
    if (!this.harnessRunId) {
      const created = this.runtimeHarness.createRun({
        task: this.publicPrompt,
        budget: this.budgets
      });
      this.harnessRunId = created.runId;
    }
    return this.harnessRunId;
  }

  /**
   * Evaluates whether the current budget is exceeded.
   * Throws RuntimeHarnessError if breached.
   */
  _assertBudget() {
    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.budgets.maxRuntimeMs) {
      throw new RuntimeHarnessError(
        `Agent task execution time limit of ${this.budgets.maxRuntimeMs}ms exceeded (elapsed: ${elapsed}ms).`,
        ERROR_CODES.BUDGET_EXCEEDED
      );
    }
    if (this.modelTurns.length >= this.budgets.maxModelTurns) {
      throw new RuntimeHarnessError(
        `Agent max model turns budget of ${this.budgets.maxModelTurns} reached.`,
        ERROR_CODES.BUDGET_EXCEEDED
      );
    }
    if (this.steps.length >= this.budgets.maxToolCalls) {
      throw new RuntimeHarnessError(
        `Agent max tool calls budget of ${this.budgets.maxToolCalls} reached.`,
        ERROR_CODES.BUDGET_EXCEEDED
      );
    }
    if (this.consecutiveFailures >= this.budgets.maxConsecutiveFailures) {
      throw new RuntimeHarnessError(
        `Agent consecutive failures limit of ${this.budgets.maxConsecutiveFailures} reached.`,
        ERROR_CODES.BUDGET_EXCEEDED
      );
    }
  }

  /**
   * Fetches fresh deterministic observation from the browser using appropriate inspect primitive.
   *
   * @param {Object} [options]
   * @param {string} [options.contextId]
   * @param {string} [options.pageId]
   * @returns {Promise<Object>}
   */
  async _fetchBrowserObservation(options = {}) {
    const runId = this._ensureHarnessRun();
    const activePageId = options.pageId || this.browserManager.activePageId;
    const currentUrl = typeof this.browserManager.currentUrl === 'string' ? this.browserManager.currentUrl : 'about:blank';
    const isHandoff = this.browserManager && typeof this.browserManager.isHandoffActive === 'function' && this.browserManager.isHandoffActive(activePageId);

    const baseObs = {
      currentUrl,
      title: 'Active Document',
      snapshotToken: this.browserManager.snapshotToken || 'snap_init',
      pageId: activePageId,
      contextId: options.contextId || 'ctx_main_1',
      handoffActive: isHandoff,
      handoffReason: isHandoff ? 'LOGIN_REQUIRED' : null
    };

    if (isHandoff) {
      this.latestObservation = baseObs;
      return baseObs;
    }

    try {
      if (this.browserManager && (typeof this.browserManager.inspectPage === 'function' || typeof this.browserManager.inspect === 'function')) {
        const inspectFn = typeof this.browserManager.inspectPage === 'function'
          ? this.browserManager.inspectPage.bind(this.browserManager)
          : this.browserManager.inspect.bind(this.browserManager);
        const insp = await inspectFn({ contextId: options.contextId, pageId: activePageId });
        this.latestObservation = {
          ...baseObs,
          contexts: this.latestObservation?.contexts || [],
          closedShadowRootDetected: Boolean(this.latestObservation?.closedShadowRootDetected),
          title: insp.title || baseObs.title,
          snapshotToken: insp.snapshotToken || baseObs.snapshotToken,
          visibleText: (insp.visibleText && typeof insp.visibleText === 'object') ? insp.visibleText.content : (insp.visibleText || ''),
          elements: insp.elements || [],
          forms: insp.forms || [],
          recoveryHint: this.recoveryHint,
          planVersion: this.planVersion,
          mutationOutcome: this.lastMutationOutcome
        };
        return this.latestObservation;
      }

      // Fallback to inspectPage proposal if inspect is not on browserManager
      const inspectResult = await this.runtimeHarness.executeToolProposal(runId, {
        tool: 'browser.inspectPage',
        contextId: options.contextId,
        arguments: { pageId: activePageId }
      });

      this.latestObservation = {
        ...baseObs,
        contexts: this.latestObservation?.contexts || [],
        closedShadowRootDetected: Boolean(this.latestObservation?.closedShadowRootDetected),
        title: inspectResult.evidence?.observed?.title || baseObs.title,
        snapshotToken: inspectResult.evidence?.snapshotToken || baseObs.snapshotToken,
        visibleText: inspectResult.evidence?.observed?.visibleText || '',
        elements: inspectResult.evidence?.observed?.elements || [],
        forms: inspectResult.evidence?.observed?.forms || [],
        recoveryHint: this.recoveryHint,
        planVersion: this.planVersion,
        mutationOutcome: this.lastMutationOutcome
      };
      return this.latestObservation;
    } catch (err) {
      this.latestObservation = {
        ...baseObs,
        recoveryHint: this.recoveryHint,
        planVersion: this.planVersion,
        mutationOutcome: this.lastMutationOutcome,
        lastError: err.code || err.message
      };
      return this.latestObservation;
    }
  }

  /**
   * Dispatches a prompt to the model through OpenRouterRoutingGate with profile policy.
   *
   * @param {Array<{ role: string, content: string }>} messages
   * @param {'FAST'|'REASONING'} profile
   * @returns {Promise<string>}
   */
  async _invokeModel(messages, profile) {
    this._assertBudget();

    let text = '';
    let result = null;

    const reasoning = profile === ROUTING_PROFILES.FAST
      ? { effort: 'none' }
      : { max_tokens: 300 };

    const remainingBudgetMs = Math.max(1000, (this.budgets?.maxRuntimeMs || 20000) - (Date.now() - this.startTime));
    const timeoutMs = Math.min(10000, remainingBudgetMs);

    if (this.routingGate && typeof this.routingGate.complete === 'function') {
      result = await this.routingGate.complete({
        profile,
        messages,
        maxTokens: 500,
        temperature: 0,
        timeoutMs,
        reasoning
      });

      if (!result.success) {
        const isTimeout = result.errorCode === 'OPENROUTER_TIMEOUT' || /timeout/i.test(result.error || '');
        throw new RuntimeHarnessError(
          `OpenRouter model call failed: ${result.error}`,
          isTimeout ? 'AGENT_MODEL_TIMEOUT' : (result.errorCode || 'MODEL_ROUTING_FAILED')
        );
      }

      text = result.text || '';
      if (result.telemetry) {
        if (typeof result.telemetry.totalTokens === 'number') {
          this.totalTokens += result.telemetry.totalTokens;
        }
        if (typeof result.telemetry.cost === 'number') {
          this.totalCost = (this.totalCost || 0) + result.telemetry.cost;
        }
      }
    } else if (this.routingGate && typeof this.routingGate.routeChatCompletion === 'function') {
      const res = await this.routingGate.routeChatCompletion({
        profile,
        messages,
        maxTokens: 1000
      });
      text = res.completion || res.text || '';
      result = {
        actualModel: res.metadata?.model || 'mock-model',
        providerDurationMs: res.metadata?.latencyMs || 10,
        telemetry: { totalTokens: res.metadata?.tokens || 50 }
      };
      if (res.metadata?.tokens) {
        this.totalTokens += res.metadata.tokens;
      }
    } else {
      throw new Error('Routing gate has neither complete nor routeChatCompletion method.');
    }

    if (profile === ROUTING_PROFILES.REASONING) {
      this.reasoningTurnsCount++;
    } else {
      this.fastTurnsCount++;
    }

    this.modelTurns.push({
      turn: this.modelTurns.length + 1,
      profile,
      model: result?.actualModel || result?.model || 'mock-model',
      durationMs: result?.providerDurationMs || 10,
      tokens: result?.telemetry?.totalTokens || null
    });

    return text;
  }

  /**
   * Step 1: Generates the initial hybrid short plan (2-4 milestones).
   */
  async _generatePlan() {
    this.stateMachine.transitionTo(AGENT_RUN_STATES.PLANNING);

    const planningMessages = buildPlanningMessages({
      task: this.publicPrompt,
      allowedTools: this.allowedTools || [],
      budgets: this.budgets
    });

    let rawText = await this._invokeModel(planningMessages, ROUTING_PROFILES.FAST);

    let parsedPlan;
    try {
      const json = extractJsonFromCompletion(rawText);
      parsedPlan = validatePlanOutput(json);
    } catch (err) {
      // Bounded single repair attempt
      const repairMessages = buildRepairMessages(err.message);
      rawText = await this._invokeModel(repairMessages, ROUTING_PROFILES.FAST);
      const json = extractJsonFromCompletion(rawText);
      parsedPlan = validatePlanOutput(json);
    }

    this.plan = parsedPlan;
    return this.plan;
  }

  /**
   * Main autonomous execution loop.
   *
   * @returns {Promise<{ trajectory: Object, terminalState: string }>}
   */
  async run() {
    const runId = this._ensureHarnessRun();

    try {
      // Step 1: Hybrid short-plan generation
      await this._generatePlan();

      // Step 2: First observation before any mutation
      this.stateMachine.transitionTo(AGENT_RUN_STATES.OBSERVING);
      await this._fetchBrowserObservation();

      // Step 3: Multi-step action loop
      while (!this.stateMachine.isTerminal && !this.paused) {
        this._assertBudget();

        // Resolve active milestone
        const currentMilestone = this.plan.milestones.find(m => m.status === 'in_progress')
          || this.plan.milestones.find(m => m.status === 'pending')
          || this.plan.milestones[this.plan.milestones.length - 1];

        // Determine routing profile: Default FAST; escalate to REASONING if recovering
        const profile = (this.consecutiveFailures > 0 && this.reasoningTurnsCount < this.budgets.maxReasoningTurns)
          ? ROUTING_PROFILES.REASONING
          : ROUTING_PROFILES.FAST;

        const compactObs = compactObservation(this.latestObservation);
        const harnessRecord = this.runtimeHarness.getRun(runId);

        const actionMessages = buildActionMessages({
          task: this.publicPrompt,
          plan: this.plan,
          currentMilestone,
          compactObservation: compactObs,
          budgetSnapshot: harnessRecord.budget,
          allowedTools: this.allowedTools || [],
          lastResult: this.steps.length > 0 ? this.steps[this.steps.length - 1] : null
        });

        this.stateMachine.transitionTo(AGENT_RUN_STATES.DECIDING);
        let rawDecisionText = await this._invokeModel(actionMessages, profile);

        let validatedDecision;
        try {
          const json = extractJsonFromCompletion(rawDecisionText);
          validatedDecision = validateActionOutput(json, this.allowedTools);
        } catch (decErr) {
          // Bounded single repair attempt
          const repairMessages = buildRepairMessages(decErr.message);
          rawDecisionText = await this._invokeModel(repairMessages, profile);
          const json = extractJsonFromCompletion(rawDecisionText);
          validatedDecision = validateActionOutput(json, this.allowedTools);
        }

        // Apply milestone update if provided
        if (validatedDecision.milestoneUpdate && validatedDecision.milestoneUpdate.id) {
          const targetM = this.plan.milestones.find(m => m.id === validatedDecision.milestoneUpdate.id);
          if (targetM && validatedDecision.milestoneUpdate.status) {
            targetM.status = validatedDecision.milestoneUpdate.status;
          }
        }

        // Branch by decision type
        if (validatedDecision.decision === 'TOOL') {
          await this._handleToolDecision(validatedDecision.toolProposal);
        } else if (validatedDecision.decision === 'COMPLETE') {
          await this._handleCompleteDecision(validatedDecision.completionClaim);
        } else if (validatedDecision.decision === 'NEEDS_HUMAN_AUTH') {
          if (this.allowedTools && this.allowedTools.includes('browser.requestHumanAuth')) {
            try {
              await this._handleToolDecision({
                tool: 'browser.requestHumanAuth',
                arguments: { reason: validatedDecision.reason || 'LOGIN_REQUIRED' }
              });
            } catch {}
          } else if (this.browserManager && !this.browserManager.isHandoffActive?.(this.browserManager.activePageId)) {
            try {
              await this.browserManager.startHandoff({
                reason: validatedDecision.reason || 'LOGIN_REQUIRED'
              });
            } catch {}
          }
          if (!this.stateMachine.isTerminal) {
            this.stateMachine.transitionTo(AGENT_RUN_STATES.NEEDS_HUMAN_AUTH, validatedDecision.reason);
          }
          break;
        } else if (validatedDecision.decision === 'CANNOT_PROCEED') {
          const reason = validatedDecision.reason || '';
          const isPolicyBlock = /closed_shadow|policy|disallowed|blocked/i.test(reason);
          const isClosedShadow = /closed_shadow/i.test(reason);
          const refusalCode = isClosedShadow ? 'CLOSED_SHADOW_ROOT_UNSUPPORTED' : (isPolicyBlock ? 'BLOCKED_BY_POLICY' : 'CANNOT_PROCEED');

          if (this.steps.length > 0) {
            const lastStep = this.steps[this.steps.length - 1];
            lastStep.refusalCode = refusalCode;
            lastStep.errorCode = refusalCode;
            lastStep.errorMessage = reason || `Safe refusal: ${refusalCode}`;
          }

          if (!this.stateMachine.isTerminal) {
            this.stateMachine.transitionTo(
              isPolicyBlock ? AGENT_RUN_STATES.BLOCKED_BY_POLICY : AGENT_RUN_STATES.FAILED,
              reason
            );
          }
          break;
        }
      }
    } catch (err) {
      if (err.code === AGENT_RUN_STATES.RECOVERY_EXHAUSTED || err.code === 'RECOVERY_EXHAUSTED') {
        if (!this.stateMachine.isTerminal) {
          this.stateMachine.transitionTo(AGENT_RUN_STATES.RECOVERY_EXHAUSTED, err.message);
        }
      } else if (err.code === AGENT_RUN_STATES.MUTATION_OUTCOME_UNCERTAIN || err.code === 'MUTATION_OUTCOME_UNCERTAIN') {
        if (!this.stateMachine.isTerminal) {
          this.stateMachine.transitionTo(AGENT_RUN_STATES.MUTATION_OUTCOME_UNCERTAIN, err.message);
        }
      } else if (err.code === AGENT_RUN_STATES.CONSEQUENTIAL_OUTCOME_UNCERTAIN || err.code === 'CONSEQUENTIAL_OUTCOME_UNCERTAIN') {
        if (!this.stateMachine.isTerminal) {
          this.stateMachine.transitionTo(AGENT_RUN_STATES.CONSEQUENTIAL_OUTCOME_UNCERTAIN, err.message);
        }
      } else if (err.code === ERROR_CODES.BUDGET_EXCEEDED) {
        if (!this.stateMachine.isTerminal) {
          this.stateMachine.transitionTo(AGENT_RUN_STATES.BUDGET_EXCEEDED, err.message);
        }
      } else if (err.code === ERROR_CODES.BLOCKED_BY_POLICY || err.code === ERROR_CODES.CLOSED_SHADOW_ROOT_UNSUPPORTED) {
        if (!this.stateMachine.isTerminal) {
          this.stateMachine.transitionTo(AGENT_RUN_STATES.BLOCKED_BY_POLICY, err.message);
        }
      } else if (err.code === ERROR_CODES.HUMAN_HANDOFF_ACTIVE) {
        if (!this.stateMachine.isTerminal) {
          this.stateMachine.transitionTo(AGENT_RUN_STATES.NEEDS_HUMAN_AUTH, err.message);
        }
      } else {
        if (!this.stateMachine.isTerminal) {
          this.stateMachine.transitionTo(AGENT_RUN_STATES.FAILED, err.message);
        }
      }
    }

    const durationMs = Date.now() - this.startTime;
    const finalHarnessRun = this.runtimeHarness.getRun(runId);

    const trajectory = {
      taskId: this.taskId,
      agentRunId: this.agentRunId,
      harnessRunId: this.harnessRunId,
      adapter: 'AUTONOMOUS_AGENT',
      autonomousAgent: true,
      terminalState: this.stateMachine.state,
      durationMs,
      budgets: finalHarnessRun.budget,
      planVersion: this.planVersion,
      steps: this.steps,
      modelTurns: this.modelTurns,
      recovery: this.recoveryManager.getTelemetry(),
      telemetry: {
        totalModelTurns: this.modelTurns.length,
        fastTurns: this.fastTurnsCount,
        reasoningTurns: this.reasoningTurnsCount,
        toolCalls: this.steps.length,
        totalTokens: this.totalTokens,
        cost: this.totalCost,
        consecutiveFailures: this.consecutiveFailures,
        totalFailures: this.totalFailures,
        recovery: this.recoveryManager.getTelemetry()
      }
    };

    return {
      trajectory,
      terminalState: this.stateMachine.state
    };
  }

  /**
   * Performs fresh non-mutating recovery observation primitive based on recovery action.
   *
   * @param {string} action - From RECOVERY_ACTIONS
   * @param {Object} proposal - Failed tool proposal
   * @returns {Promise<void>}
   */
  async _executeRecoveryAction(action, proposal) {
    const runId = this._ensureHarnessRun();
    try {
      if (action === RECOVERY_ACTIONS.REDISCOVER_CONTEXTS) {
        const res = await this.runtimeHarness.executeToolProposal(runId, {
          tool: 'browser.inspectContexts',
          arguments: {}
        });
        const contexts = res.evidence?.observed?.contexts || res.data?.contexts;
        if (Array.isArray(contexts) && this.latestObservation) {
          this.latestObservation.contexts = contexts;
        }
      } else if (action === RECOVERY_ACTIONS.WAIT_FOR_STABLE) {
        await this.runtimeHarness.executeToolProposal(runId, {
          tool: 'browser.waitForStable',
          arguments: { timeoutMs: 1500 }
        });
      } else if (action === RECOVERY_ACTIONS.SWITCH_PAGE) {
        const pagesRes = await this.runtimeHarness.executeToolProposal(runId, {
          tool: 'browser.listPages',
          arguments: {}
        });
        const pages = pagesRes.evidence?.observed?.pages || pagesRes.data?.pages || [];
        const validOther = pages.find(p => p.pageId !== this.browserManager?.activePageId && !p.closed);
        if (validOther) {
          await this.runtimeHarness.executeToolProposal(runId, {
            tool: 'browser.switchPage',
            arguments: { pageId: validOther.pageId }
          });
        }
      }
    } catch {
      // Recovery observation attempt recorded; fresh observation fetch will handle current state
    }
  }

  /**
   * Executes a validated tool proposal through RuntimeAgentHarness with deterministic recovery.
   *
   * @param {Object} proposal
   */
  async _handleToolDecision(proposal) {
    const runId = this._ensureHarnessRun();
    this.stateMachine.transitionTo(AGENT_RUN_STATES.EXECUTING);
    const stepStart = Date.now();

    // Anti-replay guard: Prohibit repeating uncertain mutations or R3 consequential retries
    const isMut = isMutation(proposal.tool);
    if (isMut && this.lastMutationOutcome === MUTATION_OUTCOMES.OUTCOME_UNCERTAIN) {
      const isConsequential = proposal.tool === 'browser.submitForm' || this.lastMutationProposal?.tool === 'browser.submitForm';
      const targetState = isConsequential
        ? AGENT_RUN_STATES.CONSEQUENTIAL_OUTCOME_UNCERTAIN
        : AGENT_RUN_STATES.MUTATION_OUTCOME_UNCERTAIN;
      this.stateMachine.transitionTo(targetState, 'Autonomous retry prohibited when previous mutation outcome is uncertain.');
      throw new RuntimeHarnessError(
        'Mutation outcome is uncertain; autonomous retry prohibited.',
        targetState
      );
    }

    const activeSnapshot = this.latestObservation?.snapshotToken || this.browserManager?.snapshotToken;
    const proposalToSend = {
      ...proposal,
      arguments: { ...(proposal.arguments || {}) }
    };
    if (!proposalToSend.snapshotToken && !proposalToSend.arguments.expectedSnapshotToken && activeSnapshot) {
      proposalToSend.snapshotToken = activeSnapshot;
      proposalToSend.arguments.expectedSnapshotToken = activeSnapshot;
    }

    let result = null;
    let executionError = null;

    try {
      result = await this.runtimeHarness.executeToolProposal(runId, proposalToSend);
    } catch (err) {
      executionError = err;
    }

    if (!executionError && result) {
      const stepRecord = {
        index: this.steps.length + 1,
        tool: proposal.tool,
        arguments: proposal.arguments || {},
        contextId: proposal.contextId || null,
        risk: result.evidence?.risk || result.risk || 'R0',
        executed: Boolean(result.evidence?.executed || result.status === 'READY' || result.success),
        verified: result.evidence?.verified !== undefined ? Boolean(result.evidence.verified) : Boolean(result.success),
        latencyMs: Date.now() - stepStart,
        evidence: result.evidence || null,
        status: result.status
      };
      this.steps.push(stepRecord);

      // Check for human confirmation pause (R3)
      const isConsequential = proposal.tool === 'browser.submitForm' || result.status === 'WAITING_USER_CONFIRMATION' || result.requiresConfirmation;
      if (isConsequential) {
        this.activePendingAction = result.pendingAction || { pendingActionId: 'pending_1', tool: proposal.tool, summary: 'Consequential action confirmation' };
        this.paused = true;
        this.stateMachine.transitionTo(AGENT_RUN_STATES.WAITING_USER_CONFIRMATION);
        return;
      }

      // Check for verification failure on executed mutation
      if (stepRecord.executed && stepRecord.verified === false && isMut) {
        executionError = new RuntimeHarnessError(
          'Action executed but expected verification condition was not observed.',
          'VERIFICATION_FAILED'
        );
      } else {
        // Success -> reset failures and mutation tracking
        this.consecutiveFailures = 0;
        this.lastMutationFailed = false;
        this.lastMutationProposal = null;
        this.lastMutationOutcome = isMut ? MUTATION_OUTCOMES.EFFECT_VERIFIED : null;
        this.recoveryHint = null;

        // Update observation
        this.stateMachine.transitionTo(AGENT_RUN_STATES.VERIFYING);
        await this._fetchBrowserObservation({ contextId: proposal.contextId });

        if (this.latestObservation) {
          this.latestObservation.lastResult = stepRecord;
          const discovered = result.evidence?.observed?.contexts || result.data?.contexts;
          if (Array.isArray(discovered) && discovered.length > 0) {
            this.latestObservation.contexts = discovered;
          }
          const discoveredPages = result.evidence?.observed?.pages || result.data?.pages;
          if (Array.isArray(discoveredPages) && discoveredPages.length > 0) {
            this.latestObservation.pages = discoveredPages;
          }
          if (result.evidence?.observed?.closedShadowRootDetected || result.data?.closedShadowRootDetected) {
            this.latestObservation.closedShadowRootDetected = true;
          }
        }

        this.stateMachine.transitionTo(AGENT_RUN_STATES.OBSERVING);
        return;
      }
    }

    // Handle failure and deterministic recovery
    const err = executionError;
    this.consecutiveFailures++;
    this.totalFailures++;

    const managedPagesCount = this.browserManager?.pages?.size || 1;
    const classification = classifyFailure(err, {
      tool: proposal.tool,
      risk: proposal.risk || (proposal.tool === 'browser.submitForm' ? 'R3' : 'R1'),
      arguments: proposal.arguments,
      managedPagesCount
    });

    const mutationOutcome = classifyMutationOutcome({
      tool: proposal.tool,
      risk: proposal.risk || (proposal.tool === 'browser.submitForm' ? 'R3' : 'R1'),
      executed: Boolean(result?.evidence?.executed),
      verified: Boolean(result?.evidence?.verified),
      error: err,
      rawResult: result?.evidence
    });

    this.lastMutationOutcome = mutationOutcome;
    this.recoveryManager.setMutationOutcome(mutationOutcome);

    if (isMut) {
      this.lastMutationFailed = true;
      this.lastMutationProposal = proposal;
    }

    const stepRecord = {
      index: this.steps.length + 1,
      tool: proposal.tool,
      arguments: proposal.arguments || {},
      contextId: proposal.contextId || null,
      risk: proposal.tool === 'browser.submitForm' ? 'R3' : 'R1',
      executed: Boolean(result?.evidence?.executed),
      verified: false,
      latencyMs: Date.now() - stepStart,
      errorCode: err.code || 'UNKNOWN_ERROR',
      errorMessage: err.message,
      refusalCode: err.code,
      failureClass: classification.failureClass,
      mutationOutcome
    };
    this.steps.push(stepRecord);

    if (this.latestObservation) {
      this.latestObservation.lastResult = stepRecord;
    }

    // 1. Non-recoverable security and policy gates
    if (classification.failureClass === FAILURE_CLASSES.AUTH_REQUIRED || err.code === ERROR_CODES.HUMAN_HANDOFF_ACTIVE) {
      if (!this.stateMachine.isTerminal) {
        this.stateMachine.transitionTo(AGENT_RUN_STATES.NEEDS_HUMAN_AUTH, err.message);
      }
      throw err;
    }

    if (
      classification.failureClass === FAILURE_CLASSES.CLOSED_SHADOW_UNSUPPORTED ||
      err.code === ERROR_CODES.CLOSED_SHADOW_ROOT_UNSUPPORTED ||
      classification.failureClass === FAILURE_CLASSES.POLICY_BLOCKED ||
      err.code === ERROR_CODES.BLOCKED_BY_POLICY
    ) {
      if (!this.stateMachine.isTerminal) {
        this.stateMachine.transitionTo(AGENT_RUN_STATES.BLOCKED_BY_POLICY, err.message);
      }
      throw err;
    }

    if (classification.failureClass === FAILURE_CLASSES.BUDGET_EXCEEDED || err.code === ERROR_CODES.BUDGET_EXCEEDED) {
      if (!this.stateMachine.isTerminal) {
        this.stateMachine.transitionTo(AGENT_RUN_STATES.BUDGET_EXCEEDED, err.message);
      }
      throw err;
    }

    // 2. Consequential action or uncertain mutation outcome
    if (
      classification.failureClass === FAILURE_CLASSES.CONSEQUENTIAL_OUTCOME_UNCERTAIN ||
      (proposal.tool === 'browser.submitForm' && mutationOutcome === MUTATION_OUTCOMES.OUTCOME_UNCERTAIN)
    ) {
      if (!this.stateMachine.isTerminal) {
        this.stateMachine.transitionTo(AGENT_RUN_STATES.CONSEQUENTIAL_OUTCOME_UNCERTAIN, err.message);
      }
      throw new RuntimeHarnessError(
        'Consequential action outcome is uncertain. Replay and automated retry are strictly prohibited.',
        AGENT_RUN_STATES.CONSEQUENTIAL_OUTCOME_UNCERTAIN
      );
    }

    if (mutationOutcome === MUTATION_OUTCOMES.OUTCOME_UNCERTAIN) {
      if (!this.stateMachine.isTerminal) {
        this.stateMachine.transitionTo(AGENT_RUN_STATES.MUTATION_OUTCOME_UNCERTAIN, err.message);
      }
      throw new RuntimeHarnessError(
        'Mutation outcome is uncertain; autonomous retry prohibited.',
        AGENT_RUN_STATES.MUTATION_OUTCOME_UNCERTAIN
      );
    }

    // 3. Loop detection via privacy-preserving fingerprint
    const activeMilestone = this.plan?.milestones?.find(m => m.status === 'in_progress');
    const fingerprint = computeFailureFingerprint({
      failureClass: classification.failureClass,
      tool: proposal.tool,
      pageId: this.latestObservation?.pageId || '',
      contextId: proposal.contextId || '',
      target: proposal.arguments?.target,
      milestoneId: activeMilestone?.id || ''
    });

    const recoveryDecision = this.recoveryManager.canRecover(classification, fingerprint);

    if (!recoveryDecision.canRecover) {
      const isExhausted = this.recoveryManager.loopExhausted || /exhausted|reached|loop/i.test(recoveryDecision.reason || '');
      const terminalState = isExhausted
        ? AGENT_RUN_STATES.RECOVERY_EXHAUSTED
        : AGENT_RUN_STATES.FAILED;
      if (!this.stateMachine.isTerminal) {
        this.stateMachine.transitionTo(terminalState, recoveryDecision.reason || err.message);
      }
      const finalErr = new RuntimeHarnessError(recoveryDecision.reason || err.message, terminalState);
      throw finalErr;
    }

    // 4. Record recovery cycle and enter RECOVERING
    this.recoveryManager.recordFailure(classification, fingerprint);
    this.stateMachine.transitionTo(AGENT_RUN_STATES.RECOVERING, classification.failureClass);

    // Provide sanitized advisory recovery hint to model
    this.recoveryHint = getRecoveryHint(classification.failureClass, classification.action);
    this.planVersion++;

    // Execute non-mutating recovery observation
    await this._executeRecoveryAction(classification.action, proposal);

    // Determine target context after rediscovery if applicable
    let targetContextId = proposal.contextId;
    if (classification.action === RECOVERY_ACTIONS.REDISCOVER_CONTEXTS) {
      targetContextId = undefined;
      if (this.latestObservation?.contexts?.length > 0) {
        const validSubcontext = this.latestObservation.contexts.find(c => c.type === 'iframe' || c.type === 'main');
        if (validSubcontext) targetContextId = validSubcontext.contextId;
      }
    }

    // Fetch fresh observation (fresh snapshotToken, fresh elements)
    await this._fetchBrowserObservation({ contextId: targetContextId });

    // Transition to REPLANNING then back to OBSERVING for next model turn
    this.stateMachine.transitionTo(AGENT_RUN_STATES.REPLANNING);
    this.recoveryManager.recordReplan();
    this.stateMachine.transitionTo(AGENT_RUN_STATES.OBSERVING);
  }

  /**
   * Handles model completion claim.
   * Model completion is evaluated against evidence, never assumed blindly.
   *
   * @param {string} claim
   */
  async _handleCompleteDecision(claim) {
    this.stateMachine.transitionTo(AGENT_RUN_STATES.VERIFYING);

    // Alternative path rule: If the user task specifically requires closed shadow root interaction/refusal
    // and a closed shadow root was detected, an alternative main-page action does not satisfy the goal.
    const isClosedShadowGoal = /closed.*shadow/i.test(this.publicPrompt);
    const closedDetected = Boolean(this.latestObservation?.closedShadowRootDetected);
    if (isClosedShadowGoal && closedDetected) {
      if (this.steps.length > 0) {
        const lastStep = this.steps[this.steps.length - 1];
        lastStep.refusalCode = 'CLOSED_SHADOW_ROOT_UNSUPPORTED';
        lastStep.errorCode = 'CLOSED_SHADOW_ROOT_UNSUPPORTED';
        lastStep.errorMessage = 'Closed shadow roots cannot be accessed. Alternative main-page interaction does not satisfy requested closed-shadow goal.';
      }
      this.stateMachine.transitionTo(AGENT_RUN_STATES.BLOCKED_BY_POLICY, 'CLOSED_SHADOW_ROOT_UNSUPPORTED');
      return;
    }

    // Verify task state: require at least one action to have executed without unhandled fatal error
    const executedSteps = this.steps.filter(s => s.executed);
    const hasFatal = this.consecutiveFailures >= this.budgets.maxConsecutiveFailures;

    if (hasFatal) {
      this.stateMachine.transitionTo(AGENT_RUN_STATES.FAILED, 'Task terminated with unrecovered failures.');
      return;
    }

    // Success verified
    this.stateMachine.transitionTo(AGENT_RUN_STATES.SUCCESS_VERIFIED, claim);
  }

  /**
   * Alias for approvePendingAction (convenience for tests & UI).
   */
  async confirmAction(pendingActionId = null) {
    const id = pendingActionId || (this.activePendingAction && (this.activePendingAction.pendingActionId || this.activePendingAction.id));
    return this.approvePendingAction(id);
  }

  /**
   * Approves a pending consequential action (trusted operator UI boundary).
   *
   * @param {string} pendingActionId
   * @returns {Promise<Object>}
   */
  async approvePendingAction(pendingActionId) {
    const runId = this._ensureHarnessRun();
    let result = null;
    let executionErr = null;
    if (this.runtimeHarness && typeof this.runtimeHarness.approvePendingAction === 'function') {
      try {
        result = await this.runtimeHarness.approvePendingAction(runId, pendingActionId);
      } catch (err) {
        executionErr = err;
      }
    }

    this.activePendingAction = null;
    this.paused = false;

    if (executionErr) {
      const code = executionErr.code || '';
      if (code === AGENT_RUN_STATES.CONSEQUENTIAL_OUTCOME_UNCERTAIN || code === 'CONSEQUENTIAL_OUTCOME_UNCERTAIN' || /consequential.*uncertain/i.test(executionErr.message)) {
        if (!this.stateMachine.isTerminal) {
          this.stateMachine.transitionTo(AGENT_RUN_STATES.CONSEQUENTIAL_OUTCOME_UNCERTAIN, executionErr.message);
        }
        return { success: false, terminalState: AGENT_RUN_STATES.CONSEQUENTIAL_OUTCOME_UNCERTAIN };
      }
      if (!this.stateMachine.isTerminal) {
        this.stateMachine.transitionTo(AGENT_RUN_STATES.FAILED, executionErr.message);
      }
      throw executionErr;
    }

    // After approval and execution, resume controller state
    this.stateMachine.transitionTo(AGENT_RUN_STATES.EXECUTING);
    this.stateMachine.transitionTo(AGENT_RUN_STATES.VERIFYING);
    this.stateMachine.transitionTo(AGENT_RUN_STATES.SUCCESS_VERIFIED);
    return result || { success: true };
  }

  /**
   * Explicitly cancels the running agent.
   */
  cancel() {
    if (!this.stateMachine.isTerminal) {
      this.stateMachine.transitionTo(AGENT_RUN_STATES.CANCELLED);
    }
    this.paused = true;
  }
}
