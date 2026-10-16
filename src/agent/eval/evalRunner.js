/**
 * Evaluation Runner for JARVIS4 (PRE-040C).
 *
 * Invariants:
 * - Deterministic, loopback-only execution (0 public internet requests, 0 API cost).
 * - Real Microsoft Edge automation driven via BrowserManager against local loopback fixtures.
 * - Runtime Agent Harness governance active on all tool calls.
 * - Guaranteed try/finally resource cleanup: zero orphan Edge processes or leaked server sockets.
 * - One task failure never poisons subsequent tasks.
 */

import { BrowserManager } from '../../browser/browserManager.js';
import { startFixtureServer } from '../../../tests/browser-fixtures/server.js';
import { RuntimeAgentHarness } from '../runtime/runtimeHarness.js';
import { extractPublicTask } from './taskSchema.js';
import { gradeTrajectory, aggregateSuiteResults } from './trajectoryGrader.js';
import { writeEvalReport } from './reportWriter.js';
import { ScriptedReferenceAdapter } from './adapters/scriptedReferenceAdapter.js';

export class EvalRunner {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.channel='msedge']
   * @param {boolean} [options.headless=true]
   */
  constructor(options = {}) {
    this.channel = options.channel || 'msedge';
    this.headless = options.headless !== false;
  }

  /**
   * Executes a single eval task.
   *
   * @param {Object} options
   * @param {Object} options.task - Validated eval task definition
   * @param {import('./adapters/agentAdapterInterface.js').AgentAdapterInterface} [options.adapter]
   * @returns {Promise<Object>} Task evaluation result
   */
  async runTask({ task, adapter = new ScriptedReferenceAdapter() }) {
    let fixtureServer = null;
    let browserManager = null;

    try {
      fixtureServer = await startFixtureServer();
      browserManager = new BrowserManager({
        channel: this.channel,
        headless: this.headless,
        allowTestLoopback: true,
        downloadDir: 'runtime/downloads/eval-test'
      });

      await browserManager.launch();

      const targetUrl = `${fixtureServer.baseUrl}${task.fixture}`;
      await browserManager.navigate(targetUrl);

      const runtimeHarness = new RuntimeAgentHarness({
        browserManager,
        budgetOptions: task.budgets
      });

      const { runId } = runtimeHarness.createRun({
        task: task.publicPrompt,
        budget: task.budgets
      });

      const publicTask = extractPublicTask(task);

      const { trajectory, terminalState } = await adapter.runTask({
        publicTask,
        runtimeHarness,
        runId,
        browserManager
      });

      // Gather authoritative post-execution browser state
      const finalBrowserState = {
        currentUrl: browserManager.currentUrl,
        downloadVerified: Boolean(browserManager.lastDownloadId),
        handoffReason: browserManager.isHandoffActive?.(browserManager.activePageId) ? 'LOGIN_REQUIRED' : null
      };

      try {
        if (browserManager.state === 'running' && !browserManager.isHandoffActive?.(browserManager.activePageId)) {
          finalBrowserState.inspection = await browserManager.inspect();
        }
      } catch {}

      const auditLogs = runtimeHarness.getAuditLog(runId);

      const result = gradeTrajectory({
        task,
        trajectory,
        finalBrowserState,
        auditLogs,
        adapter: adapter.adapterName
      });

      return result;
    } finally {
      if (browserManager) {
        try {
          await browserManager.close();
        } catch {}
      }
      if (fixtureServer) {
        try {
          await fixtureServer.close();
        } catch {}
      }
    }
  }

  /**
   * Executes a suite of golden tasks sequentially using a shared browser instance
   * for high performance while preserving strict per-task isolation.
   *
   * @param {Object} options
   * @param {Array<Object>} options.tasks - Validated eval tasks
   * @param {import('./adapters/agentAdapterInterface.js').AgentAdapterInterface} [options.adapter]
   * @param {boolean} [options.writeReport=true]
   * @returns {Promise<{ suiteSummary: Object, taskResults: Array<Object>, reportPath: string|null }>}
   */
  async runSuite({ tasks, adapter = new ScriptedReferenceAdapter(), writeReport = true }) {
    let fixtureServer = null;
    let browserManager = null;
    const taskResults = [];

    try {
      fixtureServer = await startFixtureServer();
      browserManager = new BrowserManager({
        channel: this.channel,
        headless: this.headless,
        allowTestLoopback: true,
        downloadDir: 'runtime/downloads/eval-test'
      });

      await browserManager.launch();

      for (const task of tasks) {
        let taskResult = null;
        try {
          // 1. Reset per-task state (handoff, sessions, pages)
          try {
            if (browserManager.cancelHandoff && browserManager.activePageId && browserManager.isHandoffActive?.(browserManager.activePageId)) {
              browserManager.cancelHandoff(browserManager.activePageId);
            }
          } catch {}

          // 2. Navigate to task fixture
          const targetUrl = `${fixtureServer.baseUrl}${task.fixture}`;
          await browserManager.navigate(targetUrl);

          // 3. Initialize Runtime Agent Harness for this task run
          const runtimeHarness = new RuntimeAgentHarness({
            browserManager,
            budgetOptions: task.budgets
          });

          const { runId } = runtimeHarness.createRun({
            task: task.publicPrompt,
            budget: task.budgets
          });

          // 4. Extract public task definition (no expected evidence)
          const publicTask = extractPublicTask(task);

          // 5. Invoke adapter
          const { trajectory, terminalState } = await adapter.runTask({
            publicTask,
            runtimeHarness,
            runId,
            browserManager
          });

          // 6. Gather authoritative final browser state
          const finalBrowserState = {
            currentUrl: browserManager.currentUrl,
            downloadVerified: Boolean(browserManager.lastDownloadId),
            handoffReason: browserManager.isHandoffActive?.(browserManager.activePageId) ? 'LOGIN_REQUIRED' : null
          };

          try {
            if (browserManager.state === 'running' && !browserManager.isHandoffActive?.(browserManager.activePageId)) {
              finalBrowserState.inspection = await browserManager.inspectPage();
            }
          } catch {}

          const auditLogs = runtimeHarness.getAuditLog(runId);

          // 7. Grade trajectory
          taskResult = gradeTrajectory({
            task,
            trajectory,
            finalBrowserState,
            auditLogs,
            adapter: adapter.adapterName
          });
        } catch (taskErr) {
          taskResult = {
            taskId: task.id,
            taskName: task.name,
            adapter: adapter.adapterName,
            passed: false,
            hardGatePassed: false,
            taskSuccess: false,
            verificationPassed: false,
            safetyPassed: false,
            confirmationPassed: false,
            budgetPassed: false,
            toolPolicyPassed: false,
            secretProtectionPassed: true,
            actualSteps: 0,
            optimalSteps: task.optimalSteps || 1,
            stepRatio: 0,
            durationMs: 0,
            failureReasons: [`[ExecutionError] ${taskErr.message}`]
          };
        }

        taskResults.push(taskResult);

        // Close extra pages if opened by multi-page task
        try {
          if (browserManager.pages && browserManager.pages.size > 1) {
            const pageIds = [...browserManager.pages.keys()];
            for (let i = 1; i < pageIds.length; i++) {
              await browserManager.closePage(pageIds[i]).catch(() => {});
            }
          }
        } catch {}
      }

      const suiteSummary = aggregateSuiteResults(taskResults, adapter.adapterName);

      let reportPath = null;
      if (writeReport) {
        reportPath = writeEvalReport({
          suiteSummary,
          taskResults
        });
      }

      return {
        suiteSummary,
        taskResults,
        reportPath
      };
    } finally {
      if (browserManager) {
        try {
          await browserManager.close();
        } catch {}
      }
      if (fixtureServer) {
        try {
          await fixtureServer.close();
        } catch {}
      }
    }
  }
}
