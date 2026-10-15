import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAllRegisteredTools,
  getRegisteredTool,
  TOOL_CATEGORIES,
  RISK_LEVELS
} from '../../src/agent/runtime/toolRegistry.js';
import {
  validateToolProposal,
  detectForbiddenProperties
} from '../../src/agent/runtime/toolValidator.js';
import { buildEvidenceEnvelope } from '../../src/agent/runtime/evidence.js';
import { ERROR_CODES, ToolErrorCode, RuntimeHarnessError } from '../../src/agent/runtime/runtimeErrors.js';

describe('Runtime Agent Tool Contracts (PRE-040A)', () => {
  describe('Tool Registry Contract Integrity', () => {
    it('all registered tools conform to the strict registry contract schema', () => {
      const allTools = getAllRegisteredTools();
      assert.ok(allTools.length >= 20, 'Should have at least 20 approved tools registered');

      const validCategories = new Set(Object.values(TOOL_CATEGORIES));
      const validRisks = new Set(Object.values(RISK_LEVELS));

      for (const tool of allTools) {
        assert.ok(typeof tool.name === 'string' && tool.name.startsWith('browser.'), `Tool name must start with browser.: ${tool.name}`);
        assert.ok(validCategories.has(tool.category), `Invalid category for ${tool.name}: ${tool.category}`);
        assert.ok(validRisks.has(tool.baseRisk), `Invalid base risk for ${tool.name}: ${tool.baseRisk}`);
        assert.strictEqual(typeof tool.isMutating, 'boolean', `isMutating must be boolean for ${tool.name}`);
        assert.strictEqual(typeof tool.requiresPageId, 'boolean', `requiresPageId must be boolean for ${tool.name}`);
        assert.strictEqual(typeof tool.requiresSnapshotToken, 'boolean', `requiresSnapshotToken must be boolean for ${tool.name}`);
        assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `Missing description for ${tool.name}`);
        assert.strictEqual(typeof tool.handler, 'function', `Handler must be a function for ${tool.name}`);
      }
    });

    it('prohibited tools are explicitly catalogued with R4 risk and PROHIBITED category', () => {
      const resumeTool = getRegisteredTool('browser.resumeHandoff');
      assert.ok(resumeTool);
      assert.strictEqual(resumeTool.category, TOOL_CATEGORIES.PROHIBITED);
      assert.strictEqual(resumeTool.baseRisk, RISK_LEVELS.R4);
    });

    it('dangerous primitives are strictly absent from the tool registry', () => {
      const forbiddenTools = [
        'browser.evaluate',
        'browser.executeScript',
        'browser.cdp',
        'browser.css',
        'browser.xpath',
        'browser.rawPage',
        'browser.decryptVault',
        'browser.getCookies',
        'browser.solveCaptcha',
        'browser.fillPassword',
        'browser.fillOtp'
      ];

      for (const name of forbiddenTools) {
        assert.strictEqual(getRegisteredTool(name), null, `Forbidden tool must not be registered: ${name}`);
      }
    });
  });

  describe('Controlled Error Codes Contract', () => {
    it('exports all mandatory architecture error codes', () => {
      const expectedCodes = [
        'TOOL_NOT_REGISTERED',
        'TOOL_ARGUMENT_INVALID',
        'FORBIDDEN_PROPERTY_DETECTED',
        'SECURITY_OVERRIDE_REJECTED',
        'BLOCKED_BY_POLICY',
        'BUDGET_EXCEEDED',
        'WAITING_USER_CONFIRMATION',
        'PENDING_ACTION_ALREADY_USED',
        'PENDING_ACTION_EXPIRED',
        'APPROVAL_STALE',
        'APPROVAL_REJECTED',
        'HUMAN_HANDOFF_ACTIVE',
        'SUBCONTEXT_OPERATION_NOT_SUPPORTED',
        'PAGE_ID_REQUIRED',
        'SNAPSHOT_TOKEN_REQUIRED'
      ];

      for (const code of expectedCodes) {
        assert.ok(ERROR_CODES[code], `Missing required error code: ${code}`);
        assert.strictEqual(ToolErrorCode[code], code);
      }
    });

    it('RuntimeHarnessError includes name, message, code, and details', () => {
      const err = new RuntimeHarnessError('Forbidden property', ERROR_CODES.FORBIDDEN_PROPERTY_DETECTED, { key: 'css' });
      assert.strictEqual(err.name, 'RuntimeHarnessError');
      assert.strictEqual(err.code, ERROR_CODES.FORBIDDEN_PROPERTY_DETECTED);
      assert.strictEqual(err.details.key, 'css');
      assert.strictEqual(err instanceof Error, true);
    });
  });

  describe('Model Security Override Rejection Contract', () => {
    it('rejects all variations of model-declared risk, permission, and confirmation overrides', () => {
      const testCases = [
        { riskLevel: 'R0' },
        { risk: 'R0' },
        { permission: 'GRANTED' },
        { confirmed: true },
        { isSafe: true },
        { bypass: true },
        { bypassSafety: true },
        { retryCount: 0 },
        { budgetOverride: 1000 },
        { systemPolicy: 'ALLOW' },
        { userApproved: true }
      ];

      for (const override of testCases) {
        assert.throws(
          () => validateToolProposal({
            tool: 'browser.click',
            ...override,
            arguments: { target: { kind: 'button', accessibleName: 'ok' } }
          }),
          (err) => err.code === ERROR_CODES.SECURITY_OVERRIDE_REJECTED,
          `Failed to reject security override: ${JSON.stringify(override)}`
        );
      }
    });
  });

  describe('No Raw Selectors Contract', () => {
    it('rejects raw selector properties across arbitrary depths in argument trees', () => {
      const forbiddenPropertySamples = [
        { selector: 'button.primary' },
        { css: '#login-btn' },
        { xpath: '//div[@id="main"]' },
        { locator: 'text=Continue' },
        { elementHandle: 'handle_123' },
        { javascript: 'window.alert(1)' },
        { script: 'document.cookie' },
        { eval: 'eval("foo")' },
        { function: '() => 42' }
      ];

      for (const sample of forbiddenPropertySamples) {
        assert.throws(
          () => detectForbiddenProperties(sample),
          (err) => err.code === ERROR_CODES.FORBIDDEN_PROPERTY_DETECTED,
          `Failed to detect forbidden property: ${JSON.stringify(sample)}`
        );
      }
    });
  });

  describe('Evidence Envelope Contract', () => {
    it('produces compliant standardized evidence envelope', () => {
      const envelope = buildEvidenceEnvelope({
        runId: 'run_12345',
        step: 2,
        tool: 'browser.fill',
        risk: 'R1',
        executed: true,
        verified: true,
        observed: { valueSet: true },
        pageId: 'pg_abc',
        contextId: 'ctx_main_1',
        documentVersion: 3,
        semanticRevision: 7,
        snapshotToken: 'snap_v3_fresh',
        elapsedMs: 25,
        expectedOutcome: { type: 'value-equals', expected: 'test' }
      });

      assert.strictEqual(envelope.runId, 'run_12345');
      assert.strictEqual(envelope.step, 2);
      assert.strictEqual(envelope.tool, 'browser.fill');
      assert.strictEqual(envelope.risk, 'R1');
      assert.strictEqual(envelope.executed, true);
      assert.strictEqual(envelope.verified, true);
      assert.strictEqual(envelope.pageId, 'pg_abc');
      assert.strictEqual(envelope.contextId, 'ctx_main_1');
      assert.strictEqual(envelope.documentVersion, 3);
      assert.strictEqual(envelope.semanticRevision, 7);
      assert.strictEqual(envelope.snapshotToken, 'snap_v3_fresh');
      assert.strictEqual(typeof envelope.elapsedMs, 'number');
      assert.ok(envelope.timestamp > 0);
      assert.ok(envelope.expectedOutcomeEvaluation);
    });
  });
});
