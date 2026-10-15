/**
 * Execution Budget & Accounting for JARVIS4 Runtime Agent Harness (PRE-040A).
 * Enforces non-negotiable finite step, time, mutation, and resource bounds per task run.
 *
 * Invariants:
 * - Budgets cannot be expanded or overridden by model proposals.
 * - Accounting occurs before or atomically with execution.
 * - Exceeding any budget halts execution immediately with BUDGET_EXCEEDED.
 */

import { RuntimeHarnessError, ERROR_CODES } from './runtimeErrors.js';
import { TOOL_CATEGORIES, RISK_LEVELS } from './toolRegistry.js';

function clamp(val, min, max, defaultVal) {
  if (val === undefined || val === null || val === '') return defaultVal;
  const num = Number(val);
  if (Number.isNaN(num)) return defaultVal;
  return Math.min(Math.max(num, min), max);
}

export class ExecutionBudget {
  /**
   * @param {Object} [options={}]
   */
  constructor(options = {}) {
    this.limits = Object.freeze({
      maxToolCalls: clamp(options.maxToolCalls, 1, 50, 15),
      maxModelTurns: clamp(options.maxModelTurns, 1, 20, 8),
      maxNavigations: clamp(options.maxNavigations, 1, 15, 4),
      maxMutations: clamp(options.maxMutations, 1, 30, 10),
      maxFormSubmissions: clamp(options.maxFormSubmissions, 1, 3, 1),
      maxUploads: clamp(options.maxUploads, 0, 5, 2),
      maxDownloads: clamp(options.maxDownloads, 0, 5, 2),
      maxConsecutiveFailures: clamp(options.maxConsecutiveFailures, 1, 5, 2),
      maxRuntimeMs: clamp(options.maxRuntimeMs, 1000, 300000, 60000),
      maxTokens: clamp(options.maxTokens, 1000, 100000, 25000)
    });

    this.counters = {
      toolCalls: 0,
      modelTurns: 0,
      navigations: 0,
      mutations: 0,
      formSubmissions: 0,
      uploads: 0,
      downloads: 0,
      consecutiveFailures: 0,
      totalFailures: 0,
      tokensUsed: 0,
      startedAt: Date.now()
    };
  }

  /**
   * Returns current elapsed milliseconds since run started.
   * @returns {number}
   */
  get elapsedMs() {
    return Math.max(0, Date.now() - this.counters.startedAt);
  }

  /**
   * Checks whether executing an action under the given category and risk
   * would exceed any configured budget limit.
   * Throws RuntimeHarnessError if breached.
   *
   * @param {string} category - TOOL_CATEGORIES enum
   * @param {string} risk - RISK_LEVELS enum
   * @param {Object} [details={}]
   */
  checkBudget(category, risk, details = {}) {
    // 1. Runtime elapsed check
    if (this.elapsedMs >= this.limits.maxRuntimeMs) {
      throw new RuntimeHarnessError(
        `Execution time limit of ${this.limits.maxRuntimeMs}ms exceeded (elapsed: ${this.elapsedMs}ms).`,
        ERROR_CODES.BUDGET_EXCEEDED,
        { budgetType: 'maxRuntimeMs', limit: this.limits.maxRuntimeMs, current: this.elapsedMs }
      );
    }

    // 2. Total tool calls limit
    if (this.counters.toolCalls + 1 > this.limits.maxToolCalls) {
      throw new RuntimeHarnessError(
        `Total tool calls limit of ${this.limits.maxToolCalls} exceeded.`,
        ERROR_CODES.BUDGET_EXCEEDED,
        { budgetType: 'maxToolCalls', limit: this.limits.maxToolCalls, current: this.counters.toolCalls }
      );
    }

    // 3. Consecutive failures check
    if (this.counters.consecutiveFailures >= this.limits.maxConsecutiveFailures) {
      throw new RuntimeHarnessError(
        `Consecutive failures limit of ${this.limits.maxConsecutiveFailures} reached.`,
        ERROR_CODES.BUDGET_EXCEEDED,
        { budgetType: 'maxConsecutiveFailures', limit: this.limits.maxConsecutiveFailures, current: this.counters.consecutiveFailures }
      );
    }

    // 4. Navigations limit
    if (category === TOOL_CATEGORIES.NAVIGATE && this.counters.navigations + 1 > this.limits.maxNavigations) {
      throw new RuntimeHarnessError(
        `Browser navigations limit of ${this.limits.maxNavigations} exceeded.`,
        ERROR_CODES.BUDGET_EXCEEDED,
        { budgetType: 'maxNavigations', limit: this.limits.maxNavigations, current: this.counters.navigations }
      );
    }

    // 5. In-page mutations limit
    if (category === TOOL_CATEGORIES.MUTATE && this.counters.mutations + 1 > this.limits.maxMutations) {
      throw new RuntimeHarnessError(
        `Browser mutations limit of ${this.limits.maxMutations} exceeded.`,
        ERROR_CODES.BUDGET_EXCEEDED,
        { budgetType: 'maxMutations', limit: this.limits.maxMutations, current: this.counters.mutations }
      );
    }

    // 6. Consequential form submissions limit
    if (category === TOOL_CATEGORIES.CONSEQUENTIAL && risk === RISK_LEVELS.R3) {
      if (this.counters.formSubmissions + 1 > this.limits.maxFormSubmissions) {
        throw new RuntimeHarnessError(
          `Form submissions limit of ${this.limits.maxFormSubmissions} per task exceeded.`,
          ERROR_CODES.BUDGET_EXCEEDED,
          { budgetType: 'maxFormSubmissions', limit: this.limits.maxFormSubmissions, current: this.counters.formSubmissions }
        );
      }
    }

    // 7. File transfer limits
    if (category === TOOL_CATEGORIES.TRANSFER) {
      if (details.transferType === 'upload' && this.counters.uploads + 1 > this.limits.maxUploads) {
        throw new RuntimeHarnessError(
          `Uploads limit of ${this.limits.maxUploads} exceeded.`,
          ERROR_CODES.BUDGET_EXCEEDED,
          { budgetType: 'maxUploads', limit: this.limits.maxUploads, current: this.counters.uploads }
        );
      }
      if (details.transferType === 'download' && this.counters.downloads + 1 > this.limits.maxDownloads) {
        throw new RuntimeHarnessError(
          `Downloads limit of ${this.limits.maxDownloads} exceeded.`,
          ERROR_CODES.BUDGET_EXCEEDED,
          { budgetType: 'maxDownloads', limit: this.limits.maxDownloads, current: this.counters.downloads }
        );
      }
    }
  }

  /**
   * Atomically records consumption of a tool call and updates counters.
   *
   * @param {string} category
   * @param {string} risk
   * @param {Object} [details={}]
   */
  consume(category, risk, details = {}) {
    this.counters.toolCalls++;

    if (category === TOOL_CATEGORIES.NAVIGATE) {
      this.counters.navigations++;
    } else if (category === TOOL_CATEGORIES.MUTATE) {
      this.counters.mutations++;
    } else if (category === TOOL_CATEGORIES.CONSEQUENTIAL && risk === RISK_LEVELS.R3) {
      this.counters.formSubmissions++;
    } else if (category === TOOL_CATEGORIES.TRANSFER) {
      if (details.transferType === 'upload') this.counters.uploads++;
      if (details.transferType === 'download') this.counters.downloads++;
    }

    if (typeof details.tokens === 'number') {
      this.counters.tokensUsed += details.tokens;
    }
  }

  /**
   * Alias for consume() accepting toolName string or details object.
   *
   * @param {string} category
   * @param {string} risk
   * @param {string|Object} [toolNameOrDetails={}]
   */
  recordExecution(category, risk, toolNameOrDetails = {}) {
    const details = typeof toolNameOrDetails === 'string' ? { toolName: toolNameOrDetails } : toolNameOrDetails;
    return this.consume(category, risk, details);
  }

  /**
   * Records a failed step or verification failure.
   */
  recordFailure() {
    this.counters.consecutiveFailures++;
    this.counters.totalFailures++;
  }

  /**
   * Records a successful execution and resets consecutive failure counter.
   */
  recordSuccess() {
    this.counters.consecutiveFailures = 0;
  }

  /**
   * Returns a safe snapshot of current limits and counter values.
   * @returns {Object}
   */
  getSnapshot() {
    return {
      limits: { ...this.limits },
      counters: { ...this.counters },
      elapsedMs: this.elapsedMs
    };
  }
}
