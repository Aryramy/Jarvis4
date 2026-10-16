/**
 * Agent Adapter Interface Contract for JARVIS4 (PRE-040C).
 *
 * Invariants:
 * - Common interface implemented by both testing reference adapters (now)
 *   and future autonomous agents (Brick 40+).
 * - Agent adapter receives ONLY the publicTask definition.
 * - Strict assertion: publicTask must NEVER contain expectedEvidence or grader criteria.
 * - Actions must be executed through RuntimeAgentHarness, never directly on BrowserManager.
 */

export class AgentAdapterInterface {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.adapterName='UNKNOWN_ADAPTER']
   * @param {boolean} [options.isAutonomous=false]
   */
  constructor(options = {}) {
    this.adapterName = options.adapterName || 'UNKNOWN_ADAPTER';
    this.isAutonomous = Boolean(options.isAutonomous);
  }

  /**
   * Executes a task through the runtime harness.
   *
   * @param {Object} context
   * @param {Object} context.publicTask - Strictly public task definition
   * @param {import('../runtime/runtimeHarness.js').RuntimeAgentHarness} context.runtimeHarness
   * @param {string} context.runId
   * @param {import('../../browser/browserManager.js').BrowserManager} context.browserManager
   * @param {Object} [context.limits]
   * @returns {Promise<{ trajectory: Object, terminalState: string }>}
   */
  async runTask(context) {
    throw new Error('runTask() must be implemented by adapter subclass.');
  }

  /**
   * Asserts that the public task does not leak hidden evaluation criteria.
   * @param {Object} publicTask
   */
  assertPublicTaskSanity(publicTask) {
    if (!publicTask || typeof publicTask !== 'object') {
      throw new Error('Adapter received null or invalid publicTask.');
    }
    if (publicTask.expectedEvidence !== undefined) {
      throw new Error('SECURITY VIOLATION: expectedEvidence was leaked into publicTask!');
    }
    if (publicTask.optimalSteps !== undefined) {
      throw new Error('SECURITY VIOLATION: optimalSteps was leaked into publicTask!');
    }
    if (publicTask.hardGates !== undefined) {
      throw new Error('SECURITY VIOLATION: hardGates was leaked into publicTask!');
    }
  }
}
