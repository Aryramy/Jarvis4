import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleText } from '../../src/core/textCore.js';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT_DIR = resolve(__dirname, '../..');
const CLI_PATH = resolve(ROOT_DIR, 'src/cli/jarvis.js');

describe('Brick 1 Regression Protection', () => {
  test('handleText returns strictly deterministic response with no fake AI content', () => {
    const prompt = 'Run test inquiry';
    const result = handleText(prompt);

    assert.equal(result.success, true);
    assert.equal(result.response, `JARVIS received: ${prompt}`);
    assert.doesNotMatch(result.response, /searched the internet|ai assistant|weather forecast|i am jarvis ai/i);
  });

  test('handleText preserves internal punctuation and unicode characters in input', () => {
    const unicodeInput = 'Salam Jarvis! ٹیسٹ 123';
    const result = handleText(unicodeInput);

    assert.equal(result.success, true);
    assert.equal(result.input, unicodeInput);
    assert.equal(result.response, `JARVIS received: ${unicodeInput}`);
  });

  test('CLI process executes and produces expected output for valid text', () => {
    const proc = spawnSync(process.execPath, [CLI_PATH, 'Hello Jarvis'], {
      cwd: ROOT_DIR,
      encoding: 'utf8'
    });

    assert.equal(proc.status, 0);
    assert.equal(proc.stdout.trim(), 'JARVIS received: Hello Jarvis');
  });

  test('CLI process exits with error code 1 when no input is provided', () => {
    const proc = spawnSync(process.execPath, [CLI_PATH], {
      cwd: ROOT_DIR,
      encoding: 'utf8'
    });

    assert.equal(proc.status, 1);
    assert.match(proc.stderr, /Error: Input cannot be empty/);
  });
});
