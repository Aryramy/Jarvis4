/**
 * Autonomous Agent Run State Machine for JARVIS4 (BRICK-040).
 * Governs the multi-step autonomous planning, execution, and verification states.
 *
 * Invariants:
 * - Deterministic, finite states.
 * - Illegal transitions fail closed with INVALID_STATE_TRANSITION.
 * - Terminal states cannot be transitioned out of.
 * - Aligned with Runtime Agent Harness states without conflicting state machines.
 */

import { RuntimeHarnessError, ERROR_CODES } from '../runtime/runtimeErrors.js';

export const AGENT_RUN_STATES = Object.freeze({
  RECEIVED: 'RECEIVED',
  PLANNING: 'PLANNING',
  OBSERVING: 'OBSERVING',
  DECIDING: 'DECIDING',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  WAITING_USER_CONFIRMATION: 'WAITING_USER_CONFIRMATION',
  NEEDS_HUMAN_AUTH: 'NEEDS_HUMAN_AUTH',
  REPLANNING: 'REPLANNING',
  SUCCESS_VERIFIED: 'SUCCESS_VERIFIED',
  BLOCKED_BY_POLICY: 'BLOCKED_BY_POLICY',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TASK_UNSUPPORTED: 'TASK_UNSUPPORTED'
});

export const AGENT_TERMINAL_STATES = Object.freeze(new Set([
  AGENT_RUN_STATES.SUCCESS_VERIFIED,
  AGENT_RUN_STATES.BLOCKED_BY_POLICY,
  AGENT_RUN_STATES.BUDGET_EXCEEDED,
  AGENT_RUN_STATES.FAILED,
  AGENT_RUN_STATES.CANCELLED,
  AGENT_RUN_STATES.TASK_UNSUPPORTED
]));

const VALID_AGENT_TRANSITIONS = Object.freeze({
  [AGENT_RUN_STATES.RECEIVED]: new Set([
    AGENT_RUN_STATES.PLANNING,
    AGENT_RUN_STATES.OBSERVING,
    AGENT_RUN_STATES.CANCELLED,
    AGENT_RUN_STATES.FAILED
  ]),
  [AGENT_RUN_STATES.PLANNING]: new Set([
    AGENT_RUN_STATES.OBSERVING,
    AGENT_RUN_STATES.DECIDING,
    AGENT_RUN_STATES.BUDGET_EXCEEDED,
    AGENT_RUN_STATES.CANCELLED,
    AGENT_RUN_STATES.FAILED
  ]),
  [AGENT_RUN_STATES.OBSERVING]: new Set([
    AGENT_RUN_STATES.DECIDING,
    AGENT_RUN_STATES.REPLANNING,
    AGENT_RUN_STATES.SUCCESS_VERIFIED,
    AGENT_RUN_STATES.NEEDS_HUMAN_AUTH,
    AGENT_RUN_STATES.BUDGET_EXCEEDED,
    AGENT_RUN_STATES.CANCELLED,
    AGENT_RUN_STATES.FAILED
  ]),
  [AGENT_RUN_STATES.DECIDING]: new Set([
    AGENT_RUN_STATES.EXECUTING,
    AGENT_RUN_STATES.VERIFYING,
    AGENT_RUN_STATES.WAITING_USER_CONFIRMATION,
    AGENT_RUN_STATES.NEEDS_HUMAN_AUTH,
    AGENT_RUN_STATES.OBSERVING,
    AGENT_RUN_STATES.REPLANNING,
    AGENT_RUN_STATES.SUCCESS_VERIFIED,
    AGENT_RUN_STATES.BLOCKED_BY_POLICY,
    AGENT_RUN_STATES.BUDGET_EXCEEDED,
    AGENT_RUN_STATES.CANCELLED,
    AGENT_RUN_STATES.FAILED,
    AGENT_RUN_STATES.TASK_UNSUPPORTED
  ]),
  [AGENT_RUN_STATES.EXECUTING]: new Set([
    AGENT_RUN_STATES.VERIFYING,
    AGENT_RUN_STATES.OBSERVING,
    AGENT_RUN_STATES.REPLANNING,
    AGENT_RUN_STATES.WAITING_USER_CONFIRMATION,
    AGENT_RUN_STATES.NEEDS_HUMAN_AUTH,
    AGENT_RUN_STATES.BLOCKED_BY_POLICY,
    AGENT_RUN_STATES.BUDGET_EXCEEDED,
    AGENT_RUN_STATES.CANCELLED,
    AGENT_RUN_STATES.FAILED
  ]),
  [AGENT_RUN_STATES.VERIFYING]: new Set([
    AGENT_RUN_STATES.OBSERVING,
    AGENT_RUN_STATES.REPLANNING,
    AGENT_RUN_STATES.SUCCESS_VERIFIED,
    AGENT_RUN_STATES.BLOCKED_BY_POLICY,
    AGENT_RUN_STATES.DECIDING,
    AGENT_RUN_STATES.BUDGET_EXCEEDED,
    AGENT_RUN_STATES.CANCELLED,
    AGENT_RUN_STATES.FAILED
  ]),
  [AGENT_RUN_STATES.WAITING_USER_CONFIRMATION]: new Set([
    AGENT_RUN_STATES.EXECUTING,
    AGENT_RUN_STATES.OBSERVING,
    AGENT_RUN_STATES.REPLANNING,
    AGENT_RUN_STATES.CANCELLED,
    AGENT_RUN_STATES.FAILED
  ]),
  [AGENT_RUN_STATES.NEEDS_HUMAN_AUTH]: new Set([
    AGENT_RUN_STATES.OBSERVING,
    AGENT_RUN_STATES.DECIDING,
    AGENT_RUN_STATES.CANCELLED,
    AGENT_RUN_STATES.FAILED
  ]),
  [AGENT_RUN_STATES.REPLANNING]: new Set([
    AGENT_RUN_STATES.DECIDING,
    AGENT_RUN_STATES.OBSERVING,
    AGENT_RUN_STATES.BUDGET_EXCEEDED,
    AGENT_RUN_STATES.CANCELLED,
    AGENT_RUN_STATES.FAILED
  ])
});

export class AgentStateError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Object} [details=null]
   */
  constructor(message, code = 'AGENT_STATE_ERROR', details = null) {
    super(message);
    this.name = 'AgentStateError';
    this.code = code;
    this.details = details;
  }
}

export class AgentRunStateMachine {
  /**
   * @param {string} [initialState=AGENT_RUN_STATES.RECEIVED]
   */
  constructor(initialState = AGENT_RUN_STATES.RECEIVED) {
    if (!AGENT_RUN_STATES[initialState]) {
      throw new AgentStateError(
        `Invalid initial agent run state: "${initialState}".`,
        'AGENT_INVALID_STATE_TRANSITION'
      );
    }
    this._state = initialState;
    this._history = [{ state: initialState, reason: 'init', timestamp: new Date().toISOString() }];
  }

  get state() {
    return this._state;
  }

  get isTerminal() {
    return AGENT_TERMINAL_STATES.has(this._state);
  }

  get history() {
    return Object.freeze([...this._history]);
  }

  /**
   * Alias for transitionTo.
   */
  transition(targetState, reason = '') {
    return this.transitionTo(targetState, reason);
  }

  /**
   * Transitions to target state with validation.
   *
   * @param {string} targetState
   * @param {string} [reason]
   * @returns {string} New state
   */
  transitionTo(targetState, reason = '') {
    if (this.isTerminal) {
      throw new AgentStateError(
        `Cannot transition out of terminal agent state "${this._state}" to "${targetState}".`,
        'AGENT_TERMINAL_STATE_LOCKED'
      );
    }

    if (!AGENT_RUN_STATES[targetState]) {
      throw new AgentStateError(
        `Target state "${targetState}" is not a recognized agent state.`,
        'AGENT_INVALID_STATE_TRANSITION'
      );
    }

    const validTargets = VALID_AGENT_TRANSITIONS[this._state];
    if (!validTargets || !validTargets.has(targetState)) {
      throw new AgentStateError(
        `Illegal agent state transition from "${this._state}" to "${targetState}".`,
        'AGENT_INVALID_STATE_TRANSITION',
        { from: this._state, to: targetState, reason }
      );
    }

    this._state = targetState;
    this._history.push({ state: targetState, reason, timestamp: new Date().toISOString() });
    return this._state;
  }
}
