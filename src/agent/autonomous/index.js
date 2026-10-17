/**
 * Autonomous Browser Agent Subsystem for JARVIS4 (BRICK-040).
 * Exports the controller, state machine, output validator, and planner.
 */

export { AgentController, CONTROLLER_DEFAULTS } from './agentController.js';
export { AgentRunStateMachine, AGENT_RUN_STATES, AGENT_TERMINAL_STATES } from './agentState.js';
export {
  extractJsonFromCompletion,
  validatePlanOutput,
  validateActionOutput,
  AGENT_VALIDATION_ERRORS
} from './outputValidator.js';
export {
  buildSystemPrompt,
  compactObservation,
  buildPlanningMessages,
  buildActionMessages,
  buildRepairMessages
} from './agentPlanner.js';
export {
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
export {
  TRUST_LEVELS,
  VERIFICATION_CRITERIA_TYPES,
  VERIFICATION_OUTCOMES,
  VERIFICATION_BUDGET_DEFAULTS,
  EvidenceLedger,
  VerificationContract,
  VerificationEngine,
  deriveVerificationContract,
  sanitizeEvidenceValue
} from './verificationPolicy.js';
