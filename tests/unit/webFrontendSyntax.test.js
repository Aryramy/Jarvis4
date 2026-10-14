import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const INDEX_HTML_PATH = path.resolve(ROOT_DIR, 'src/web/index.html');

describe('Control Center Frontend JavaScript Syntax Regression Tests (Brick 32 Hotfix A)', () => {
  test('src/web/index.html exists and contains inline script', () => {
    assert.equal(fs.existsSync(INDEX_HTML_PATH), true, 'src/web/index.html must exist');
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const scriptMatches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(scriptMatches.length > 0, 'index.html must contain at least one inline script block');
  });

  test('inline script parses without syntax error via vm.Script', () => {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const scriptMatches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];

    for (let i = 0; i < scriptMatches.length; i++) {
      const scriptContent = scriptMatches[i][1];
      // Comment out top-level ES module import statements so vm.Script compiles without module wrapper error
      const cleanedCode = scriptContent.replace(/^([ \t]*import\s+[^;]+;)/gm, '/* $1 */');

      assert.doesNotThrow(() => {
        new vm.Script(cleanedCode, {
          filename: `src/web/index.html#script[${i}]`
        });
      }, `Inline script[${i}] in index.html must parse cleanly via vm.Script`);
    }
  });

  test('inline script parses without syntax error via node --input-type=module --check', () => {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const scriptMatches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];

    for (let i = 0; i < scriptMatches.length; i++) {
      const scriptContent = scriptMatches[i][1];
      const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
        input: scriptContent,
        encoding: 'utf8'
      });

      assert.equal(
        result.status,
        0,
        `Node syntax check failed on index.html script[${i}]:\n${result.stderr || result.stdout}`
      );
    }
  });

  test('proves vm.Script catches "Missing catch or finally after try"', () => {
    const malformedSnippet = `
      function testMalformed() {
        try {
          const x = 1;
        } else {
          const y = 2;
        }
      }
    `;

    assert.throws(
      () => {
        new vm.Script(malformedSnippet, { filename: 'malformed_try.js' });
      },
      (err) => {
        assert.equal(err instanceof SyntaxError, true);
        assert.equal(err.message.includes('Missing catch or finally after try'), true);
        return true;
      }
    );
  });

  test('proves node --input-type=module --check catches "Missing catch or finally after try"', () => {
    const malformedModule = `
      import { foo } from '/dummy.js';
      try {
        console.log(foo);
      } else {
        console.error('error');
      }
    `;

    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: malformedModule,
      encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr.includes('Missing catch or finally after try'), true);
  });
});
