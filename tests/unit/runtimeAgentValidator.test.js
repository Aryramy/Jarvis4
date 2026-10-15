import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateToolProposal,
  validateSemanticTarget,
  validateUrlScheme,
  detectForbiddenProperties
} from '../../src/agent/runtime/toolValidator.js';
import { ToolErrorCode } from '../../src/agent/runtime/runtimeErrors.js';

describe('ToolValidator Unit Tests (PRE-040A)', () => {
  describe('Proposal Structure & Whitelist', () => {
    it('rejects non-object proposal', () => {
      assert.throws(
        () => validateToolProposal(null),
        (err) => err.code === ToolErrorCode.TOOL_ARGUMENT_INVALID && err.message.includes('object')
      );
      assert.throws(
        () => validateToolProposal('browser.inspectPage'),
        (err) => err.code === ToolErrorCode.TOOL_ARGUMENT_INVALID
      );
    });

    it('rejects proposal without tool property', () => {
      assert.throws(
        () => validateToolProposal({ arguments: {} }),
        (err) => err.code === ToolErrorCode.TOOL_ARGUMENT_INVALID && err.message.includes('tool')
      );
    });

    it('rejects unregistered tool name', () => {
      assert.throws(
        () => validateToolProposal({ tool: 'browser.evaluate' }),
        (err) => err.code === ToolErrorCode.TOOL_NOT_REGISTERED
      );
      assert.throws(
        () => validateToolProposal({ tool: 'shell.exec' }),
        (err) => err.code === ToolErrorCode.TOOL_NOT_REGISTERED
      );
      assert.throws(
        () => validateToolProposal({ tool: 'constructor' }),
        (err) => err.code === ToolErrorCode.TOOL_NOT_REGISTERED
      );
    });

    it('rejects prohibited tool name', () => {
      assert.throws(
        () => validateToolProposal({ tool: 'browser.resumeHandoff' }),
        (err) => err.code === ToolErrorCode.BLOCKED_BY_POLICY
      );
    });
  });

  describe('Forbidden Properties & Code Injection Detection', () => {
    it('detects and rejects raw css selector', () => {
      assert.throws(
        () => validateToolProposal({
          tool: 'browser.click',
          arguments: { css: 'button.submit' }
        }),
        (err) => err.code === ToolErrorCode.FORBIDDEN_PROPERTY_DETECTED && err.message.includes('css')
      );
    });

    it('detects and rejects raw xpath', () => {
      assert.throws(
        () => validateToolProposal({
          tool: 'browser.click',
          arguments: { xpath: '//button[1]' }
        }),
        (err) => err.code === ToolErrorCode.FORBIDDEN_PROPERTY_DETECTED && err.message.includes('xpath')
      );
    });

    it('detects and rejects javascript / eval / script in arguments', () => {
      assert.throws(
        () => validateToolProposal({
          tool: 'browser.inspectPage',
          arguments: { script: 'alert(1)' }
        }),
        (err) => err.code === ToolErrorCode.FORBIDDEN_PROPERTY_DETECTED
      );
      assert.throws(
        () => validateToolProposal({
          tool: 'browser.inspectPage',
          arguments: { eval: 'console.log(1)' }
        }),
        (err) => err.code === ToolErrorCode.FORBIDDEN_PROPERTY_DETECTED
      );
      assert.throws(
        () => validateToolProposal({
          tool: 'browser.click',
          arguments: { locator: '#submit' }
        }),
        (err) => err.code === ToolErrorCode.FORBIDDEN_PROPERTY_DETECTED
      );
    });

    it('detects forbidden properties nested deeply in arguments', () => {
      assert.throws(
        () => validateToolProposal({
          tool: 'browser.fill',
          arguments: {
            target: {
              kind: 'input',
              accessibleName: 'username',
              options: {
                nested: {
                  elementHandle: 'raw_handle'
                }
              }
            },
            value: 'alice'
          }
        }),
        (err) => err.code === ToolErrorCode.FORBIDDEN_PROPERTY_DETECTED && err.message.includes('elementHandle')
      );
    });
  });

  describe('Model Security Override Rejection', () => {
    it('rejects proposal with risk override', () => {
      assert.throws(
        () => validateToolProposal({
          tool: 'browser.click',
          riskLevel: 'R0',
          arguments: { target: { kind: 'button', accessibleName: 'ok' } }
        }),
        (err) => err.code === ToolErrorCode.SECURITY_OVERRIDE_REJECTED
      );
    });

    it('rejects proposal with confirmed override', () => {
      assert.throws(
        () => validateToolProposal({
          tool: 'browser.submitForm',
          confirmed: true,
          arguments: { target: { kind: 'form', accessibleName: 'login' } }
        }),
        (err) => err.code === ToolErrorCode.SECURITY_OVERRIDE_REJECTED
      );
    });

    it('rejects proposal with bypass / isSafe / budgetOverride', () => {
      assert.throws(
        () => validateToolProposal({
          tool: 'browser.click',
          bypass: true,
          arguments: { target: { kind: 'button', accessibleName: 'ok' } }
        }),
        (err) => err.code === ToolErrorCode.SECURITY_OVERRIDE_REJECTED
      );
      assert.throws(
        () => validateToolProposal({
          tool: 'browser.click',
          budgetOverride: 9999,
          arguments: { target: { kind: 'button', accessibleName: 'ok' } }
        }),
        (err) => err.code === ToolErrorCode.SECURITY_OVERRIDE_REJECTED
      );
    });
  });

  describe('Semantic Target Validation', () => {
    it('validates valid semantic target successfully', () => {
      const target = {
        kind: 'button',
        accessibleName: 'Submit Order'
      };
      assert.doesNotThrow(() => validateSemanticTarget(target));
    });

    it('rejects target without kind', () => {
      assert.throws(
        () => validateSemanticTarget({ accessibleName: 'Submit' }),
        (err) => err.code === ToolErrorCode.TOOL_ARGUMENT_INVALID
      );
    });

    it('rejects target with invalid kind enum', () => {
      assert.throws(
        () => validateSemanticTarget({ kind: 'arbitrary_tag', accessibleName: 'Submit' }),
        (err) => err.code === ToolErrorCode.TOOL_ARGUMENT_INVALID
      );
    });

    it('rejects target without accessibleName or text or label', () => {
      assert.throws(
        () => validateSemanticTarget({ kind: 'button' }),
        (err) => err.code === ToolErrorCode.TOOL_ARGUMENT_INVALID
      );
    });
  });

  describe('URL Scheme Validation', () => {
    it('accepts safe http/https and loopback/about:blank URLs', () => {
      assert.doesNotThrow(() => validateUrlScheme('https://example.com'));
      assert.doesNotThrow(() => validateUrlScheme('http://127.0.0.1:3000/test'));
      assert.doesNotThrow(() => validateUrlScheme('about:blank'));
    });

    it('rejects dangerous protocols: javascript:, file:, data:, blob:', () => {
      assert.throws(
        () => validateUrlScheme('javascript:alert(1)'),
        (err) => err.code === ToolErrorCode.TOOL_ARGUMENT_INVALID && err.message.includes('protocol')
      );
      assert.throws(
        () => validateUrlScheme('file:///etc/passwd'),
        (err) => err.code === ToolErrorCode.TOOL_ARGUMENT_INVALID
      );
      assert.throws(
        () => validateUrlScheme('data:text/html,<script>evil()</script>'),
        (err) => err.code === ToolErrorCode.TOOL_ARGUMENT_INVALID
      );
    });

    it('rejects embedded credentials in URL', () => {
      assert.throws(
        () => validateUrlScheme('https://user:pass@example.com'),
        (err) => err.code === ToolErrorCode.TOOL_ARGUMENT_INVALID && err.message.includes('credentials')
      );
    });
  });

  describe('Context and Page Binding Requirements', () => {
    it('enforces pageId when required by tool contract', () => {
      assert.throws(
        () => validateToolProposal({
          tool: 'browser.switchPage'
        }),
        (err) => err.code === ToolErrorCode.PAGE_ID_REQUIRED && err.message.includes('pageId')
      );
    });

    it('enforces snapshotToken when required by mutating tool', () => {
      assert.throws(
        () => validateToolProposal({
          tool: 'browser.click',
          pageId: 'pg_123',
          arguments: { target: { kind: 'button', accessibleName: 'ok' } }
        }),
        (err) => err.code === ToolErrorCode.SNAPSHOT_TOKEN_REQUIRED && err.message.includes('snapshotToken')
      );
    });

    it('validates properly shaped proposal with all required fields', () => {
      const proposal = {
        tool: 'browser.click',
        pageId: 'pg_123',
        snapshotToken: 'snap_456',
        arguments: {
          target: { kind: 'button', accessibleName: 'Continue' }
        },
        reason: 'Advance checkout',
        expectedOutcome: {
          type: 'target-present',
          target: { kind: 'heading', accessibleName: 'Payment' }
        }
      };
      const validated = validateToolProposal(proposal);
      assert.strictEqual(validated.tool, 'browser.click');
      assert.strictEqual(validated.pageId, 'pg_123');
      assert.strictEqual(validated.snapshotToken, 'snap_456');
    });
  });
});
