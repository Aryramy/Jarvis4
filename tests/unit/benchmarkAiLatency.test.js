/**
 * Unit Tests for AI Latency Benchmark & Candidate Selection (Brick 15)
 *
 * Verifies all 33 requirements offline with mocked fetch harnesses.
 * Zero live network calls are made during execution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BASELINE_MODEL,
  DEFAULT_BENCHMARK_PROMPT,
  DEFAULT_TRIALS_PER_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_OUTPUT_JSON,
  DEFAULT_OUTPUT_TXT,
  sanitizeSecret,
  evaluateCorrectness,
  extractPricing,
  extractReliability,
  fetchModelCatalog,
  selectCandidates,
  calculateModelSummary,
  runSequentialBenchmark,
  formatConsoleTable,
  saveBenchmarkResult,
  parseArgs
} from '../../scripts/benchmark-ai-latency.mjs';

import { config } from '../../src/config/index.js';
import { CheaperInferenceProvider } from '../../src/providers/cheaperInference.js';
import { handleText } from '../../src/core/textCore.js';
import { ConversationSession } from '../../src/core/conversationSession.js';
import { ConversationStore } from '../../src/core/conversationStore.js';
import { VoiceTurnRunner, VoiceTurnState } from '../../src/web/voiceTurn.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = resolve(__filename, '../../..');

describe('AI Latency Benchmark - Unit Tests (Brick 15)', () => {
  // Requirement 1 & 2: Benchmark script exists and baseline is preserved
  it('1 & 2: benchmark script exists and exports required constants and functions', () => {
    const scriptPath = resolve(ROOT_DIR, 'scripts/benchmark-ai-latency.mjs');
    assert.strictEqual(existsSync(scriptPath), true, 'scripts/benchmark-ai-latency.mjs must exist');
    assert.strictEqual(DEFAULT_BASELINE_MODEL, 'deepseek-v4-flash-0731');
    assert.strictEqual(DEFAULT_BENCHMARK_PROMPT, 'What is 2 + 2? Answer with only the number.');
    assert.strictEqual(DEFAULT_TRIALS_PER_MODEL, 3);
    assert.strictEqual(DEFAULT_TIMEOUT_MS, 30000);
    assert.strictEqual(DEFAULT_MAX_CANDIDATES, 4);
  });

  // Requirement 3: Current production model is included as baseline
  it('3: current production model is included as baseline', () => {
    const candidates = selectCandidates([], DEFAULT_BASELINE_MODEL);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].id, 'deepseek-v4-flash-0731');
    assert.strictEqual(candidates[0].isBaseline, true);
  });

  // Requirement 4: Live catalog candidates can be supplied/discovered
  it('4: live catalog candidates can be supplied or discovered from catalog', async () => {
    const mockCatalog = {
      data: [
        { id: 'deepseek-v4-flash-0731', pricing: { prompt: '0.0001', completion: '0.0002' } },
        { id: 'gpt-4o-mini', pricing: { prompt: '0.00015', completion: '0.0006' } },
        { id: 'claude-3-5-haiku-20241022' },
        { id: 'gemini-2.0-flash-exp' },
        { id: 'text-embedding-ada-002' }, // should be filtered out
        { id: 'whisper-large-v3' } // should be filtered out
      ]
    };

    const mockFetch = async () => ({
      ok: true,
      json: async () => mockCatalog
    });

    const catalog = await fetchModelCatalog('https://api.cheaperinference.com/v1', 'test-key', mockFetch);
    assert.strictEqual(catalog.length, 6);

    const candidates = selectCandidates(catalog, DEFAULT_BASELINE_MODEL);
    assert.strictEqual(candidates.length, 4);
    assert.strictEqual(candidates[0].id, 'deepseek-v4-flash-0731');
    assert.strictEqual(candidates[0].isBaseline, true);
    // Non-text models should not be selected
    assert.strictEqual(candidates.some(c => c.id.includes('embed')), false);
    assert.strictEqual(candidates.some(c => c.id.includes('whisper')), false);
  });

  // Requirement 5: Benchmark limits candidate count
  it('5: benchmark limits candidate count to maxCandidates (default 4)', () => {
    const hugeCatalog = Array.from({ length: 50 }, (_, i) => ({ id: `model-flash-${i}` }));
    const candidates = selectCandidates(hugeCatalog, DEFAULT_BASELINE_MODEL, { maxCandidates: 4 });
    assert.strictEqual(candidates.length, 4);
    assert.strictEqual(candidates[0].id, DEFAULT_BASELINE_MODEL);
  });

  // Requirement 6: 3 sequential trials per model are supported
  it('6: 3 sequential trials per model are supported', async () => {
    const mockCandidates = [
      { id: 'deepseek-v4-flash-0731', isBaseline: true },
      { id: 'candidate-model-1', isBaseline: false }
    ];

    let trialCalls = 0;
    const mockFetch = async () => {
      trialCalls++;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '4' } }]
        })
      };
    };

    const result = await runSequentialBenchmark(mockCandidates, {
      apiKey: 'mock-key',
      baseUrl: 'https://api.mock.com/v1',
      trialsPerModel: 3,
      fetchFn: mockFetch
    });

    assert.strictEqual(trialCalls, 6, '2 models * 3 trials = 6 total requests');
    assert.strictEqual(result.trials.length, 6);
    assert.strictEqual(result.summary.length, 2);
    assert.strictEqual(result.summary[0].totalTrials, 3);
    assert.strictEqual(result.summary[1].totalTrials, 3);
  });

  // Requirement 7: Benchmark requests are not concurrent
  it('7: benchmark requests are strictly sequential and never concurrent', async () => {
    let concurrentCount = 0;
    let maxConcurrency = 0;

    const mockFetch = async () => {
      concurrentCount++;
      if (concurrentCount > maxConcurrency) {
        maxConcurrency = concurrentCount;
      }
      // Small delay to detect concurrency
      await new Promise(r => setTimeout(r, 10));
      concurrentCount--;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '4' } }]
        })
      };
    };

    await runSequentialBenchmark(
      [
        { id: 'model-a', isBaseline: true },
        { id: 'model-b', isBaseline: false }
      ],
      {
        apiKey: 'mock-key',
        baseUrl: 'https://api.mock.com/v1',
        trialsPerModel: 2,
        fetchFn: mockFetch
      }
    );

    assert.strictEqual(maxConcurrency, 1, 'Requests must execute one-by-one with maximum concurrency of 1');
  });

  // Requirement 8: 30000 ms timeout is respected
  it('8: 30000 ms timeout is respected and recorded as timeout', async () => {
    const mockCandidates = [{ id: 'slow-model', isBaseline: true }];

    const mockFetch = async (url, opts) => {
      return new Promise((resolve, reject) => {
        // Listen to signal abort
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('Request timed out after 50ms');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    };

    const result = await runSequentialBenchmark(mockCandidates, {
      apiKey: 'mock-key',
      baseUrl: 'https://api.mock.com/v1',
      trialsPerModel: 1,
      timeoutMs: 50,
      fetchFn: mockFetch
    });

    assert.strictEqual(result.trials.length, 1);
    assert.strictEqual(result.trials[0].success, false);
    assert.strictEqual(result.trials[0].timeout, true);
    assert.strictEqual(result.summary[0].timeouts, 1);
  });

  // Requirement 9, 10, 11, 12: Success, failure, timeout, and providerDurationMs recorded
  it('9, 10, 11, 12: records success, failure, timeout, and providerDurationMs', async () => {
    const candidates = [{ id: 'test-model', isBaseline: true }];
    let callIndex = 0;

    const mockFetch = async (url, opts) => {
      callIndex++;
      if (callIndex === 1) {
        // Success
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '4' } }] })
        };
      }
      if (callIndex === 2) {
        // HTTP Failure
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error'
        };
      }
      // Timeout
      return new Promise((_, reject) => {
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('Request timed out after 30ms');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    };

    const result = await runSequentialBenchmark(candidates, {
      apiKey: 'mock-key',
      baseUrl: 'https://api.mock.com/v1',
      trialsPerModel: 3,
      timeoutMs: 30,
      fetchFn: mockFetch
    });

    assert.strictEqual(result.trials[0].success, true);
    assert.strictEqual(result.trials[0].timeout, false);
    assert.strictEqual(typeof result.trials[0].providerDurationMs, 'number');

    assert.strictEqual(result.trials[1].success, false);
    assert.strictEqual(result.trials[1].timeout, false);
    assert.strictEqual(typeof result.trials[1].providerDurationMs, 'number');

    assert.strictEqual(result.trials[2].success, false);
    assert.strictEqual(result.trials[2].timeout, true);
    assert.strictEqual(typeof result.trials[2].providerDurationMs, 'number');
  });

  // Requirement 13, 14, 15, 16: Min, max, average, and median latency calculated correctly
  it('13, 14, 15, 16: calculates min, max, average, and median latency correctly', () => {
    const candidate = { id: 'math-model', isBaseline: true };

    // Case A: 3 trials [120, 300, 180] -> sorted [120, 180, 300]
    const trialsA = [
      { success: true, providerDurationMs: 120, correct: true, timeout: false },
      { success: true, providerDurationMs: 300, correct: true, timeout: false },
      { success: true, providerDurationMs: 180, correct: true, timeout: false }
    ];
    const summaryA = calculateModelSummary(candidate, trialsA);
    assert.strictEqual(summaryA.minMs, 120);
    assert.strictEqual(summaryA.maxMs, 300);
    assert.strictEqual(summaryA.avgMs, 200); // (120 + 300 + 180) / 3 = 200
    assert.strictEqual(summaryA.medianMs, 180); // middle of [120, 180, 300]

    // Case B: 2 successful trials [100, 200], 1 failure
    const trialsB = [
      { success: true, providerDurationMs: 100, correct: true, timeout: false },
      { success: false, providerDurationMs: 30000, correct: false, timeout: true },
      { success: true, providerDurationMs: 200, correct: true, timeout: false }
    ];
    const summaryB = calculateModelSummary(candidate, trialsB);
    assert.strictEqual(summaryB.minMs, 100);
    assert.strictEqual(summaryB.maxMs, 200);
    assert.strictEqual(summaryB.avgMs, 150);
    assert.strictEqual(summaryB.medianMs, 150); // average of [100, 200]

    // Case C: 0 successful trials
    const trialsC = [
      { success: false, providerDurationMs: 30000, correct: false, timeout: true }
    ];
    const summaryC = calculateModelSummary(candidate, trialsC);
    assert.strictEqual(summaryC.minMs, null);
    assert.strictEqual(summaryC.maxMs, null);
    assert.strictEqual(summaryC.avgMs, null);
    assert.strictEqual(summaryC.medianMs, null);
  });

  // Requirement 17: Correctness is evaluated
  it('17: evaluates response correctness for the simple benchmark prompt', () => {
    assert.strictEqual(evaluateCorrectness('4'), true);
    assert.strictEqual(evaluateCorrectness('4.'), true);
    assert.strictEqual(evaluateCorrectness('  4  '), true);
    assert.strictEqual(evaluateCorrectness('  4.  '), true);
    assert.strictEqual(evaluateCorrectness('4.0'), false);
    assert.strictEqual(evaluateCorrectness('The answer is 4'), false);
    assert.strictEqual(evaluateCorrectness('5'), false);
    assert.strictEqual(evaluateCorrectness(''), false);
    assert.strictEqual(evaluateCorrectness(null), false);
  });

  // Requirement 18: Incorrect fast response is not treated as valid winner
  it('18: incorrect fast response is NOT treated as valid winner', async () => {
    const candidates = [
      { id: 'fast-wrong-model', isBaseline: false },
      { id: 'slower-correct-model', isBaseline: true }
    ];

    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.model === 'fast-wrong-model') {
        // Fast but wrong
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'I do not know' } }] })
        };
      }
      // Slower but correct
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '4' } }] })
      };
    };

    const result = await runSequentialBenchmark(candidates, {
      apiKey: 'mock-key',
      baseUrl: 'https://api.mock.com/v1',
      trialsPerModel: 1,
      fetchFn: mockFetch
    });

    assert.strictEqual(result.fastestObservedCandidate.model, 'slower-correct-model');
  });

  // Requirement 19: Unicode responses do not break benchmark storage
  it('19: Unicode responses do not break benchmark serialization and storage', () => {
    const testFile = resolve(ROOT_DIR, 'runtime', `.test-benchmark-unicode-${Date.now()}.json`);
    try {
      const unicodeData = {
        timestamp: new Date().toISOString(),
        prompt: 'What is 2 + 2?',
        baselineModel: 'deepseek-v4-flash-0731',
        candidateModels: ['deepseek-v4-flash-0731'],
        trials: [
          {
            model: 'deepseek-v4-flash-0731',
            trial: 1,
            success: true,
            text: '4 — اردو میں چار اور عربی میں أربعة',
            correct: false
          }
        ],
        summary: []
      };

      saveBenchmarkResult(unicodeData, testFile);
      assert.strictEqual(existsSync(testFile), true);

      const loaded = JSON.parse(readFileSync(testFile, 'utf8'));
      assert.strictEqual(loaded.trials[0].text, '4 — اردو میں چار اور عربی میں أربعة');
    } finally {
      if (existsSync(testFile)) {
        rmSync(testFile, { force: true });
      }
    }
  });

  // Requirement 20, 21, 22, 23: Pricing and reliability metadata optional and missing does not fail
  it('20, 21, 22, 23: pricing and reliability metadata are optional and missing values do not fail', () => {
    // Model with complete metadata
    const completeModel = {
      id: 'full-model',
      pricing: { prompt: '0.001', completion: '0.002' },
      reliability: '99.9%'
    };
    const priceA = extractPricing(completeModel);
    const relA = extractReliability(completeModel);
    assert.strictEqual(priceA.inputPrice, '0.001');
    assert.strictEqual(priceA.outputPrice, '0.002');
    assert.strictEqual(relA, '99.9%');

    // Model with missing metadata
    const sparseModel = { id: 'sparse-model' };
    const priceB = extractPricing(sparseModel);
    const relB = extractReliability(sparseModel);
    assert.strictEqual(priceB.inputPrice, 'N/A');
    assert.strictEqual(priceB.outputPrice, 'N/A');
    assert.strictEqual(relB, 'N/A');

    // Model with null metadata
    const nullModel = null;
    const priceC = extractPricing(nullModel);
    const relC = extractReliability(nullModel);
    assert.strictEqual(priceC.inputPrice, 'N/A');
    assert.strictEqual(priceC.outputPrice, 'N/A');
    assert.strictEqual(relC, 'N/A');
  });

  // Requirement 24: Benchmark result contains no API key
  it('24: benchmark result contains no API key', async () => {
    const sensitiveKey = 'sk-cheaper-super-secret-key-12345';
    const candidates = [{ id: 'deepseek-v4-flash-0731', isBaseline: true }];

    const mockFetch = async () => {
      return {
        ok: false,
        status: 401,
        statusText: `Unauthorized with key ${sensitiveKey}`
      };
    };

    const result = await runSequentialBenchmark(candidates, {
      apiKey: sensitiveKey,
      baseUrl: 'https://api.mock.com/v1',
      trialsPerModel: 1,
      fetchFn: mockFetch
    });

    const jsonStr = JSON.stringify(result);
    assert.strictEqual(jsonStr.includes(sensitiveKey), false, 'API key must never appear in benchmark JSON');
    assert.strictEqual(jsonStr.includes('[REDACTED]'), true, 'API key must be redacted');
  });

  // Requirement 25: Benchmark artifacts use runtime/gitignored location
  it('25: benchmark artifacts use runtime gitignored location', () => {
    assert.strictEqual(DEFAULT_OUTPUT_JSON.includes('runtime'), true);
    assert.strictEqual(DEFAULT_OUTPUT_TXT.includes('runtime'), true);

    const gitignoreContent = readFileSync(resolve(ROOT_DIR, '.gitignore'), 'utf8');
    assert.strictEqual(gitignoreContent.includes('runtime/'), true, '.gitignore must ignore runtime/');
  });

  // Requirement 26 & 27: Production CHEAPER_INFERENCE_MODEL and /api/ai behavior remain unchanged
  it('26 & 27: production CHEAPER_INFERENCE_MODEL and default provider model remain unchanged', async () => {
    // Verify default baseline model constant matches production specification
    assert.strictEqual(DEFAULT_BASELINE_MODEL, 'deepseek-v4-flash-0731');

    // Verify config loader safely loads baseline without mutation
    const { loadConfig } = await import('../../src/config/index.js');
    const loaded = loadConfig({ CHEAPER_INFERENCE_MODEL: 'deepseek-v4-flash-0731' });
    assert.strictEqual(loaded.cheaperInference.model, 'deepseek-v4-flash-0731');

    // Running benchmark with candidate models must NEVER mutate process.env or production settings
    const origEnv = process.env.CHEAPER_INFERENCE_MODEL;
    process.env.CHEAPER_INFERENCE_MODEL = 'deepseek-v4-flash-0731';

    try {
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '4' } }] })
      });

      await runSequentialBenchmark(
        [
          { id: 'deepseek-v4-flash-0731', isBaseline: true },
          { id: 'other-candidate-model', isBaseline: false }
        ],
        {
          apiKey: 'mock-key',
          baseUrl: 'https://api.mock.com/v1',
          trialsPerModel: 1,
          fetchFn: mockFetch
        }
      );

      // Verify process.env.CHEAPER_INFERENCE_MODEL was NOT changed by benchmark
      assert.strictEqual(process.env.CHEAPER_INFERENCE_MODEL, 'deepseek-v4-flash-0731');

      // Verify default provider without candidate override retains configured production model
      const defaultProvider = new CheaperInferenceProvider({
        apiKey: 'mock-key',
        model: process.env.CHEAPER_INFERENCE_MODEL
      });
      assert.strictEqual(defaultProvider.model, 'deepseek-v4-flash-0731');
    } finally {
      if (origEnv !== undefined) {
        process.env.CHEAPER_INFERENCE_MODEL = origEnv;
      } else {
        delete process.env.CHEAPER_INFERENCE_MODEL;
      }
    }
  });

  // Requirement 28: Normal typed JARVIS remains unchanged
  it('28: normal typed JARVIS remains unchanged', () => {
    const result = handleText('Hello JARVIS');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.response, 'JARVIS received: Hello JARVIS');
  });

  // Requirement 29: Voice turn remains unchanged
  it('29: VoiceTurnRunner remains unchanged', () => {
    const runner = new VoiceTurnRunner({ fetchFn: async () => {} });
    assert.strictEqual(runner.state, VoiceTurnState.IDLE);
  });

  // Requirement 30 & 31: ConversationSession and ConversationStore remain unchanged
  it('30 & 31: ConversationSession and ConversationStore remain unchanged', () => {
    const session = new ConversationSession({ maxMessages: 5 });
    session.addUserMessage('User msg');
    session.addAssistantMessage('Assistant msg');
    assert.strictEqual(session.getMessages().length, 2);

    const tempFile = resolve(ROOT_DIR, 'runtime', `.test-conv-store-${Date.now()}.json`);
    const store = new ConversationStore({ filePath: tempFile });
    try {
      store.save(session.getMessages());
      const loaded = store.load();
      assert.strictEqual(loaded.length, 2);
    } finally {
      store.clear();
    }
  });

  // Requirement 32: Argument parsing works cleanly
  it('32: parseArgs parses CLI arguments correctly', () => {
    const argsA = parseArgs(['--discover']);
    assert.strictEqual(argsA.discover, true);

    const argsB = parseArgs(['--models=gpt-4o-mini,qwen-7b', '--trials=5', '--timeout=20000']);
    assert.deepStrictEqual(argsB.models, ['gpt-4o-mini', 'qwen-7b']);
    assert.strictEqual(argsB.trials, 5);
    assert.strictEqual(argsB.timeout, 20000);
  });

  // Requirement 33: Console table formatting works cleanly
  it('33: formatConsoleTable produces valid table output', () => {
    const sampleSummaries = [
      {
        id: 'deepseek-v4-flash-0731',
        isBaseline: true,
        totalTrials: 3,
        successful: 3,
        timeouts: 0,
        medianMs: 25000,
        avgMs: 25500,
        minMs: 24000,
        maxMs: 27000,
        correctCount: 3,
        inputPrice: '0.0001',
        outputPrice: '0.0002'
      }
    ];

    const table = formatConsoleTable(sampleSummaries, null);
    assert.strictEqual(typeof table, 'string');
    assert.strictEqual(table.includes('deepseek-v4-flash-0731 (BASELINE)'), true);
    assert.strictEqual(table.includes('25000 ms'), true);
  });
});
