import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeAgentHarness } from '../../src/agent/runtime/runtimeHarness.js';
import { RUN_STATES } from '../../src/agent/runtime/runtimeState.js';
import { ToolErrorCode } from '../../src/agent/runtime/runtimeErrors.js';

describe('RuntimeAgentHarness Unit Tests (PRE-040A)', () => {
  function createMockBrowserManager(overrides = {}) {
    return {
      activePageId: 'pg_default_1',
      currentUrl: 'https://example.com/shop',
      snapshotToken: 'snap_v1_valid',
      isHandoffActive: () => false,
      inspectPage: async (args) => ({
        url: 'https://example.com/shop',
        title: 'Shop Home',
        text: 'Products for sale',
        elements: [{ kind: 'button', text: 'Buy' }]
      }),
      executeAction: async (args) => ({
        success: true,
        action: args.action,
        verified: true,
        documentVersion: 2,
        semanticRevision: 5,
        snapshotToken: 'snap_v2_fresh'
      }),
      prepareFormSubmission: async () => ({
        valid: true,
        confirmationToken: 'single_use_internal_token_xyz',
        formDetails: { action: '/checkout', method: 'POST' }
      }),
      submitForm: async (args) => {
        if (!args.confirmationToken) {
          throw new Error('CONFIRMATION_REQUIRED');
        }
        return {
          success: true,
          verified: true,
          submitted: true,
          documentVersion: 3,
          semanticRevision: 8,
          snapshotToken: 'snap_v3_after_submit'
        };
      },
      ...overrides
    };
  }

  describe('Run Lifecycle & State Management', () => {
    it('creates a new governed run in READY state', () => {
      const harness = new RuntimeAgentHarness({ browserManager: createMockBrowserManager() });
      const run = harness.createRun({ task: 'Search for laptops' });

      assert.match(run.runId, /^run_/);
      assert.strictEqual(run.state, RUN_STATES.READY);

      const status = harness.getRun(run.runId);
      assert.strictEqual(status.runId, run.runId);
      assert.strictEqual(status.state, RUN_STATES.READY);
      assert.strictEqual(status.isTerminal, false);
      assert.strictEqual(status.stepCount, 0);
    });

    it('rejects illegal state transitions', () => {
      const harness = new RuntimeAgentHarness({ browserManager: createMockBrowserManager() });
      const run = harness.createRun();
      const runRecord = harness.runs.get(run.runId);

      // Cannot jump from READY directly to EXECUTING without proposal/validation
      assert.throws(
        () => runRecord.stateMachine.transitionTo(RUN_STATES.EXECUTING),
        (err) => err.code === ToolErrorCode.INVALID_STATE_TRANSITION
      );
    });

    it('allows cancelling an active run and prevents further execution', async () => {
      const harness = new RuntimeAgentHarness({ browserManager: createMockBrowserManager() });
      const run = harness.createRun();

      harness.cancelRun(run.runId, 'User stopped run');
      const status = harness.getRun(run.runId);
      assert.strictEqual(status.state, RUN_STATES.CANCELLED);
      assert.strictEqual(status.isTerminal, true);

      await assert.rejects(
        async () => harness.executeToolProposal(run.runId, { tool: 'browser.inspectPage' }),
        (err) => err.code === ToolErrorCode.RUN_ALREADY_TERMINATED
      );
    });
  });

  describe('R0 Observation Execution', () => {
    it('executes R0 inspectPage and returns sanitized evidence envelope', async () => {
      const mockBm = createMockBrowserManager();
      const harness = new RuntimeAgentHarness({ browserManager: mockBm });
      const run = harness.createRun();

      const result = await harness.executeToolProposal(run.runId, {
        tool: 'browser.inspectPage'
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, RUN_STATES.READY);
      assert.strictEqual(result.evidence.tool, 'browser.inspectPage');
      assert.strictEqual(result.evidence.risk, 'R0');
      assert.strictEqual(result.evidence.executed, true);
      assert.strictEqual(result.evidence.verified, true);
      // Verify untrusted web data wrapping
      assert.strictEqual(result.evidence.observed.text.trust, 'untrusted_web_data');

      // Verify audit trail
      const audits = harness.getAuditLog(run.runId);
      assert.ok(audits.length >= 2);
      assert.strictEqual(audits.some((a) => a.decision === 'VERIFIED'), true);
    });
  });

  describe('R1 Safe Mutation Execution', () => {
    it('executes R1 fill and click with verified evidence', async () => {
      const mockBm = createMockBrowserManager();
      const harness = new RuntimeAgentHarness({ browserManager: mockBm });
      const run = harness.createRun();

      const fillResult = await harness.executeToolProposal(run.runId, {
        tool: 'browser.fill',
        snapshotToken: 'snap_v1_valid',
        arguments: {
          target: { kind: 'input', accessibleName: 'Search Query' },
          value: 'mechanical keyboards'
        }
      });

      assert.strictEqual(fillResult.success, true);
      assert.strictEqual(fillResult.evidence.tool, 'browser.fill');
      assert.strictEqual(fillResult.evidence.risk, 'R1');
      assert.strictEqual(fillResult.evidence.verified, true);
    });
  });

  describe('R3 Consequential Gating & Human Confirmation', () => {
    it('pauses R3 submitForm proposal and creates pending action without executing submission', async () => {
      let submissionExecuted = false;
      const mockBm = createMockBrowserManager({
        submitForm: async () => {
          submissionExecuted = true;
          return { success: true, verified: true };
        }
      });

      const harness = new RuntimeAgentHarness({ browserManager: mockBm });
      const run = harness.createRun();

      const pauseResult = await harness.executeToolProposal(run.runId, {
        tool: 'browser.submitForm',
        snapshotToken: 'snap_v1_valid',
        arguments: {
          form: { kind: 'form', accessibleName: 'Checkout Form' }
        }
      });

      // Assert zero submission executed before approval
      assert.strictEqual(submissionExecuted, false);
      assert.strictEqual(pauseResult.success, false);
      assert.strictEqual(pauseResult.requiresConfirmation, true);
      assert.strictEqual(pauseResult.status, RUN_STATES.WAITING_USER_CONFIRMATION);
      assert.ok(pauseResult.pendingAction.pendingActionId);

      // Model NEVER receives confirmation token!
      assert.strictEqual(pauseResult.pendingAction.confirmationToken, undefined);
      assert.strictEqual(pauseResult.confirmationToken, undefined);

      const runStatus = harness.getRun(run.runId);
      assert.strictEqual(runStatus.state, RUN_STATES.WAITING_USER_CONFIRMATION);

      // Now simulate trusted operator approval through trusted boundary
      const approvalResult = await harness.approvePendingAction(
        run.runId,
        pauseResult.pendingAction.pendingActionId,
        { approved: true }
      );

      // Submission now executed
      assert.strictEqual(submissionExecuted, true);
      assert.strictEqual(approvalResult.success, true);
      assert.strictEqual(approvalResult.evidence.verified, true);
      assert.strictEqual(approvalResult.evidence.tool, 'browser.submitForm');

      // Attempting replay of same pendingActionId must be rejected
      await assert.rejects(
        async () => harness.approvePendingAction(run.runId, pauseResult.pendingAction.pendingActionId, { approved: true }),
        (err) => err.code === ToolErrorCode.PENDING_ACTION_ALREADY_USED
      );
    });

    it('rejects approval if page snapshot changed since preparation (APPROVAL_STALE)', async () => {
      const mockBm = createMockBrowserManager();
      const harness = new RuntimeAgentHarness({ browserManager: mockBm });
      const run = harness.createRun();

      const pauseResult = await harness.executeToolProposal(run.runId, {
        tool: 'browser.submitForm',
        snapshotToken: 'snap_v1_valid',
        arguments: {
          form: { kind: 'form', accessibleName: 'Order Form' }
        }
      });

      // Simulate page mutation: snapshot token changes
      mockBm.snapshotToken = 'snap_mutated_v2';

      await assert.rejects(
        async () => harness.approvePendingAction(run.runId, pauseResult.pendingAction.pendingActionId, { approved: true }),
        (err) => err.code === ToolErrorCode.APPROVAL_STALE
      );
    });
  });

  describe('Human Handoff Invariant', () => {
    it('blocks mutating tool call when Human Handoff is active and transitions to NEEDS_HUMAN_AUTH', async () => {
      const mockBm = createMockBrowserManager({
        isHandoffActive: () => true
      });

      const harness = new RuntimeAgentHarness({ browserManager: mockBm });
      const run = harness.createRun();

      await assert.rejects(
        async () => harness.executeToolProposal(run.runId, {
          tool: 'browser.click',
          snapshotToken: 'snap_v1_valid',
          arguments: { target: { kind: 'button', accessibleName: 'Next' } }
        }),
        (err) => err.code === ToolErrorCode.HUMAN_HANDOFF_ACTIVE
      );

      const runStatus = harness.getRun(run.runId);
      assert.strictEqual(runStatus.state, RUN_STATES.NEEDS_HUMAN_AUTH);
    });
  });

  describe('Subcontext Safety Invariant', () => {
    it('blocks subcontext form submissions with SUBCONTEXT_OPERATION_NOT_SUPPORTED', async () => {
      const mockBm = createMockBrowserManager();
      const harness = new RuntimeAgentHarness({ browserManager: mockBm });
      const run = harness.createRun();

      await assert.rejects(
        async () => harness.executeToolProposal(run.runId, {
          tool: 'browser.submitForm',
          contextId: 'ctx_iframe_payment_2',
          snapshotToken: 'snap_v1_valid',
          arguments: { form: { kind: 'form', accessibleName: 'Card' } }
        }),
        (err) => err.code === ToolErrorCode.SUBCONTEXT_OPERATION_NOT_SUPPORTED
      );
    });
  });

  describe('Prohibited Tool Invariant (R4)', () => {
    it('blocks resumeHandoff with BLOCKED_BY_POLICY', async () => {
      const mockBm = createMockBrowserManager();
      const harness = new RuntimeAgentHarness({ browserManager: mockBm });
      const run = harness.createRun();

      await assert.rejects(
        async () => harness.executeToolProposal(run.runId, {
          tool: 'browser.resumeHandoff'
        }),
        (err) => err.code === ToolErrorCode.BLOCKED_BY_POLICY
      );
    });
  });

  describe('Execution Budget Enforcement', () => {
    it('halts execution when toolCalls budget is exhausted', async () => {
      const mockBm = createMockBrowserManager();
      const harness = new RuntimeAgentHarness({
        browserManager: mockBm,
        budgetOptions: { maxToolCalls: 2 }
      });
      const run = harness.createRun();

      // Step 1
      await harness.executeToolProposal(run.runId, { tool: 'browser.inspectPage' });
      // Step 2
      await harness.executeToolProposal(run.runId, { tool: 'browser.inspectPage' });

      // Step 3 must exceed budget
      await assert.rejects(
        async () => harness.executeToolProposal(run.runId, { tool: 'browser.inspectPage' }),
        (err) => err.code === ToolErrorCode.BUDGET_EXCEEDED
      );

      const runStatus = harness.getRun(run.runId);
      assert.strictEqual(runStatus.state, RUN_STATES.BUDGET_EXCEEDED);
    });
  });

  describe('Audit Logging & Secret Protection', () => {
    it('audit records contain zero passwords, cookies, or secrets', async () => {
      const mockBm = createMockBrowserManager({
        executeAction: async () => ({
          success: true,
          verified: true,
          password: 'secret_password_do_not_log',
          cookie: 'session_secret'
        })
      });

      const harness = new RuntimeAgentHarness({ browserManager: mockBm });
      const run = harness.createRun();

      await harness.executeToolProposal(run.runId, {
        tool: 'browser.fill',
        snapshotToken: 'snap_v1_valid',
        arguments: {
          target: { kind: 'input', accessibleName: 'Username' },
          value: 'bob'
        }
      });

      const auditJson = JSON.stringify(harness.getAuditLog(run.runId));
      assert.strictEqual(auditJson.includes('secret_password_do_not_log'), false);
      assert.strictEqual(auditJson.includes('session_secret'), false);
    });
  });
});
