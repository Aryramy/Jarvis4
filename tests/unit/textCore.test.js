import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleText } from '../../src/core/textCore.js';

describe('Text Core - Brick 1', () => {
  test('should accept normal text and return deterministic response', () => {
    const result = handleText('Hello Jarvis');
    assert.equal(result.success, true);
    assert.equal(result.input, 'Hello Jarvis');
    assert.equal(result.response, 'JARVIS received: Hello Jarvis');
  });

  test('should verify correct input reaches the core', () => {
    const input = 'System status check';
    const result = handleText(input);
    assert.equal(result.success, true);
    assert.equal(result.input, input);
    assert.equal(result.response, `JARVIS received: ${input}`);
  });

  test('should normalize surrounding whitespace correctly', () => {
    const result = handleText('   Hello Jarvis   ');
    assert.equal(result.success, true);
    assert.equal(result.input, 'Hello Jarvis');
    assert.equal(result.response, 'JARVIS received: Hello Jarvis');
  });

  test('should normalize tabs and newlines surrounding text', () => {
    const result = handleText('\n\t  Multilingual readiness test  \t\n');
    assert.equal(result.success, true);
    assert.equal(result.input, 'Multilingual readiness test');
    assert.equal(result.response, 'JARVIS received: Multilingual readiness test');
  });

  test('should reject empty string safely', () => {
    const result = handleText('');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Input cannot be empty');
    assert.equal(result.input, '');
  });

  test('should reject whitespace-only string safely', () => {
    const result = handleText('     ');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Input cannot be empty');
    assert.equal(result.input, '     ');
  });

  test('should reject non-string inputs safely without crashing', () => {
    const invalidInputs = [
      null,
      undefined,
      123,
      true,
      false,
      {},
      [],
      () => {},
      Symbol('test')
    ];

    for (const invalid of invalidInputs) {
      const result = handleText(invalid);
      assert.equal(result.success, false);
      assert.equal(result.error, 'Input must be a string');
      assert.equal(result.input, invalid);
    }
  });
});
