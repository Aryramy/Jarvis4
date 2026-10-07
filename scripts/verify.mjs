#!/usr/bin/env node

/**
 * Verification Script for JARVIS4 (Bricks 0, 1, 2, and 3)
 *
 * Verifies:
 * 1. Project structure & required foundation & brick files
 * 2. Configuration & project sanity (package.json, environment, modules)
 * 3. JavaScript syntax validation across all source, script, and test files
 * 4. Automated test suite execution across all test suites (using offline mocks for external APIs)
 *
 * Exit code:
 * 0 = PASS
 * non-zero = FAIL
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT_DIR = resolve(__dirname, '..');

const REQUIRED_FILES = [
  'AGENTS.md',
  'README.md',
  'package.json',
  '.gitignore',
  '.env.example',
  'docs/PRD.md',
  'docs/ARCHITECTURE.md',
  'docs/CURRENT_STATE.md',
  'docs/TASKS.md',
  'docs/DECISIONS.md',
  'docs/KNOWN_ISSUES.md',
  'src/core/index.js',
  'src/core/textCore.js',
  'src/core/conversationSession.js',
  'src/cli/jarvis.js',
  'src/cli/ai.js',
  'src/web/server.js',
  'src/web/index.html',
  'src/web/microphone.js',
  'src/providers/base.js',
  'src/providers/cheaperInference.js',
  'src/config/index.js',
  'src/utils/logger.js',
  'scripts/verify.mjs',
  'tests/unit/logger.test.js',
  'tests/unit/config.test.js',
  'tests/unit/textCore.test.js',
  'tests/unit/cheaperInference.test.js',
  'tests/unit/conversationSession.test.js',
  'tests/unit/microphone.test.js',
  'tests/smoke/foundation.test.js',
  'tests/regression/brick1Regression.test.js',
  'tests/integration/webServer.test.js'
];

const REQUIRED_DIRS = [
  'docs',
  'src/core',
  'src/cli',
  'src/web',
  'src/providers',
  'src/config',
  'src/utils',
  'tests/unit',
  'tests/integration',
  'tests/contract',
  'tests/regression',
  'tests/smoke',
  'scripts'
];

let failedChecks = 0;

function printHeader(title) {
  console.log(`\n==================================================`);
  console.log(`  ${title}`);
  console.log(`==================================================`);
}

function check(title, fn) {
  process.stdout.write(`• ${title} ... `);
  try {
    fn();
    console.log(`\x1b[32mPASS\x1b[0m`);
  } catch (error) {
    console.log(`\x1b[31mFAIL\x1b[0m`);
    console.error(`  Error: ${error.message}`);
    failedChecks++;
  }
}

function collectFiles(dir, extensions = ['.js', '.mjs']) {
  const results = [];
  const list = readdirSync(dir);
  for (const file of list) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      results.push(...collectFiles(filePath, extensions));
    } else if (extensions.some(ext => file.endsWith(ext))) {
      results.push(filePath);
    }
  }
  return results;
}

printHeader('JARVIS4 — Verification');

// 1. Structure Verification
check('Directory Structure Verification', () => {
  for (const dir of REQUIRED_DIRS) {
    const fullPath = resolve(ROOT_DIR, dir);
    if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) {
      throw new Error(`Missing required directory: ${dir}`);
    }
  }
});

check('Required Files Verification', () => {
  for (const relPath of REQUIRED_FILES) {
    const fullPath = resolve(ROOT_DIR, relPath);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      throw new Error(`Missing required file: ${relPath}`);
    }
  }
});

// 2. Project & Config Sanity
check('Package.json Sanity Check', () => {
  const pkgContent = readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgContent);
  if (pkg.name !== 'jarvis4') throw new Error('package.json name must be "jarvis4"');
  if (pkg.type !== 'module') throw new Error('package.json must specify "type": "module"');
  if (!pkg.scripts?.test) throw new Error('package.json missing "test" script');
  if (!pkg.scripts?.jarvis) throw new Error('package.json missing "jarvis" script');
  if (!pkg.scripts?.web) throw new Error('package.json missing "web" script');
  if (!pkg.scripts?.ai) throw new Error('package.json missing "ai" script');
  if (!pkg.scripts?.verify) throw new Error('package.json missing "verify" script');
});

check('Environment Example Sanity Check', () => {
  const envContent = readFileSync(resolve(ROOT_DIR, '.env.example'), 'utf8');
  const lines = envContent.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('=');
    const key = parts[0].trim();
    const val = parts.slice(1).join('=').trim();
    // Ensure API keys are placeholders and no real secret is committed
    if (key.includes('KEY') || key.includes('SECRET')) {
      if (val !== '' && !val.startsWith('your_') && !val.startsWith('<')) {
        throw new Error(`Real or non-empty secret detected in .env.example for key: ${key}`);
      }
    }
  }
});

check('Config & Logger Module Sanity Check', async () => {
  const { loadConfig } = await import('../src/config/index.js');
  const testConfig = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
  if (testConfig.nodeEnv !== 'test') throw new Error('Config failed to parse nodeEnv');
  if (!testConfig.cheaperInference) throw new Error('Config missing cheaperInference settings');

  const { Logger, LogLevel } = await import('../src/utils/logger.js');
  const testLogger = new Logger({ level: LogLevel.ERROR, destination: { error: () => {} } });
  const logged = testLogger.error('Verification sanity log');
  if (!logged) throw new Error('Logger sanity check failed');
});

check('Text Core Module Sanity Check', async () => {
  const { handleText } = await import('../src/core/textCore.js');
  const result = handleText('Sanity Check');
  if (!result.success || result.response !== 'JARVIS received: Sanity Check') {
    throw new Error('Text core sanity check failed');
  }
});

check('Web Server Module Sanity Check', async () => {
  const { createServer, createRequestListener } = await import('../src/web/server.js');
  if (typeof createServer !== 'function' || typeof createRequestListener !== 'function') {
    throw new Error('Web server module failed to export factory functions');
  }
});

check('AI Provider Module Sanity Check', async () => {
  const { AIProvider } = await import('../src/providers/base.js');
  const { CheaperInferenceProvider } = await import('../src/providers/cheaperInference.js');
  const provider = new CheaperInferenceProvider({
    apiKey: 'mock-key',
    model: 'mock-model'
  });
  if (!(provider instanceof AIProvider)) {
    throw new Error('CheaperInferenceProvider must inherit from AIProvider');
  }
  if (typeof provider.generate !== 'function') {
    throw new Error('Provider must implement generate() method');
  }
  if (typeof provider.generateMessages !== 'function') {
    throw new Error('Provider must implement generateMessages() method');
  }
  if (typeof provider.streamMessages !== 'function') {
    throw new Error('Provider must implement streamMessages() method');
  }
});

check('Conversation Session Sanity Check', async () => {
  const { ConversationSession } = await import('../src/core/conversationSession.js');
  const session = new ConversationSession({ maxMessages: 5 });
  session.addUserMessage('Sanity user');
  session.addAssistantMessage('Sanity assistant');
  const msgs = session.getMessages();
  if (msgs.length !== 2 || msgs[0].content !== 'Sanity user' || msgs[1].content !== 'Sanity assistant') {
    throw new Error('Conversation session sanity check failed');
  }
  session.clear();
  if (session.getMessages().length !== 0) {
    throw new Error('Conversation session clear failed');
  }
});

check('Conversation Store Sanity Check', async () => {
  const { ConversationStore } = await import('../src/core/conversationStore.js');
  const tempPath = resolve(ROOT_DIR, 'runtime', `.sanity-store-${Date.now()}.json`);
  const store = new ConversationStore({ filePath: tempPath });
  try {
    const initial = store.load();
    if (!Array.isArray(initial) || initial.length !== 0) {
      throw new Error('Conversation store initial load failed');
    }
    store.save([{ role: 'user', content: 'Sanity store' }]);
    const loaded = store.load();
    if (loaded.length !== 1 || loaded[0].content !== 'Sanity store') {
      throw new Error('Conversation store save/load failed');
    }
    store.clear();
    if (store.load().length !== 0) {
      throw new Error('Conversation store clear failed');
    }
  } finally {
    store.clear();
  }
});

check('Microphone Capture Module Sanity Check', async () => {
  const { MicrophoneRecorder } = await import('../src/web/microphone.js');
  const recorder = new MicrophoneRecorder();
  if (recorder.state !== 'idle') {
    throw new Error('MicrophoneRecorder initial state must be idle');
  }
  if (typeof recorder.start !== 'function' || typeof recorder.stop !== 'function') {
    throw new Error('MicrophoneRecorder must implement start and stop methods');
  }
  if (typeof recorder.cleanup !== 'function' || typeof recorder.isSupported !== 'function') {
    throw new Error('MicrophoneRecorder must implement cleanup and isSupported methods');
  }
});

// 3. Syntax Validation across all JS/MJS files
check('JavaScript Syntax Validation (node --check)', () => {
  const searchDirs = ['src', 'tests', 'scripts'];
  const allJsFiles = [];
  for (const dir of searchDirs) {
    const fullDir = resolve(ROOT_DIR, dir);
    if (existsSync(fullDir)) {
      allJsFiles.push(...collectFiles(fullDir, ['.js', '.mjs']));
    }
  }

  for (const filePath of allJsFiles) {
    const rel = relative(ROOT_DIR, filePath);
    const result = spawnSync(process.execPath, ['--check', filePath], {
      cwd: ROOT_DIR,
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      throw new Error(`Syntax error in ${rel}:\n${result.stderr || result.stdout}`);
    }
  }
});

// 4. Automated Tests
printHeader('Running Automated Test Suite');

const testFiles = collectFiles(resolve(ROOT_DIR, 'tests'), ['.test.js']).sort();

const testRun = spawnSync(process.execPath, [
  '--test',
  ...testFiles
], {
  cwd: ROOT_DIR,
  stdio: 'inherit'
});

if (testRun.status !== 0) {
  console.error('\n\x1b[31mAutomated tests failed.\x1b[0m');
  failedChecks++;
} else {
  console.log('\n\x1b[32mAll automated tests passed successfully.\x1b[0m');
}

// Summary
printHeader('Verification Summary');
if (failedChecks === 0) {
  console.log('\x1b[32mALL VERIFICATION CHECKS PASSED (Exit Code: 0)\x1b[0m\n');
  process.exit(0);
} else {
  console.error(`\x1b[31mVERIFICATION FAILED with ${failedChecks} failed check(s) (Exit Code: 1)\x1b[0m\n`);
  process.exit(1);
}
