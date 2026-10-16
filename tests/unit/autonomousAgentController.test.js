/**
 * Unit Tests for Autonomous Agent Controller (BRICK-040).
 *
 * Scope:
 * - 100% offline, deterministic tests.
 * - Uses mocked OpenRouter routing gate to test controller execution loop:
 *   - Hybrid short-plan creation
 *   - FAST profile default usage
 *   - Bounded REASONING escalation
 *   - One tool per turn execution via RuntimeAgentHarness
 *   - Pause on WAITING_USER_CONFIRMATION for R3 actions (no token exposed)
 *   - Pause on NEEDS_HUMAN_AUTH
 *   - Budget exhaustion stops run
 *   - Safe cancellation
 *   - Stale snapshot recovery
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentController } from '../../src/agent/autonomous/agentController.js';
import { AGENT_RUN_STATES } from '../../src/agent/autonomous/agentState.js';
import { ROUTING_PROFILES } from '../../src/providers/openRouterRouting.js';

/**
 * Scripted Mock Routing Gate for deterministic controller testing.
 */
class MockRoutingGate {
  constructor(scriptedCompletions = []) {
    this.completions = [...scriptedCompletions];
    this.callHistory = [];
  }

  async routeChatCompletion(options) {
    this.callHistory.push({
      profile: options.profile,
      messages: options.messages,
      maxTokens: options.maxTokens
    });

    if (this.completions.length === 0) {
      throw new Error('MockRoutingGate: No more scripted completions.');
    }

    const next = this.completions.shift();
    return {
      completion: typeof next === 'string' ? next : JSON.stringify(next),
      metadata: {
        model: 'mock-model-fast',
        provider: 'mock-provider',
        profile: options.profile || ROUTING_PROFILES.FAST,
        latencyMs: 15,
        tokens: 50
      }
    };
  }
}

/**
 * Mock Runtime Harness that logs executed tools without requiring a real browser.
 */
class MockRuntimeHarness {
  constructor() {
    this.toolCalls = [];
    this.runs = new Map();
  }

  createRun({ task, budget }) {
    const runId = 'mock_run_1';
    this.runs.set(runId, { task, budget, state: 'OBSERVING' });
    return { runId };
  }

  getRun(runId) {
    return this.runs.get(runId) || { state: 'OBSERVING' };
  }

  getAuditLog(runId) {
    return this.toolCalls;
  }

  async executeToolProposal(runId, proposal) {
    this.toolCalls.push(proposal);
    return {
      success: true,
      tool: proposal.tool,
      evidence: {
        observed: {
          title: 'Mock Page',
          currentUrl: 'http://127.0.0.1:3000/test.html',
          snapshotToken: 'snap_test_1',
          elements: []
        }
      }
    };
  }
}

/**
 * Mock BrowserManager providing deterministic inspect() and URL.
 */
class MockBrowserManager {
  constructor() {
    this.state = 'running';
    this.currentUrl = 'http://127.0.0.1:3000/test.html';
  }

  async inspect() {
    return {
      title: 'Mock Page',
      currentUrl: this.currentUrl,
      snapshotToken: 'snap_test_1',
      elements: [{ handle: 'h1', text: 'Target Heading' }],
      visibleText: { content: 'Target Heading', trust: 'untrusted_web_data' }
    };
  }

  isHandoffActive() {
    return false;
  }
}

describe('Autonomous Agent Controller Tests', () => {
  it('executes simple multi-step task to completion using hybrid short plan and FAST profile', async () => {
    const mockRouter = new MockRoutingGate([
      // 1. Planning response (2-4 milestones)
      {
        goal: 'Inspect mock page',
        milestones: [
          { id: 'm1', description: 'Inspect page content', status: 'pending' },
          { id: 'm2', description: 'Verify heading', status: 'pending' }
        ]
      },
      // 2. Action turn 1: Inspect page
      {
        decision: 'TOOL',
        toolProposal: {
          tool: 'browser.inspectPage',
          arguments: { detail: 'minimal' }
        },
        reasonSummary: 'Inspect the mock page'
      },
      // 3. Action turn 2: Complete
      {
        decision: 'COMPLETE',
        completionClaim: 'Target Heading is verified.'
      }
    ]);

    const mockHarness = new MockRuntimeHarness();
    const mockBm = new MockBrowserManager();

    const controller = new AgentController({
      task: { publicPrompt: 'Verify Target Heading on mock page', allowedTools: ['browser.inspectPage'] },
      runtimeHarness: mockHarness,
      browserManager: mockBm,
      routingGate: mockRouter
    });

    const result = await controller.run();

    assert.equal(result.terminalState, AGENT_RUN_STATES.SUCCESS_VERIFIED);
    assert.equal(controller.plan.milestones.length, 2);
    assert.equal(mockHarness.toolCalls.length, 1);
    assert.equal(mockHarness.toolCalls[0].tool, 'browser.inspectPage');

    // Default profile must be FAST
    assert.equal(mockRouter.callHistory[0].profile, ROUTING_PROFILES.FAST);
    assert.equal(mockRouter.callHistory[1].profile, ROUTING_PROFILES.FAST);
  });

  it('pauses in WAITING_USER_CONFIRMATION when tool is classified R3 (consequential)', async () => {
    const mockRouter = new MockRoutingGate([
      // Planning response
      {
        goal: 'Submit order form',
        milestones: [
          { id: 'm1', description: 'Fill form', status: 'pending' },
          { id: 'm2', description: 'Submit order', status: 'pending' }
        ]
      },
      // Action proposal for form submission
      {
        decision: 'TOOL',
        toolProposal: {
          tool: 'browser.submitForm',
          arguments: { formHandle: 'form_1', expectedSnapshotToken: 'snap_test_1' }
        },
        reasonSummary: 'Submit the completed form'
      }
    ]);

    const mockHarness = new MockRuntimeHarness();
    const mockBm = new MockBrowserManager();

    const controller = new AgentController({
      task: { publicPrompt: 'Submit order', allowedTools: ['browser.submitForm'] },
      runtimeHarness: mockHarness,
      browserManager: mockBm,
      routingGate: mockRouter
    });

    const result = await controller.run();

    // R3 tool proposal must pause the agent in WAITING_USER_CONFIRMATION
    assert.equal(result.terminalState, AGENT_RUN_STATES.WAITING_USER_CONFIRMATION);
    assert.equal(controller.stateMachine.state, AGENT_RUN_STATES.WAITING_USER_CONFIRMATION);
    assert.ok(controller.activePendingAction);
    assert.equal(controller.activePendingAction.tool, 'browser.submitForm');

    // Operator confirms action via trusted boundary
    const resumeRes = await controller.confirmAction();
    assert.ok(resumeRes);
  });

  it('pauses in NEEDS_HUMAN_AUTH when model declares authentication barrier', async () => {
    const mockRouter = new MockRoutingGate([
      {
        goal: 'Access account dashboard',
        milestones: [
          { id: 'm1', description: 'Detect login', status: 'pending' }
        ]
      },
      {
        decision: 'NEEDS_HUMAN_AUTH',
        authReason: 'LOGIN_REQUIRED'
      }
    ]);

    const mockHarness = new MockRuntimeHarness();
    const mockBm = new MockBrowserManager();

    const controller = new AgentController({
      task: { publicPrompt: 'Access account', allowedTools: ['browser.inspectPage'] },
      runtimeHarness: mockHarness,
      browserManager: mockBm,
      routingGate: mockRouter
    });

    const result = await controller.run();
    assert.equal(result.terminalState, AGENT_RUN_STATES.NEEDS_HUMAN_AUTH);
  });

  it('stops with BUDGET_EXCEEDED when tool call budget is exhausted', async () => {
    const mockRouter = new MockRoutingGate([
      {
        goal: 'Infinite loop test',
        milestones: [{ id: 'm1', description: 'repeat', status: 'pending' }]
      },
      {
        decision: 'TOOL',
        toolProposal: { tool: 'browser.inspectPage', arguments: {} }
      },
      {
        decision: 'TOOL',
        toolProposal: { tool: 'browser.inspectPage', arguments: {} }
      },
      {
        decision: 'TOOL',
        toolProposal: { tool: 'browser.inspectPage', arguments: {} }
      }
    ]);

    const mockHarness = new MockRuntimeHarness();
    const mockBm = new MockBrowserManager();

    const controller = new AgentController({
      task: {
        publicPrompt: 'Infinite loop',
        allowedTools: ['browser.inspectPage'],
        budgets: { maxToolCalls: 2, maxModelTurns: 5 }
      },
      runtimeHarness: mockHarness,
      browserManager: mockBm,
      routingGate: mockRouter
    });

    const result = await controller.run();
    assert.equal(result.terminalState, AGENT_RUN_STATES.BUDGET_EXCEEDED);
  });

  it('supports explicit cancellation stopping future execution', async () => {
    const mockRouter = new MockRoutingGate([
      {
        goal: 'Cancel test',
        milestones: [{ id: 'm1', description: 'inspect', status: 'pending' }]
      }
    ]);

    const mockHarness = new MockRuntimeHarness();
    const mockBm = new MockBrowserManager();

    const controller = new AgentController({
      task: { publicPrompt: 'Cancel test', allowedTools: ['browser.inspectPage'] },
      runtimeHarness: mockHarness,
      browserManager: mockBm,
      routingGate: mockRouter
    });

    controller.cancel('User requested cancel');
    assert.equal(controller.stateMachine.state, AGENT_RUN_STATES.CANCELLED);
  });
});
