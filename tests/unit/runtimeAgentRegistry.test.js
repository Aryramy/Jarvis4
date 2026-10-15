import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_CATEGORIES,
  RISK_LEVELS,
  getRegisteredTool,
  isToolRegistered,
  listRegisteredToolNames
} from '../../src/agent/runtime/toolRegistry.js';
import { ERROR_CODES } from '../../src/agent/runtime/runtimeErrors.js';

describe('Runtime Agent Tool Registry (PRE-040A)', () => {
  test('defines required tool categories and risk levels', () => {
    assert.equal(TOOL_CATEGORIES.OBSERVE, 'OBSERVE');
    assert.equal(TOOL_CATEGORIES.NAVIGATE, 'NAVIGATE');
    assert.equal(TOOL_CATEGORIES.MUTATE, 'MUTATE');
    assert.equal(TOOL_CATEGORIES.TRANSFER, 'TRANSFER');
    assert.equal(TOOL_CATEGORIES.AUTH_HANDOFF, 'AUTH_HANDOFF');
    assert.equal(TOOL_CATEGORIES.CONSEQUENTIAL, 'CONSEQUENTIAL');
    assert.equal(TOOL_CATEGORIES.PROHIBITED, 'PROHIBITED');

    assert.equal(RISK_LEVELS.R0, 'R0');
    assert.equal(RISK_LEVELS.R1, 'R1');
    assert.equal(RISK_LEVELS.R2, 'R2');
    assert.equal(RISK_LEVELS.R3, 'R3');
    assert.equal(RISK_LEVELS.R4, 'R4');
  });

  test('registers approved core observation tools as R0', () => {
    const r0Tools = [
      'browser.getPageStatus',
      'browser.inspectPage',
      'browser.inspectContexts',
      'browser.inspectForms',
      'browser.extractData',
      'browser.waitForStable',
      'browser.waitForTarget',
      'browser.listPages',
      'browser.listDownloads'
    ];

    for (const name of r0Tools) {
      assert.equal(isToolRegistered(name), true, `Expected ${name} to be registered`);
      const tool = getRegisteredTool(name);
      assert.ok(tool, `Tool ${name} should have registration record`);
      assert.equal(tool.category, TOOL_CATEGORIES.OBSERVE);
      assert.equal(tool.baseRisk, RISK_LEVELS.R0);
      assert.equal(tool.isMutating, false);
      assert.equal(typeof tool.handler, 'function');
    }
  });

  test('registers approved mutation tools with appropriate base risks', () => {
    const mutations = [
      { name: 'browser.click', baseRisk: RISK_LEVELS.R1, requiresSnapshotToken: true },
      { name: 'browser.fill', baseRisk: RISK_LEVELS.R1, requiresSnapshotToken: true },
      { name: 'browser.check', baseRisk: RISK_LEVELS.R1, requiresSnapshotToken: true },
      { name: 'browser.uncheck', baseRisk: RISK_LEVELS.R1, requiresSnapshotToken: true },
      { name: 'browser.select', baseRisk: RISK_LEVELS.R1, requiresSnapshotToken: true },
      { name: 'browser.fillForm', baseRisk: RISK_LEVELS.R2, requiresSnapshotToken: true }
    ];

    for (const m of mutations) {
      assert.equal(isToolRegistered(m.name), true);
      const tool = getRegisteredTool(m.name);
      assert.equal(tool.category, TOOL_CATEGORIES.MUTATE);
      assert.equal(tool.baseRisk, m.baseRisk);
      assert.equal(tool.isMutating, true);
      assert.equal(tool.requiresSnapshotToken, m.requiresSnapshotToken);
    }
  });

  test('registers form submission as R3 consequential action requiring confirmation', () => {
    const submit = getRegisteredTool('browser.submitForm');
    assert.ok(submit);
    assert.equal(submit.category, TOOL_CATEGORIES.CONSEQUENTIAL);
    assert.equal(submit.baseRisk, RISK_LEVELS.R3);
    assert.equal(submit.isMutating, true);
    assert.equal(submit.confirmationRequired, true);
    assert.equal(submit.budgetCounter, 'submissions');
  });

  test('registers resumeHandoff as R4 PROHIBITED for autonomous agent', async () => {
    const resume = getRegisteredTool('browser.resumeHandoff');
    assert.ok(resume);
    assert.equal(resume.category, TOOL_CATEGORIES.PROHIBITED);
    assert.equal(resume.baseRisk, RISK_LEVELS.R4);

    await assert.rejects(
      async () => resume.handler(),
      (err) => err.code === ERROR_CODES.BLOCKED_BY_POLICY
    );
  });

  test('rejects unknown tool names cleanly', () => {
    assert.equal(isToolRegistered('browser.unknown'), false);
    assert.equal(isToolRegistered('shell.exec'), false);
    assert.equal(isToolRegistered('playwright.evaluate'), false);
    assert.equal(isToolRegistered('__proto__'), false);
    assert.equal(isToolRegistered('constructor'), false);

    assert.equal(getRegisteredTool('browser.unknown'), null);
    assert.equal(getRegisteredTool(''), null);
    assert.equal(getRegisteredTool(null), null);
    assert.equal(getRegisteredTool(123), null);
  });

  test('listRegisteredToolNames returns comprehensive list without raw code capabilities', () => {
    const list = listRegisteredToolNames();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 25);
    assert.ok(list.includes('browser.navigate'));
    assert.ok(list.includes('browser.click'));
    assert.ok(list.includes('browser.submitForm'));

    assert.equal(list.includes('eval'), false);
    assert.equal(list.includes('playwright.evaluate'), false);
    assert.equal(list.includes('page.evaluate'), false);
  });
});
