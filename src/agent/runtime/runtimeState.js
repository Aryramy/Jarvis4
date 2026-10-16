/**
 * Runtime Agent State Machine for JARVIS4 (PRE-040A).
 * Governs finite execution states and validates legal transitions.
 *
 * Invariants:
 * - Deterministic, finite states.
 * - Illegal transitions fail closed with INVALID_STATE_TRANSITION.
 * - Terminal states cannot be transitioned out of.
 */

import { RuntimeHarnessError, ERROR_CODES } from './runtimeErrors.js';

export const RUN_STATES = Object.freeze({
  RECEIVED: 'RECEIVED',
  READY: 'READY',
  TOOL_PROPOSED: 'TOOL_PROPOSED',
  VALIDATING: 'VALIDATING',
  WAITING_USER_CONFIRMATION: 'WAITING_USER_CONFIRMATION',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  OBSERVING: 'OBSERVING',
  SUCCESS_VERIFIED: 'SUCCESS_VERIFIED',
  NEEDS_HUMAN_AUTH: 'NEEDS_HUMAN_AUTH',
  BLOCKED_BY_POLICY: 'BLOCKED_BY_POLICY',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  TOOL_FAILURE: 'TOOL_FAILURE',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  CANCELLED: 'CANCELLED'
});

export const TERMINAL_STATES = Object.freeze(new Set([
  RUN_STATES.SUCCESS_VERIFIED,
  RUN_STATES.NEEDS_HUMAN_AUTH,
  RUN_STATES.BLOCKED_BY_POLICY,
  RUN_STATES.BUDGET_EXCEEDED,
  RUN_STATES.TOOL_FAILURE,
  RUN_STATES.VERIFICATION_FAILED,
  RUN_STATES.CANCELLED
]));

/**
 * Valid state transitions lookup table.
 */
const VALID_TRANSITIONS = Object.freeze({
  [RUN_STATES.RECEIVED]: new Set([
    RUN_STATES.READY,
    RUN_STATES.CANCELLED
  ]),
  [RUN_STATES.READY]: new Set([
    RUN_STATES.TOOL_PROPOSED,
    RUN_STATES.SUCCESS_VERIFIED,
    RUN_STATES.CANCELLED,
    RUN_STATES.BUDGET_EXCEEDED
  ]),
  [RUN_STATES.TOOL_PROPOSED]: new Set([
    RUN_STATES.VALIDATING,
    RUN_STATES.BLOCKED_BY_POLICY,
    RUN_STATES.TOOL_FAILURE,
    RUN_STATES.CANCELLED
  ]),
  [RUN_STATES.VALIDATING]: new Set([
    RUN_STATES.WAITING_USER_CONFIRMATION,
    RUN_STATES.EXECUTING,
    RUN_STATES.NEEDS_HUMAN_AUTH,
    RUN_STATES.BLOCKED_BY_POLICY,
    RUN_STATES.BUDGET_EXCEEDED,
    RUN_STATES.TOOL_FAILURE,
    RUN_STATES.CANCELLED
  ]),
  [RUN_STATES.WAITING_USER_CONFIRMATION]: new Set([
    RUN_STATES.EXECUTING,
    RUN_STATES.CANCELLED
  ]),
  [RUN_STATES.EXECUTING]: new Set([
    RUN_STATES.VERIFYING,
    RUN_STATES.OBSERVING,
    RUN_STATES.NEEDS_HUMAN_AUTH,
    RUN_STATES.TOOL_FAILURE,
    RUN_STATES.CANCELLED
  ]),
  [RUN_STATES.VERIFYING]: new Set([
    RUN_STATES.OBSERVING,
    RUN_STATES.VERIFICATION_FAILED,
    RUN_STATES.TOOL_FAILURE,
    RUN_STATES.CANCELLED
  ]),
  [RUN_STATES.OBSERVING]: new Set([
    RUN_STATES.READY,
    RUN_STATES.TOOL_PROPOSED,
    RUN_STATES.SUCCESS_VERIFIED,
    RUN_STATES.CANCELLED,
    RUN_STATES.BUDGET_EXCEEDED
  ])
});

export class RuntimeStateMachine {
  /**
   * @param {string} [initialState=RUN_STATES.RECEIVED]
   */
  constructor(initialState = RUN_STATES.RECEIVED) {
    if (!RUN_STATES[initialState]) {
      throw new RuntimeHarnessError(`Unknown initial state: "${initialState}"`, ERROR_CODES.INVALID_STATE_TRANSITION);
    }
    this._state = initialState;
    this._history = [{ state: initialState, timestamp: Date.now() }];
  }

  get state() {
    return this._state;
  }

  get isTerminal() {
    return TERMINAL_STATES.has(this._state);
  }

  get history() {
    return [...this._history];
  }

  /**
   * Transitions machine to next state if valid.
   * Throws RuntimeHarnessError on illegal transition.
   *
   * @param {string} nextState - Target RUN_STATES
   * @param {Object} [metadata={}]
   * @returns {string} The new state
   */
  transitionTo(nextState, metadata = {}) {
    if (!RUN_STATES[nextState]) {
      throw new RuntimeHarnessError(`Unknown target state: "${nextState}"`, ERROR_CODES.INVALID_STATE_TRANSITION);
    }

    if (this.isTerminal) {
      throw new RuntimeHarnessError(
        `Cannot transition from terminal state "${this._state}" to "${nextState}".`,
        ERROR_CODES.RUN_ALREADY_TERMINATED,
        { current: this._state, next: nextState }
      );
    }

    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed || !allowed.has(nextState)) {
      throw new RuntimeHarnessError(
        `Illegal state transition from "${this._state}" to "${nextState}".`,
        ERROR_CODES.INVALID_STATE_TRANSITION,
        { current: this._state, next: nextState }
      );
    }

    this._state = nextState;
    this._history.push({ state: nextState, timestamp: Date.now(), metadata });
    return this._state;
  }
}
