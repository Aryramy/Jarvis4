import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FOUNDATION_INFO, getSystemStatus } from '../../src/core/index.js';
import { logger } from '../../src/utils/logger.js';
import { config } from '../../src/config/index.js';

describe('Brick 0 Foundation Smoke Test', () => {
  test('Node.js runtime meets minimum engine requirements (>=20)', () => {
    const versionMatch = process.version.match(/^v(\d+)\./);
    assert.ok(versionMatch, 'process.version should match semantic versioning');
    const major = parseInt(versionMatch[1], 10);
    assert.ok(major >= 20, `Node major version must be >= 20, detected: ${major}`);
  });

  test('Foundation metadata reports Brick 0 accurately', () => {
    assert.equal(FOUNDATION_INFO.brick, 0);
    assert.equal(FOUNDATION_INFO.name, 'JARVIS4');
    assert.equal(FOUNDATION_INFO.status, 'FOUNDATION');
  });

  test('Core system status reports valid config and timestamp', () => {
    const status = getSystemStatus();
    assert.equal(status.brick, 0);
    assert.ok(status.timestamp);
    assert.ok(status.config);
    assert.ok(['development', 'test', 'production'].includes(status.config.nodeEnv));
    assert.ok(['debug', 'info', 'warn', 'error'].includes(status.config.logLevel));
  });

  test('Core utilities export valid instances', () => {
    assert.ok(logger, 'Default logger should be exported');
    assert.ok(config, 'Default config should be exported');
    assert.equal(typeof logger.info, 'function');
  });
});
