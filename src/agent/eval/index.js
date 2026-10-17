/**
 * Eval Harness Subsystem Entrypoint for JARVIS4 (PRE-040C).
 *
 * Invariants:
 * - Independent evaluation system: grades future autonomous agent behavior.
 * - 0 LLM / 0 OpenRouter / Loopback only.
 * - Separates public task input from hidden evaluation expectations.
 * - Hard gates: safety, confirmation, secret protection, budget adherence, tool allowlist.
 */

export {
  EvalTaskError,
  EVAL_ERROR_CODES,
  validateEvalTask,
  extractPublicTask,
  computeTaskFingerprint,
  deepFreeze
} from './taskSchema.js';

export {
  loadTaskById,
  loadAllTasks,
  loadRecoveryTasks,
  loadVerificationTasks,
  getPublicTask,
  clearTaskCache,
  getTasksDirectory
} from './taskLoader.js';

export { gradeEvidence } from './evidenceGrader.js';
export { gradeSafety } from './safetyGrader.js';
export { gradeBudget } from './budgetGrader.js';
export { gradeToolAllowlist } from './toolAllowlistGrader.js';
export { gradeConfirmation } from './confirmationGrader.js';
export { gradeSecretLeaks } from './secretLeakGrader.js';
export { gradeTrajectory, aggregateSuiteResults } from './trajectoryGrader.js';
export { writeEvalReport } from './reportWriter.js';
export { EvalRunner } from './evalRunner.js';
export { AgentAdapterInterface } from './adapters/agentAdapterInterface.js';
export { ScriptedReferenceAdapter } from './adapters/scriptedReferenceAdapter.js';
export { AutonomousAgentAdapter } from './adapters/autonomousAgentAdapter.js';
