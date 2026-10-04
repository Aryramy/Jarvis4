import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/index.js';

describe('Configuration Utility', () => {
  test('should load default configuration when no environment is set', () => {
    const cfg = loadConfig({ NODE_ENV: 'development', LOG_LEVEL: 'info' });
    assert.equal(cfg.nodeEnv, 'development');
    assert.equal(cfg.logLevel, 'info');
    assert.equal(cfg.isProduction, false);
    assert.equal(cfg.isTest, false);
  });

  test('should recognize test environment', () => {
    const cfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'warn' });
    assert.equal(cfg.nodeEnv, 'test');
    assert.equal(cfg.logLevel, 'warn');
    assert.equal(cfg.isTest, true);
    assert.equal(cfg.isProduction, false);
  });

  test('should recognize production environment', () => {
    const cfg = loadConfig({ NODE_ENV: 'production', LOG_LEVEL: 'error' });
    assert.equal(cfg.nodeEnv, 'production');
    assert.equal(cfg.logLevel, 'error');
    assert.equal(cfg.isProduction, true);
    assert.equal(cfg.isTest, false);
  });

  test('should reject invalid NODE_ENV', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'invalid_env' }),
      /Invalid NODE_ENV/
    );
  });

  test('should reject invalid LOG_LEVEL', () => {
    assert.throws(
      () => loadConfig({ LOG_LEVEL: 'verbose_invalid' }),
      /Invalid LOG_LEVEL/
    );
  });
});
