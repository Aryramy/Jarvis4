/**
 * Autonomous Agent Adapter for JARVIS4 Independent Eval Harness (BRICK-040).
 * Connects the genuine Autonomous Multi-Step Agent to the independent evaluation harness.
 *
 * Invariants:
 * - Implements AgentAdapterInterface.
 * - adapterName: 'AUTONOMOUS_AGENT'.
 * - isAutonomous: true.
 * - Receives ONLY the publicTask definition (strict assertion against hidden criteria).
 * - Executes tool calls strictly through RuntimeAgentHarness (zero BrowserManager bypass).
 * - Truthful reporting: Evaluator reports as "Autonomous Agent Evaluation".
 */

import { AgentAdapterInterface } from './agentAdapterInterface.js';
import { AgentController } from '../../autonomous/agentController.js';
import { OpenRouterRoutingGate } from '../../../providers/openRouterRouter.js';

export class AutonomousAgentAdapter extends AgentAdapterInterface {
  /**
   * @param {Object} [options={}]
   * @param {OpenRouterRoutingGate} [options.routingGate]
   */
  constructor(options = {}) {
    super({
      adapterName: 'AUTONOMOUS_AGENT',
      isAutonomous: true,
      ...options
    });
    this.routingGate = options.routingGate || new OpenRouterRoutingGate();
  }

  /**
   * Runs an evaluation task autonomously.
   *
   * @param {Object} context
   * @param {Object} context.publicTask - Strictly public task definition
   * @param {import('../../runtime/runtimeHarness.js').RuntimeAgentHarness} context.runtimeHarness
   * @param {string} context.runId
   * @param {import('../../../browser/browserManager.js').BrowserManager} context.browserManager
   * @returns {Promise<{ trajectory: Object, terminalState: string }>}
   */
  async runTask({ publicTask, runtimeHarness, runId, browserManager }) {
    this.assertPublicTaskSanity(publicTask);

    const controller = new AgentController({
      task: publicTask,
      runtimeHarness,
      runId,
      browserManager,
      routingGate: this.routingGate,
      allowedTools: publicTask.allowedTools,
      budgets: publicTask.budgets
    });

    const result = await controller.run();
    return result;
  }
}
