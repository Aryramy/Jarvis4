/**
 * Unit Tests for Autonomous Output Validator (BRICK-040).
 *
 * Scope:
 * - 100% offline, deterministic tests.
 * - Validates strict JSON extraction, plan output bounds, single-tool action output,
 *   raw selector blocking, security field rejection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJsonFromCompletion,
  validatePlanOutput,
  validateActionOutput,
  AGENT_VALIDATION_ERRORS,
  AgentOutputValidationError
} from '../../src/agent/autonomous/outputValidator.js';

describe('Autonomous Output Validator Tests', () => {
  describe('extractJsonFromCompletion', () => {
    it('parses direct JSON strings', () => {
      const parsed = extractJsonFromCompletion('{"key": "value"}');
      assert.deepEqual(parsed, { key: 'value' });
    });

    it('extracts JSON enclosed in markdown code fences', () => {
      const parsed = extractJsonFromCompletion('```json\n{"action": "test"}\n```');
      assert.deepEqual(parsed, { action: 'test' });
    });

    it('extracts JSON surrounded by prose', () => {
      const text = 'Here is my decision:\n{"decision": "COMPLETE", "completionClaim": "done"}\nHope this helps!';
      const parsed = extractJsonFromCompletion(text);
      assert.equal(parsed.decision, 'COMPLETE');
    });

    it('throws AGENT_OUTPUT_INVALID for empty or malformed non-JSON output', () => {
      assert.throws(
        () => extractJsonFromCompletion('Not a json string at all'),
        (err) => err instanceof AgentOutputValidationError && err.code === AGENT_VALIDATION_ERRORS.AGENT_OUTPUT_INVALID
      );
    });
  });

  describe('validatePlanOutput', () => {
    it('accepts compliant plan with 2 to 4 milestones', () => {
      const raw = {
        goal: 'Retrieve the user order number',
        milestones: [
          { id: 'm1', description: 'Inspect page', status: 'pending' },
          { id: 'm2', description: 'Find order number', status: 'pending' }
        ]
      };
      const validated = validatePlanOutput(raw);
      assert.equal(validated.goal, raw.goal);
      assert.equal(validated.milestones.length, 2);
    });

    it('rejects plan without goal or empty goal', () => {
      assert.throws(
        () => validatePlanOutput({ milestones: [{ id: 'm1', description: 'step' }] }),
        (err) => err.code === AGENT_VALIDATION_ERRORS.AGENT_PLAN_INVALID
      );
    });

    it('rejects plan with 0 milestones or more than 4 milestones', () => {
      assert.throws(
        () => validatePlanOutput({ goal: 'test', milestones: [] }),
        (err) => err.code === AGENT_VALIDATION_ERRORS.AGENT_PLAN_INVALID
      );

      const fiveMilestones = [
        { id: 'm1', description: 'step 1' },
        { id: 'm2', description: 'step 2' },
        { id: 'm3', description: 'step 3' },
        { id: 'm4', description: 'step 4' },
        { id: 'm5', description: 'step 5' }
      ];
      assert.throws(
        () => validatePlanOutput({ goal: 'test', milestones: fiveMilestones }),
        (err) => err.code === AGENT_VALIDATION_ERRORS.AGENT_PLAN_INVALID
      );
    });
  });

  describe('validateActionOutput', () => {
    it('validates compliant TOOL decision with registered tool proposal', () => {
      const raw = {
        decision: 'TOOL',
        toolProposal: {
          tool: 'browser.inspectPage',
          arguments: { detail: 'minimal' }
        },
        reasonSummary: 'Need to inspect the static heading'
      };
      const validated = validateActionOutput(raw, ['browser.inspectPage', 'browser.click']);
      assert.equal(validated.decision, 'TOOL');
      assert.equal(validated.toolProposal.tool, 'browser.inspectPage');
    });

    it('validates COMPLETE decision with claim', () => {
      const raw = {
        decision: 'COMPLETE',
        completionClaim: 'The order number 12345 has been retrieved.'
      };
      const validated = validateActionOutput(raw);
      assert.equal(validated.decision, 'COMPLETE');
    });

    it('validates NEEDS_HUMAN_AUTH decision with reason', () => {
      const raw = {
        decision: 'NEEDS_HUMAN_AUTH',
        authReason: 'LOGIN_REQUIRED'
      };
      const validated = validateActionOutput(raw);
      assert.equal(validated.decision, 'NEEDS_HUMAN_AUTH');
    });

    it('rejects tool proposal not in allowed tools list', () => {
      const raw = {
        decision: 'TOOL',
        toolProposal: {
          tool: 'browser.upload',
          arguments: {}
        }
      };
      assert.throws(
        () => validateActionOutput(raw, ['browser.inspectPage', 'browser.click']),
        (err) => err.code === AGENT_VALIDATION_ERRORS.AGENT_TOOL_DISALLOWED
      );
    });

    it('rejects adversarial tool proposal specifying raw CSS, XPath, or Javascript', () => {
      const adversarialCss = {
        decision: 'TOOL',
        toolProposal: {
          tool: 'browser.click',
          arguments: { cssSelector: 'div > button.danger' }
        }
      };
      assert.throws(
        () => validateActionOutput(adversarialCss, ['browser.click']),
        (err) => err.code === AGENT_VALIDATION_ERRORS.AGENT_PROPOSAL_DISALLOWED_FIELD
      );

      const adversarialJs = {
        decision: 'TOOL',
        toolProposal: {
          tool: 'browser.inspectPage',
          arguments: { script: 'document.cookie' }
        }
      };
      assert.throws(
        () => validateActionOutput(adversarialJs, ['browser.inspectPage']),
        (err) => err.code === AGENT_VALIDATION_ERRORS.AGENT_PROPOSAL_DISALLOWED_FIELD
      );
    });

    it('strips or rejects model attempts to specify authoritative security state (risk, confirmed, budgetOverride)', () => {
      const maliciousSecurity = {
        decision: 'TOOL',
        risk: 'R0',
        confirmed: true,
        budgetOverride: 999,
        toolProposal: {
          tool: 'browser.inspectPage',
          arguments: {
            risk: 'LOW',
            permission: 'ROOT',
            confirmed: true
          }
        }
      };
      const validated = validateActionOutput(maliciousSecurity, ['browser.inspectPage']);
      // Authoritative security fields must be stripped completely from proposal
      assert.equal(validated.risk, undefined);
      assert.equal(validated.confirmed, undefined);
      assert.equal(validated.budgetOverride, undefined);
      assert.equal(validated.toolProposal.arguments.risk, undefined);
      assert.equal(validated.toolProposal.arguments.permission, undefined);
      assert.equal(validated.toolProposal.arguments.confirmed, undefined);
    });

    it('rejects multiple tool proposals in one response', () => {
      const multiTool = {
        decision: 'TOOL',
        toolProposal: {
          tool: 'browser.inspectPage',
          arguments: {}
        },
        additionalTools: [
          { tool: 'browser.click', arguments: {} }
        ]
      };
      assert.throws(
        () => validateActionOutput(multiTool, ['browser.inspectPage', 'browser.click']),
        (err) => err.code === AGENT_VALIDATION_ERRORS.AGENT_MULTIPLE_TOOLS_REJECTED
      );
    });
  });
});
