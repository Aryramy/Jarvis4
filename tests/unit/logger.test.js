import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Logger, LogLevel, createLogger } from '../../src/utils/logger.js';

describe('Logger Utility', () => {
  test('should support all standard log levels (DEBUG, INFO, WARN, ERROR)', () => {
    assert.equal(LogLevel.DEBUG, 0);
    assert.equal(LogLevel.INFO, 1);
    assert.equal(LogLevel.WARN, 2);
    assert.equal(LogLevel.ERROR, 3);
  });

  test('should capture logged messages for appropriate levels', () => {
    const logs = [];
    const mockDestination = {
      debug: (msg) => logs.push({ level: 'DEBUG', msg }),
      info: (msg) => logs.push({ level: 'INFO', msg }),
      warn: (msg) => logs.push({ level: 'WARN', msg }),
      error: (msg) => logs.push({ level: 'ERROR', msg })
    };

    const logger = new Logger({
      name: 'test-logger',
      level: LogLevel.DEBUG,
      destination: mockDestination
    });

    logger.debug('Debug test message');
    logger.info('Info test message');
    logger.warn('Warn test message');
    logger.error('Error test message');

    assert.equal(logs.length, 4);
    assert.match(logs[0].msg, /\[DEBUG\] \[test-logger\]: Debug test message/);
    assert.match(logs[1].msg, /\[INFO\] \[test-logger\]: Info test message/);
    assert.match(logs[2].msg, /\[WARN\] \[test-logger\]: Warn test message/);
    assert.match(logs[3].msg, /\[ERROR\] \[test-logger\]: Error test message/);
  });

  test('should filter out messages below current log level', () => {
    const logs = [];
    const mockDestination = {
      debug: (msg) => logs.push({ level: 'DEBUG', msg }),
      info: (msg) => logs.push({ level: 'INFO', msg }),
      warn: (msg) => logs.push({ level: 'WARN', msg }),
      error: (msg) => logs.push({ level: 'ERROR', msg })
    };

    const logger = new Logger({
      name: 'filter-test',
      level: LogLevel.WARN,
      destination: mockDestination
    });

    const resDebug = logger.debug('Ignored debug');
    const resInfo = logger.info('Ignored info');
    const resWarn = logger.warn('Observed warn');
    const resError = logger.error('Observed error');

    assert.equal(resDebug, null);
    assert.equal(resInfo, null);
    assert.ok(resWarn);
    assert.ok(resError);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].level, 'WARN');
    assert.equal(logs[1].level, 'ERROR');
  });

  test('should format metadata when provided', () => {
    let captured = null;
    const mockDestination = {
      info: (msg) => { captured = msg; }
    };

    const logger = new Logger({
      name: 'meta-test',
      level: LogLevel.INFO,
      destination: mockDestination
    });

    logger.info('Test with meta', { code: 123, status: 'ok' });
    assert.match(captured, /{"code":123,"status":"ok"}/);
  });

  test('should create child logger with nested namespace', () => {
    let captured = null;
    const mockDestination = {
      info: (msg) => { captured = msg; }
    };

    const parent = new Logger({
      name: 'parent',
      level: LogLevel.INFO,
      destination: mockDestination
    });

    const child = parent.child('child');
    child.info('Hello from child');

    assert.match(captured, /\[parent:child\]: Hello from child/);
  });

  test('createLogger helper should construct a Logger instance', () => {
    const custom = createLogger('custom');
    assert.ok(custom instanceof Logger);
    assert.equal(custom.name, 'custom');
  });
});
