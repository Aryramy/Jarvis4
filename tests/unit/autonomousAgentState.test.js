/**
 * Unit Tests for Autonomous Agent State Machine (BRICK-040).
 *
 * Scope:
 * - 100% offline, deterministic tests.
 * - Validates AgentRunStateMachine, transitions, terminal states, and invalid transition handling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRunStateMachine,
  AGENT_RUN_STATES,
  AGENT_TERMINAL_STATES,
  AgentStateError
} from '../../src/agent/autonomous/agentState.js';

describe('Autonomous Agent State Machine Tests', () => {
  it('initializes in default RECEIVED state', () => {
    const sm = new AgentRunStateMachine();
    assert.equal(sm.state, AGENT_RUN_STATES.RECEIVED);
    assert.equal(sm.isTerminal, false);
    assert.equal(sm.history.length, 1);
    assert.equal(sm.history[0].state, AGENT_RUN_STATES.RECEIVED);
  });

  it('allows valid state progression: RECEIVED -> PLANNING -> OBSERVING -> DECIDING -> EXECUTING -> VERIFYING -> SUCCESS_VERIFIED', () => {
    const sm = new AgentRunStateMachine();

    assert.equal(sm.transition(AGENT_RUN_STATES.PLANNING), AGENT_RUN_STATES.PLANNING);
    assert.equal(sm.transition(AGENT_RUN_STATES.OBSERVING), AGENT_RUN_STATES.OBSERVING);
    assert.equal(sm.transition(AGENT_RUN_STATES.DECIDING), AGENT_RUN_STATES.DECIDING);
    assert.equal(sm.transition(AGENT_RUN_STATES.EXECUTING), AGENT_RUN_STATES.EXECUTING);
    assert.equal(sm.transition(AGENT_RUN_STATES.VERIFYING), AGENT_RUN_STATES.VERIFYING);
    assert.equal(sm.transition(AGENT_RUN_STATES.SUCCESS_VERIFIED), AGENT_RUN_STATES.SUCCESS_VERIFIED);

    assert.equal(sm.isTerminal, true);
    assert.equal(sm.state, AGENT_RUN_STATES.SUCCESS_VERIFIED);
  });

  it('handles pause states: WAITING_USER_CONFIRMATION and NEEDS_HUMAN_AUTH', () => {
    const sm1 = new AgentRunStateMachine(AGENT_RUN_STATES.EXECUTING);
    assert.equal(sm1.transition(AGENT_RUN_STATES.WAITING_USER_CONFIRMATION), AGENT_RUN_STATES.WAITING_USER_CONFIRMATION);
    assert.equal(sm1.isTerminal, false);
    // Can resume back to EXECUTING or OBSERVING
    assert.equal(sm1.transition(AGENT_RUN_STATES.EXECUTING), AGENT_RUN_STATES.EXECUTING);

    const sm2 = new AgentRunStateMachine(AGENT_RUN_STATES.OBSERVING);
    assert.equal(sm2.transition(AGENT_RUN_STATES.NEEDS_HUMAN_AUTH), AGENT_RUN_STATES.NEEDS_HUMAN_AUTH);
    assert.equal(sm2.isTerminal, false);
    // Can resume back to OBSERVING
    assert.equal(sm2.transition(AGENT_RUN_STATES.OBSERVING), AGENT_RUN_STATES.OBSERVING);
  });

  it('handles replanning loop: VERIFYING -> REPLANNING -> OBSERVING', () => {
    const sm = new AgentRunStateMachine(AGENT_RUN_STATES.VERIFYING);
    assert.equal(sm.transition(AGENT_RUN_STATES.REPLANNING), AGENT_RUN_STATES.REPLANNING);
    assert.equal(sm.transition(AGENT_RUN_STATES.OBSERVING), AGENT_RUN_STATES.OBSERVING);
  });

  it('rejects invalid transitions and throws AgentStateError', () => {
    const sm = new AgentRunStateMachine(AGENT_RUN_STATES.RECEIVED);
    assert.throws(
      () => sm.transition(AGENT_RUN_STATES.EXECUTING),
      (err) => err instanceof AgentStateError && err.code === 'AGENT_INVALID_STATE_TRANSITION'
    );
  });

  it('prevents transitioning out of terminal states', () => {
    for (const termState of Object.values(AGENT_TERMINAL_STATES)) {
      const sm = new AgentRunStateMachine(termState);
      assert.equal(sm.isTerminal, true);
      assert.throws(
        () => sm.transition(AGENT_RUN_STATES.OBSERVING),
        (err) => err instanceof AgentStateError && err.code === 'AGENT_TERMINAL_STATE_LOCKED'
      );
    }
  });

  it('records reason and timestamp in transition history', () => {
    const sm = new AgentRunStateMachine(AGENT_RUN_STATES.RECEIVED);
    sm.transition(AGENT_RUN_STATES.PLANNING, 'Initial user request');
    const lastEntry = sm.history[sm.history.length - 1];
    assert.equal(lastEntry.state, AGENT_RUN_STATES.PLANNING);
    assert.equal(lastEntry.reason, 'Initial user request');
    assert.ok(typeof lastEntry.timestamp === 'string');
  });
});
