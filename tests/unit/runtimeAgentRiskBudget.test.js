import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateToolRisk } from '../../src/agent/runtime/riskPolicy.js';
import { ExecutionBudget } from '../../src/agent/runtime/executionBudget.js';
import { getRegisteredTool, RISK_LEVELS, TOOL_CATEGORIES } from '../../src/agent/runtime/toolRegistry.js';
import { ToolErrorCode } from '../../src/agent/runtime/runtimeErrors.js';

describe('Risk Policy & Execution Budget Unit Tests (PRE-040A)', () => {
  describe('Deterministic Risk Policy', () => {
    it('classifies observational tools as R0', () => {
      const inspectEntry = getRegisteredTool('browser.inspectPage');
      const statusEntry = getRegisteredTool('browser.getPageStatus');
      const formsEntry = getRegisteredTool('browser.inspectForms');
      const dataEntry = getRegisteredTool('browser.extractData');
      const listPagesEntry = getRegisteredTool('browser.listPages');

      assert.strictEqual(calculateToolRisk(inspectEntry, { tool: 'browser.inspectPage' }), RISK_LEVELS.R0);
      assert.strictEqual(calculateToolRisk(statusEntry, { tool: 'browser.getPageStatus' }), RISK_LEVELS.R0);
      assert.strictEqual(calculateToolRisk(formsEntry, { tool: 'browser.inspectForms' }), RISK_LEVELS.R0);
      assert.strictEqual(calculateToolRisk(dataEntry, { tool: 'browser.extractData' }), RISK_LEVELS.R0);
      assert.strictEqual(calculateToolRisk(listPagesEntry, { tool: 'browser.listPages' }), RISK_LEVELS.R0);
    });

    it('classifies reversible interactions as R1', () => {
      const fillEntry = getRegisteredTool('browser.fill');
      const checkEntry = getRegisteredTool('browser.check');
      const selectEntry = getRegisteredTool('browser.select');
      const historyEntry = getRegisteredTool('browser.navigateHistory');

      assert.strictEqual(calculateToolRisk(fillEntry, { tool: 'browser.fill', arguments: { target: { kind: 'input', accessibleName: 'search' }, value: 'test' } }), RISK_LEVELS.R1);
      assert.strictEqual(calculateToolRisk(checkEntry, { tool: 'browser.check', arguments: { target: { kind: 'input', accessibleName: 'remember' } } }), RISK_LEVELS.R1);
      assert.strictEqual(calculateToolRisk(selectEntry, { tool: 'browser.select', arguments: { target: { kind: 'select', accessibleName: 'country' }, optionLabel: 'US' } }), RISK_LEVELS.R1);
      assert.strictEqual(calculateToolRisk(historyEntry, { tool: 'browser.navigateHistory', arguments: { action: 'back' } }), RISK_LEVELS.R1);
    });

    it('classifies ordinary button clicks as R1', () => {
      const clickEntry = getRegisteredTool('browser.click');
      const proposal = {
        tool: 'browser.click',
        arguments: {
          target: { kind: 'button', accessibleName: 'Next Tab' }
        }
      };
      assert.strictEqual(calculateToolRisk(clickEntry, proposal), RISK_LEVELS.R1);
    });

    it('elevates click targeting submit / purchase / payment to R3', () => {
      const clickEntry = getRegisteredTool('browser.click');

      const submitProposal = {
        tool: 'browser.click',
        arguments: { target: { kind: 'button', accessibleName: 'Submit Order' } }
      };
      const purchaseProposal = {
        tool: 'browser.click',
        arguments: { target: { kind: 'button', accessibleName: 'Pay Now' } }
      };
      const checkoutProposal = {
        tool: 'browser.click',
        arguments: { target: { kind: 'button', text: 'Checkout with Card' } }
      };
      const typeSubmitProposal = {
        tool: 'browser.click',
        arguments: { target: { kind: 'button', type: 'submit', accessibleName: 'Continue' } }
      };

      assert.strictEqual(calculateToolRisk(clickEntry, submitProposal), RISK_LEVELS.R3);
      assert.strictEqual(calculateToolRisk(clickEntry, purchaseProposal), RISK_LEVELS.R3);
      assert.strictEqual(calculateToolRisk(clickEntry, checkoutProposal), RISK_LEVELS.R3);
      assert.strictEqual(calculateToolRisk(clickEntry, typeSubmitProposal), RISK_LEVELS.R3);
    });

    it('classifies same-origin navigation as R1 and cross-origin as R2', () => {
      const navEntry = getRegisteredTool('browser.navigate');

      const sameOriginProposal = {
        tool: 'browser.navigate',
        arguments: { url: 'https://example.com/checkout/step2' }
      };
      const crossOriginProposal = {
        tool: 'browser.navigate',
        arguments: { url: 'https://other-domain.com/login' }
      };

      const context = { currentUrl: 'https://example.com/cart' };

      assert.strictEqual(calculateToolRisk(navEntry, sameOriginProposal, context), RISK_LEVELS.R1);
      assert.strictEqual(calculateToolRisk(navEntry, crossOriginProposal, context), RISK_LEVELS.R2);
    });

    it('classifies submitForm as R3 always', () => {
      const submitEntry = getRegisteredTool('browser.submitForm');
      assert.strictEqual(calculateToolRisk(submitEntry, { tool: 'browser.submitForm' }), RISK_LEVELS.R3);
    });

    it('classifies prohibited tools as R4', () => {
      const resumeEntry = getRegisteredTool('browser.resumeHandoff');
      assert.strictEqual(calculateToolRisk(resumeEntry, { tool: 'browser.resumeHandoff' }), RISK_LEVELS.R4);
    });

    it('never trusts a model-declared risk level', () => {
      const submitEntry = getRegisteredTool('browser.submitForm');
      const tamperedProposal = {
        tool: 'browser.submitForm',
        risk: 'R0',
        riskLevel: 'R0',
        arguments: {}
      };
      // Must deterministically remain R3
      assert.strictEqual(calculateToolRisk(submitEntry, tamperedProposal), RISK_LEVELS.R3);
    });
  });

  describe('Execution Budget Clamping & Limits', () => {
    it('initializes with architecture defaults when no options provided', () => {
      const budget = new ExecutionBudget();
      assert.strictEqual(budget.limits.maxToolCalls, 15);
      assert.strictEqual(budget.limits.maxModelTurns, 8);
      assert.strictEqual(budget.limits.maxNavigations, 4);
      assert.strictEqual(budget.limits.maxMutations, 10);
      assert.strictEqual(budget.limits.maxFormSubmissions, 1);
      assert.strictEqual(budget.limits.maxUploads, 2);
      assert.strictEqual(budget.limits.maxDownloads, 2);
      assert.strictEqual(budget.limits.maxConsecutiveFailures, 2);
      assert.strictEqual(budget.limits.maxRuntimeMs, 60000);
      assert.strictEqual(budget.limits.maxTokens, 25000);
    });

    it('clamps custom options to safety bounds', () => {
      const extremeBudget = new ExecutionBudget({
        maxToolCalls: 999999, // clamped to 50
        maxNavigations: 100, // clamped to 15
        maxFormSubmissions: 50, // clamped to 3
        maxRuntimeMs: 99999999 // clamped to 300000 (5 min)
      });
      assert.strictEqual(extremeBudget.limits.maxToolCalls, 50);
      assert.strictEqual(extremeBudget.limits.maxNavigations, 15);
      assert.strictEqual(extremeBudget.limits.maxFormSubmissions, 3);
      assert.strictEqual(extremeBudget.limits.maxRuntimeMs, 300000);
    });
  });

  describe('Budget Accounting & Breach Detection', () => {
    it('tracks tool calls atomically and halts when max exceeded', () => {
      const budget = new ExecutionBudget({ maxToolCalls: 2 });

      // First call check and record
      assert.doesNotThrow(() => budget.checkBudget(TOOL_CATEGORIES.OBSERVE, RISK_LEVELS.R0));
      budget.recordExecution(TOOL_CATEGORIES.OBSERVE, RISK_LEVELS.R0, 'browser.inspectPage');
      assert.strictEqual(budget.counters.toolCalls, 1);

      // Second call check and record
      assert.doesNotThrow(() => budget.checkBudget(TOOL_CATEGORIES.OBSERVE, RISK_LEVELS.R0));
      budget.recordExecution(TOOL_CATEGORIES.OBSERVE, RISK_LEVELS.R0, 'browser.inspectPage');
      assert.strictEqual(budget.counters.toolCalls, 2);

      // Third call must breach limit
      assert.throws(
        () => budget.checkBudget(TOOL_CATEGORIES.OBSERVE, RISK_LEVELS.R0),
        (err) => err.code === ToolErrorCode.BUDGET_EXCEEDED && err.message.includes('Total tool calls limit')
      );
    });

    it('enforces maximum form submission consequence limit (default 1)', () => {
      const budget = new ExecutionBudget(); // maxFormSubmissions: 1

      // 1st submission allowed
      assert.doesNotThrow(() => budget.checkBudget(TOOL_CATEGORIES.CONSEQUENTIAL, RISK_LEVELS.R3, { toolName: 'browser.submitForm' }));
      budget.recordExecution(TOOL_CATEGORIES.CONSEQUENTIAL, RISK_LEVELS.R3, 'browser.submitForm');
      assert.strictEqual(budget.counters.formSubmissions, 1);

      // 2nd submission must be blocked
      assert.throws(
        () => budget.checkBudget(TOOL_CATEGORIES.CONSEQUENTIAL, RISK_LEVELS.R3, { toolName: 'browser.submitForm' }),
        (err) => err.code === ToolErrorCode.BUDGET_EXCEEDED && err.message.includes('Form submissions limit')
      );
    });

    it('enforces consecutive failures budget and resets on success', () => {
      const budget = new ExecutionBudget({ maxConsecutiveFailures: 2 });

      budget.recordFailure('TARGET_NOT_FOUND');
      assert.strictEqual(budget.counters.consecutiveFailures, 1);
      assert.doesNotThrow(() => budget.checkBudget(TOOL_CATEGORIES.OBSERVE, RISK_LEVELS.R0));

      budget.recordFailure('TARGET_NOT_FOUND');
      assert.strictEqual(budget.counters.consecutiveFailures, 2);

      // Reaching consecutive failure limit halts subsequent calls
      assert.throws(
        () => budget.checkBudget(TOOL_CATEGORIES.OBSERVE, RISK_LEVELS.R0),
        (err) => err.code === ToolErrorCode.BUDGET_EXCEEDED && err.message.includes('Consecutive failures limit')
      );

      // Recording success resets consecutive counter
      budget.recordSuccess();
      assert.strictEqual(budget.counters.consecutiveFailures, 0);
      assert.strictEqual(budget.counters.totalFailures, 2);
    });

    it('enforces runtime timeout', () => {
      const budget = new ExecutionBudget({ maxRuntimeMs: 1000 });
      // Artificially age the start time
      budget.counters.startedAt = Date.now() - 2000;

      assert.throws(
        () => budget.checkBudget(TOOL_CATEGORIES.OBSERVE, RISK_LEVELS.R0),
        (err) => err.code === ToolErrorCode.BUDGET_EXCEEDED && err.message.includes('Execution time limit')
      );
    });
  });
});
