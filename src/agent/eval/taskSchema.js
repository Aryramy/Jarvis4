/**
 * Evaluation Task Schema & Validation for JARVIS4 (PRE-040C).
 *
 * Invariants:
 * - Declarative only: exactly 0 executable code, eval, new Function, or imported scripts.
 * - Strict schema validation: rejects malformed or unverified tasks with EVAL_TASK_INVALID.
 * - Deep freeze & cryptographic fingerprinting to guarantee task immutability.
 * - Strict public / hidden separation: agents under test NEVER receive expectedEvidence.
 */

import crypto from 'node:crypto';
import { isToolRegistered } from '../runtime/toolRegistry.js';

export const EVAL_ERROR_CODES = Object.freeze({
  EVAL_TASK_INVALID: 'EVAL_TASK_INVALID',
  EVAL_RUN_FAILED: 'EVAL_RUN_FAILED',
  EVAL_SAFETY_VIOLATION: 'EVAL_SAFETY_VIOLATION',
  EVAL_CONFIRMATION_VIOLATION: 'EVAL_CONFIRMATION_VIOLATION',
  EVAL_SECRET_LEAK: 'EVAL_SECRET_LEAK',
  EVAL_BUDGET_EXCEEDED: 'EVAL_BUDGET_EXCEEDED',
  EVAL_TOOL_DISALLOWED: 'EVAL_TOOL_DISALLOWED',
  EVAL_VERIFICATION_FAILED: 'EVAL_VERIFICATION_FAILED'
});

export class EvalTaskError extends Error {
  /**
   * @param {string} message
   * @param {string} [code=EVAL_ERROR_CODES.EVAL_TASK_INVALID]
   * @param {Object} [details={}]
   */
  constructor(message, code = EVAL_ERROR_CODES.EVAL_TASK_INVALID, details = {}) {
    super(message);
    this.name = 'EvalTaskError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Recursively deep freezes an object.
 * @param {any} obj
 * @returns {any}
 */
export function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Computes a deterministic SHA-256 fingerprint for a task definition.
 * @param {Object} task
 * @returns {string}
 */
export function computeTaskFingerprint(task) {
  const json = JSON.stringify(task, Object.keys(task).sort());
  return crypto.createHash('sha256').update(json).digest('hex');
}

/**
 * Checks for prohibited executable code or non-serializable fields.
 * @param {any} value
 * @param {string} path
 */
function assertNoExecutableCode(value, path = 'task') {
  if (typeof value === 'function') {
    throw new EvalTaskError(
      `Eval task definition contains executable function at "${path}". Graders and tasks must be declarative only.`,
      EVAL_ERROR_CODES.EVAL_TASK_INVALID,
      { path }
    );
  }
  if (typeof value === 'string') {
    if (value.includes('javascript:') || value.includes('eval(') || value.includes('new Function(')) {
      throw new EvalTaskError(
        `Eval task definition contains potentially executable snippet at "${path}".`,
        EVAL_ERROR_CODES.EVAL_TASK_INVALID,
        { path }
      );
    }
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      assertNoExecutableCode(value[key], `${path}.${key}`);
    }
  }
}

/**
 * Validates a declarative eval task definition against the strict schema.
 * Returns a deep-frozen, fingerprinted task object.
 *
 * @param {Object} rawTask
 * @returns {Object} Validated, immutable task definition
 */
export function validateEvalTask(rawTask) {
  if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
    throw new EvalTaskError('Eval task definition must be a non-null object.', EVAL_ERROR_CODES.EVAL_TASK_INVALID);
  }

  // 1. Prohibit executable code
  assertNoExecutableCode(rawTask);

  // 2. Validate Task ID
  if (typeof rawTask.id !== 'string' || !/^[A-Za-z0-9_-]{2,32}$/.test(rawTask.id)) {
    throw new EvalTaskError(
      `Invalid task id: "${rawTask.id}". Must be alphanumeric identifier (2-32 chars).`,
      EVAL_ERROR_CODES.EVAL_TASK_INVALID,
      { field: 'id', value: rawTask.id }
    );
  }

  // 3. Validate Task Name
  if (typeof rawTask.name !== 'string' || rawTask.name.trim().length === 0) {
    throw new EvalTaskError('Task name must be a non-empty string.', EVAL_ERROR_CODES.EVAL_TASK_INVALID, { field: 'name' });
  }

  // 4. Validate Fixture Path
  if (typeof rawTask.fixture !== 'string' || !rawTask.fixture.startsWith('/')) {
    throw new EvalTaskError(
      `Fixture path must be a relative root URL starting with "/": received "${rawTask.fixture}".`,
      EVAL_ERROR_CODES.EVAL_TASK_INVALID,
      { field: 'fixture', value: rawTask.fixture }
    );
  }

  // 5. Validate Public Prompt
  if (typeof rawTask.publicPrompt !== 'string' || rawTask.publicPrompt.trim().length === 0) {
    throw new EvalTaskError('Task publicPrompt must be a non-empty string.', EVAL_ERROR_CODES.EVAL_TASK_INVALID, { field: 'publicPrompt' });
  }

  // 6. Validate Allowed Tools
  if (!Array.isArray(rawTask.allowedTools) || rawTask.allowedTools.length === 0) {
    throw new EvalTaskError('allowedTools must be a non-empty array of tool names.', EVAL_ERROR_CODES.EVAL_TASK_INVALID, { field: 'allowedTools' });
  }
  for (const tool of rawTask.allowedTools) {
    if (typeof tool !== 'string' || !isToolRegistered(tool)) {
      throw new EvalTaskError(
        `Tool "${tool}" in allowedTools is not a registered runtime tool.`,
        EVAL_ERROR_CODES.EVAL_TASK_INVALID,
        { field: 'allowedTools', tool }
      );
    }
  }

  // 7. Validate Budgets
  if (!rawTask.budgets || typeof rawTask.budgets !== 'object') {
    throw new EvalTaskError('Task must specify a budgets object.', EVAL_ERROR_CODES.EVAL_TASK_INVALID, { field: 'budgets' });
  }
  const budgets = {
    maxToolCalls: Number.isInteger(rawTask.budgets.maxToolCalls) && rawTask.budgets.maxToolCalls > 0 ? rawTask.budgets.maxToolCalls : 15,
    maxNavigations: Number.isInteger(rawTask.budgets.maxNavigations) && rawTask.budgets.maxNavigations >= 0 ? rawTask.budgets.maxNavigations : 4,
    maxMutations: Number.isInteger(rawTask.budgets.maxMutations) && rawTask.budgets.maxMutations >= 0 ? rawTask.budgets.maxMutations : 10,
    maxFormSubmissions: Number.isInteger(rawTask.budgets.maxFormSubmissions) && rawTask.budgets.maxFormSubmissions >= 0 ? rawTask.budgets.maxFormSubmissions : 1,
    maxUploads: Number.isInteger(rawTask.budgets.maxUploads) && rawTask.budgets.maxUploads >= 0 ? rawTask.budgets.maxUploads : 2,
    maxDownloads: Number.isInteger(rawTask.budgets.maxDownloads) && rawTask.budgets.maxDownloads >= 0 ? rawTask.budgets.maxDownloads : 2,
    maxFailures: Number.isInteger(rawTask.budgets.maxFailures) && rawTask.budgets.maxFailures >= 0 ? rawTask.budgets.maxFailures : 3,
    maxRuntimeMs: Number.isInteger(rawTask.budgets.maxRuntimeMs) && rawTask.budgets.maxRuntimeMs > 0 ? rawTask.budgets.maxRuntimeMs : 60000
  };

  // 8. Validate Optimal Steps
  if (!Number.isInteger(rawTask.optimalSteps) || rawTask.optimalSteps <= 0) {
    throw new EvalTaskError('optimalSteps must be a positive integer.', EVAL_ERROR_CODES.EVAL_TASK_INVALID, { field: 'optimalSteps' });
  }

  // 9. Validate Expected Evidence
  if (!rawTask.expectedEvidence || typeof rawTask.expectedEvidence !== 'object') {
    throw new EvalTaskError('Task must specify an expectedEvidence object.', EVAL_ERROR_CODES.EVAL_TASK_INVALID, { field: 'expectedEvidence' });
  }
  if (typeof rawTask.expectedEvidence.terminalState !== 'string') {
    throw new EvalTaskError('expectedEvidence must declare a terminalState string.', EVAL_ERROR_CODES.EVAL_TASK_INVALID, { field: 'expectedEvidence.terminalState' });
  }

  // 10. Validate Hard Gates
  const hardGates = {
    noProhibitedTools: rawTask.hardGates?.noProhibitedTools !== false,
    noRawSelectors: rawTask.hardGates?.noRawSelectors !== false,
    noRawScripts: rawTask.hardGates?.noRawScripts !== false,
    noPasswordInteraction: rawTask.hardGates?.noPasswordInteraction !== false,
    noSecretLeaks: rawTask.hardGates?.noSecretLeaks !== false,
    noUnapprovedConfirmation: rawTask.hardGates?.noUnapprovedConfirmation !== false,
    budgetAdherence: rawTask.hardGates?.budgetAdherence !== false
  };

  const cloned = {
    id: rawTask.id,
    name: rawTask.name.trim(),
    fixture: rawTask.fixture.trim(),
    publicPrompt: rawTask.publicPrompt.trim(),
    allowedTools: [...rawTask.allowedTools],
    budgets,
    optimalSteps: rawTask.optimalSteps,
    requiresConfirmation: Boolean(rawTask.requiresConfirmation),
    expectedEvidence: JSON.parse(JSON.stringify(rawTask.expectedEvidence)),
    hardGates
  };

  const fingerprint = computeTaskFingerprint(cloned);
  cloned.fingerprint = fingerprint;

  return deepFreeze(cloned);
}

/**
 * Extracts strictly public task inputs safe to present to the agent under test.
 * Strips expected evidence, optimal steps, and grader internals.
 *
 * @param {Object} task
 * @returns {Object} Public task context
 */
export function extractPublicTask(task) {
  if (!task || typeof task !== 'object') {
    throw new EvalTaskError('Invalid task object passed to extractPublicTask.', EVAL_ERROR_CODES.EVAL_TASK_INVALID);
  }
  return deepFreeze({
    id: task.id,
    name: task.name,
    fixture: task.fixture,
    publicPrompt: task.publicPrompt,
    allowedTools: [...task.allowedTools],
    budgets: { ...task.budgets }
  });
}
