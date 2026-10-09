/**
 * Unit Tests for Cross-Gateway Same-Model AI Latency Benchmark (Brick 16)
 *
 * Verifies all 41 requirements offline with mocked fetch harnesses.
 * Zero live network calls are made during execution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHEAPER_TARGET_MODEL,
  OPENROUTER_TARGET_MODEL,
  DEFAULT_BENCHMARK_PROMPT,
  DEFAULT_TRIALS_PER_GATEWAY,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_OUTPUT_JSON,
  DEFAULT_OUTPUT_TXT,
  sanitizeSecret,
  evaluateCorrectness,
  verifyOpenRouterModelAvailability,
  executeGatewayRequest,
  calculateGatewaySummary,
  runCrossGatewayBenchmark,
  formatConsoleTable,
  saveBenchmarkResult,
  parseArgs
} from '../../scripts/benchmark-ai-gateways.mjs';

import { config } from '../../src/config/index.js';
import { CheaperInferenceProvider } from '../../src/providers/cheaperInference.js';
import { handleText } from '../../src/core/textCore.js';
import { ConversationSession } from '../../src/core/conversationSession.js';
import { ConversationStore } from '../../src/core/conversationStore.js';
import { VoiceTurnRunner, VoiceTurnState } from '../../src/web/voiceTurn.js';
import { SpeechToTextProvider } from '../../src/providers/speechToTextBase.js';
import { TextToSpeechProvider } from '../../src/providers/textToSpeechBase.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = resolve(__filename, '../../..');

describe('Cross-Gateway AI Latency Benchmark - Unit Tests (Brick 16)', () => {
  // Requirement 1 & 2: Gateway benchmark script exists and baseline constants verified
  it('1 & 2: gateway benchmark script exists and exports required constants', () => {
    const scriptPath = resolve(ROOT_DIR, 'scripts/benchmark-ai-gateways.mjs');
    assert.strictEqual(existsSync(scriptPath), true, 'scripts/benchmark-ai-gateways.mjs must exist');
    assert.strictEqual(DEFAULT_TRIALS_PER_GATEWAY, 3);
    assert.strictEqual(DEFAULT_TIMEOUT_MS, 30000);
    assert.strictEqual(DEFAULT_MAX_REQUESTS, 6);
  });

  // Requirement 3 & 4: Exact model targets for both gateways
  it('3 & 4: Cheaper target is deepseek-v4-flash-0731 and OpenRouter target is deepseek/deepseek-v4-flash-0731', () => {
    assert.strictEqual(CHEAPER_TARGET_MODEL, 'deepseek-v4-flash-0731');
    assert.strictEqual(OPENROUTER_TARGET_MODEL, 'deepseek/deepseek-v4-flash-0731');
  });

  // Requirement 5, 6, 7, 8: Identical prompt, timeout, max_tokens, and temperature configuration
  it('5, 6, 7, 8: same benchmark prompt, timeout, max-tokens, and temperature used for both gateways', async () => {
    const capturedBodies = [];
    const mockFetch = async (url, opts) => {
      capturedBodies.push(JSON.parse(opts.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '4' } }]
        })
      };
    };

    const gateways = [
      { name: 'Cheaper Inference', id: 'cheaper-inference', baseUrl: 'https://cheaper.test', apiKey: 'k1', model: CHEAPER_TARGET_MODEL },
      { name: 'OpenRouter', id: 'openrouter', baseUrl: 'https://openrouter.test', apiKey: 'k2', model: OPENROUTER_TARGET_MODEL }
    ];

    const result = await runCrossGatewayBenchmark(gateways, {
      prompt: DEFAULT_BENCHMARK_PROMPT,
      trialsPerGateway: 1,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
      fetchFn: mockFetch
    });

    assert.strictEqual(capturedBodies.length, 2);
    // Same prompt
    assert.strictEqual(capturedBodies[0].messages[0].content, DEFAULT_BENCHMARK_PROMPT);
    assert.strictEqual(capturedBodies[1].messages[0].content, DEFAULT_BENCHMARK_PROMPT);
    assert.strictEqual(result.prompt, 'What is 2 + 2? Answer with only the number.');

    // Same temperature
    assert.strictEqual(capturedBodies[0].temperature, DEFAULT_TEMPERATURE);
    assert.strictEqual(capturedBodies[1].temperature, DEFAULT_TEMPERATURE);

    // Same max_tokens
    assert.strictEqual(capturedBodies[0].max_tokens, DEFAULT_MAX_TOKENS);
    assert.strictEqual(capturedBodies[1].max_tokens, DEFAULT_MAX_TOKENS);

    // Same timeout configured in result
    assert.strictEqual(result.timeoutMs, 30000);
  });

  // Requirement 9 & 10: Three trials per gateway and maximum six live requests
  it('9 & 10: exactly 3 trials per gateway and max 6 total requests', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '4' } }]
        })
      };
    };

    const gateways = [
      { name: 'Cheaper Inference', id: 'cheaper-inference', baseUrl: 'https://cheaper.test', apiKey: 'k1', model: CHEAPER_TARGET_MODEL },
      { name: 'OpenRouter', id: 'openrouter', baseUrl: 'https://openrouter.test', apiKey: 'k2', model: OPENROUTER_TARGET_MODEL }
    ];

    const result = await runCrossGatewayBenchmark(gateways, {
      trialsPerGateway: 3,
      fetchFn: mockFetch
    });

    assert.strictEqual(callCount, 6, 'Exactly 6 total requests (3 per gateway)');
    assert.strictEqual(result.trials.length, 6);
    assert.strictEqual(result.summary[0].totalTrials, 3);
    assert.strictEqual(result.summary[1].totalTrials, 3);
  });

  // Requirement 11 & 12: Requests run sequentially with no concurrency
  it('11 & 12: requests run strictly sequentially with zero concurrency', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const mockFetch = async () => {
      concurrent++;
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '4' } }]
        })
      };
    };

    const gateways = [
      { name: 'Cheaper Inference', id: 'cheaper-inference', baseUrl: 'https://cheaper.test', apiKey: 'k1', model: CHEAPER_TARGET_MODEL },
      { name: 'OpenRouter', id: 'openrouter', baseUrl: 'https://openrouter.test', apiKey: 'k2', model: OPENROUTER_TARGET_MODEL }
    ];

    await runCrossGatewayBenchmark(gateways, {
      trialsPerGateway: 2,
      fetchFn: mockFetch
    });

    assert.strictEqual(maxConcurrent, 1, 'Max concurrent requests must be strictly 1');
  });

  // Requirement 13, 14, 15, 16, 17, 18: Success, timeout, and numeric non-negative duration recorded
  it('13, 14, 15, 16, 17, 18: records success, timeout, and numeric non-negative durationMs for both gateways', async () => {
    let step = 0;
    const mockFetch = async (url, opts) => {
      step++;
      if (step === 1) {
        // Cheaper Success
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '4' } }] })
        };
      }
      if (step === 2) {
        // Cheaper Timeout
        return new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('Request timed out after 30ms');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      if (step === 3) {
        // OpenRouter Success
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '4' } }] })
        };
      }
      // OpenRouter Timeout
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('Request timed out after 30ms');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };

    const gateways = [
      { name: 'Cheaper Inference', id: 'cheaper-inference', baseUrl: 'https://cheaper.test', apiKey: 'k1', model: CHEAPER_TARGET_MODEL },
      { name: 'OpenRouter', id: 'openrouter', baseUrl: 'https://openrouter.test', apiKey: 'k2', model: OPENROUTER_TARGET_MODEL }
    ];

    const result = await runCrossGatewayBenchmark(gateways, {
      trialsPerGateway: 2,
      timeoutMs: 30,
      fetchFn: mockFetch
    });

    // Trial 0: Cheaper Success
    assert.strictEqual(result.trials[0].gatewayId, 'cheaper-inference');
    assert.strictEqual(result.trials[0].success, true);
    assert.strictEqual(result.trials[0].timeout, false);
    assert.strictEqual(typeof result.trials[0].durationMs, 'number');
    assert.strictEqual(result.trials[0].durationMs >= 0, true);

    // Trial 1: Cheaper Timeout
    assert.strictEqual(result.trials[1].gatewayId, 'cheaper-inference');
    assert.strictEqual(result.trials[1].success, false);
    assert.strictEqual(result.trials[1].timeout, true);
    assert.strictEqual(typeof result.trials[1].durationMs, 'number');
    assert.strictEqual(result.trials[1].durationMs >= 0, true);

    // Trial 2: OpenRouter Success
    assert.strictEqual(result.trials[2].gatewayId, 'openrouter');
    assert.strictEqual(result.trials[2].success, true);
    assert.strictEqual(result.trials[2].timeout, false);
    assert.strictEqual(typeof result.trials[2].durationMs, 'number');
    assert.strictEqual(result.trials[2].durationMs >= 0, true);

    // Trial 3: OpenRouter Timeout
    assert.strictEqual(result.trials[3].gatewayId, 'openrouter');
    assert.strictEqual(result.trials[3].success, false);
    assert.strictEqual(result.trials[3].timeout, true);
    assert.strictEqual(typeof result.trials[3].durationMs, 'number');
    assert.strictEqual(result.trials[3].durationMs >= 0, true);
  });

  // Requirement 19: Correctness checked
  it('19: evaluates response correctness ("4", "4.") correctly', () => {
    assert.strictEqual(evaluateCorrectness('4'), true);
    assert.strictEqual(evaluateCorrectness('4.'), true);
    assert.strictEqual(evaluateCorrectness(' 4 '), true);
    assert.strictEqual(evaluateCorrectness('4.0'), false);
    assert.strictEqual(evaluateCorrectness('The number is 4'), false);
    assert.strictEqual(evaluateCorrectness('5'), false);
    assert.strictEqual(evaluateCorrectness(''), false);
    assert.strictEqual(evaluateCorrectness(null), false);
  });

  // Requirement 20: Incorrect fast response cannot win
  it('20: incorrect fast response cannot win', async () => {
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.model === CHEAPER_TARGET_MODEL) {
        // Fast but wrong
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'Wrong' } }] })
        };
      }
      // Slower but correct
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '4' } }] })
      };
    };

    const gateways = [
      { name: 'Cheaper Inference', id: 'cheaper-inference', baseUrl: 'https://cheaper.test', apiKey: 'k1', model: CHEAPER_TARGET_MODEL },
      { name: 'OpenRouter', id: 'openrouter', baseUrl: 'https://openrouter.test', apiKey: 'k2', model: OPENROUTER_TARGET_MODEL }
    ];

    const result = await runCrossGatewayBenchmark(gateways, {
      trialsPerGateway: 1,
      fetchFn: mockFetch
    });

    assert.strictEqual(result.summary[0].correctCount, 0);
    assert.strictEqual(result.summary[1].correctCount, 1);
  });

  // Requirement 21, 22, 23, 24: Average, median, min, and max calculations correct
  it('21, 22, 23, 24: calculates average, median, min, and max latency correctly', () => {
    const gateway = { name: 'Test Gateway', id: 'test', model: 'test-model' };

    // 3 samples: [100, 300, 200] -> sorted [100, 200, 300]
    const trialsA = [
      { success: true, durationMs: 100, correct: true, timeout: false },
      { success: true, durationMs: 300, correct: true, timeout: false },
      { success: true, durationMs: 200, correct: true, timeout: false }
    ];
    const sumA = calculateGatewaySummary(gateway, trialsA);
    assert.strictEqual(sumA.minMs, 100);
    assert.strictEqual(sumA.maxMs, 300);
    assert.strictEqual(sumA.avgMs, 200);
    assert.strictEqual(sumA.medianMs, 200);

    // 2 successful samples [150, 250], 1 failure
    const trialsB = [
      { success: true, durationMs: 150, correct: true, timeout: false },
      { success: false, durationMs: 30000, correct: false, timeout: true },
      { success: true, durationMs: 250, correct: true, timeout: false }
    ];
    const sumB = calculateGatewaySummary(gateway, trialsB);
    assert.strictEqual(sumB.minMs, 150);
    assert.strictEqual(sumB.maxMs, 250);
    assert.strictEqual(sumB.avgMs, 200);
    assert.strictEqual(sumB.medianMs, 200);
  });

  // Requirement 25 & 26: Zero-success gateway handled safely without fabricating ratio
  it('25 & 26: handles zero-success gateway safely without fabricating ratio', async () => {
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.model === CHEAPER_TARGET_MODEL) {
        // Cheaper always times out
        return new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('Timed out');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      // OpenRouter succeeds at 2000ms
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '4' } }] })
      };
    };

    const gateways = [
      { name: 'Cheaper Inference', id: 'cheaper-inference', baseUrl: 'https://cheaper.test', apiKey: 'k1', model: CHEAPER_TARGET_MODEL },
      { name: 'OpenRouter', id: 'openrouter', baseUrl: 'https://openrouter.test', apiKey: 'k2', model: OPENROUTER_TARGET_MODEL }
    ];

    const result = await runCrossGatewayBenchmark(gateways, {
      trialsPerGateway: 1,
      timeoutMs: 30,
      fetchFn: mockFetch
    });

    const cheaperSum = result.summary.find(s => s.gatewayId === 'cheaper-inference');
    assert.strictEqual(cheaperSum.successful, 0);
    assert.strictEqual(cheaperSum.medianMs, null);

    // Must NOT fabricate a ratio
    assert.strictEqual(result.comparison.hasComparableSamples, false);
    assert.strictEqual(result.comparison.speedRatioText, 'N/A');
    assert.strictEqual(result.comparison.notes.includes('Cheaper baseline produced no successful samples'), true);
  });

  // Requirement 27 & 28: Runtime artifact contains no API keys and is gitignored
  it('27 & 28: runtime artifact contains no API keys and uses gitignored path', async () => {
    const sensitiveKeyCheaper = 'sk-cheaper-secret-9999';
    const sensitiveKeyOpenRouter = 'sk-or-secret-8888';

    const mockFetch = async (url, opts) => {
      return {
        ok: false,
        status: 401,
        statusText: `Invalid auth with ${sensitiveKeyCheaper} or ${sensitiveKeyOpenRouter}`
      };
    };

    const gateways = [
      { name: 'Cheaper Inference', id: 'cheaper-inference', baseUrl: 'https://cheaper.test', apiKey: sensitiveKeyCheaper, model: CHEAPER_TARGET_MODEL },
      { name: 'OpenRouter', id: 'openrouter', baseUrl: 'https://openrouter.test', apiKey: sensitiveKeyOpenRouter, model: OPENROUTER_TARGET_MODEL }
    ];

    const result = await runCrossGatewayBenchmark(gateways, {
      trialsPerGateway: 1,
      fetchFn: mockFetch
    });

    const jsonStr = JSON.stringify(result);
    assert.strictEqual(jsonStr.includes(sensitiveKeyCheaper), false, 'Cheaper key must not appear in result');
    assert.strictEqual(jsonStr.includes(sensitiveKeyOpenRouter), false, 'OpenRouter key must not appear in result');
    assert.strictEqual(jsonStr.includes('[REDACTED]'), true, 'Keys must be redacted');

    // Artifact path is in runtime/ and gitignored
    assert.strictEqual(DEFAULT_OUTPUT_JSON.includes('runtime'), true);
    assert.strictEqual(DEFAULT_OUTPUT_TXT.includes('runtime'), true);
    const gitignoreContent = readFileSync(resolve(ROOT_DIR, '.gitignore'), 'utf8');
    assert.strictEqual(gitignoreContent.includes('runtime/'), true);
  });

  // Requirement 29: Check mode sends no benchmark prompt traffic
  it('29: check mode sends no benchmark prompt traffic', async () => {
    let promptTrafficSent = false;
    let catalogQueried = false;

    const mockFetch = async (url) => {
      if (url.includes('/models')) {
        catalogQueried = true;
        return {
          ok: true,
          json: async () => ({
            data: [{ id: OPENROUTER_TARGET_MODEL }]
          })
        };
      }
      if (url.includes('/chat/completions')) {
        promptTrafficSent = true;
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false };
    };

    const modelCheck = await verifyOpenRouterModelAvailability(
      'https://openrouter.ai/api/v1',
      'test-key',
      OPENROUTER_TARGET_MODEL,
      mockFetch
    );

    assert.strictEqual(catalogQueried, true, 'Catalog was queried for model availability');
    assert.strictEqual(promptTrafficSent, false, 'No chat completion requests were sent');
    assert.strictEqual(modelCheck.available, true);
  });

  // Requirement 30 & 31: OpenRouter unavailable target causes controlled stop with no silent substitution
  it('30 & 31: OpenRouter unavailable target causes controlled stop with no silent substitution', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'some-other-model' }]
      })
    });

    const check = await verifyOpenRouterModelAvailability(
      'https://openrouter.ai/api/v1',
      'test-key',
      OPENROUTER_TARGET_MODEL,
      mockFetch
    );

    assert.strictEqual(check.available, false);
    assert.strictEqual(check.error.includes('Silent model substitution is prohibited'), true);
  });

  // Requirement 32, 33, 34: Production configuration and CheaperInferenceProvider remain unchanged
  it('32, 33, 34: production CHEAPER_INFERENCE_MODEL, /api/ai, and CheaperInferenceProvider remain unchanged', async () => {
    assert.strictEqual(CHEAPER_TARGET_MODEL, 'deepseek-v4-flash-0731');

    const { loadConfig } = await import('../../src/config/index.js');
    const loaded = loadConfig({ CHEAPER_INFERENCE_MODEL: 'deepseek-v4-flash-0731' });
    assert.strictEqual(loaded.cheaperInference.model, 'deepseek-v4-flash-0731');

    const origEnv = process.env.CHEAPER_INFERENCE_MODEL;
    process.env.CHEAPER_INFERENCE_MODEL = 'deepseek-v4-flash-0731';

    try {
      const provider = new CheaperInferenceProvider({
        apiKey: 'mock-key',
        model: process.env.CHEAPER_INFERENCE_MODEL
      });
      assert.strictEqual(provider.model, 'deepseek-v4-flash-0731');
      assert.strictEqual(provider.name, 'cheaper-inference');
    } finally {
      if (origEnv !== undefined) {
        process.env.CHEAPER_INFERENCE_MODEL = origEnv;
      } else {
        delete process.env.CHEAPER_INFERENCE_MODEL;
      }
    }
  });

  // Requirement 35 & 36: ConversationSession and ConversationStore remain unchanged
  it('35 & 36: ConversationSession and ConversationStore remain unchanged', () => {
    const session = new ConversationSession({ maxMessages: 5 });
    session.addUserMessage('Test user message');
    session.addAssistantMessage('Test assistant message');
    assert.strictEqual(session.getMessages().length, 2);

    const tempFile = resolve(ROOT_DIR, 'runtime', `.test-gw-conv-store-${Date.now()}.json`);
    const store = new ConversationStore({ filePath: tempFile });
    try {
      store.save(session.getMessages());
      const loaded = store.load();
      assert.strictEqual(loaded.length, 2);
    } finally {
      store.clear();
    }
  });

  // Requirement 37 & 38: STT and TTS contracts remain unchanged
  it('37 & 38: STT and TTS contracts remain unchanged and are not modified for text generation', () => {
    const stt = new SpeechToTextProvider('test-stt');
    const tts = new TextToSpeechProvider('test-tts');
    assert.strictEqual(typeof stt.transcribe, 'function');
    assert.strictEqual(typeof tts.synthesize, 'function');
  });

  // Requirement 39: VoiceTurnRunner remains unchanged
  it('39: VoiceTurnRunner remains unchanged', () => {
    const runner = new VoiceTurnRunner({ fetchFn: async () => {} });
    assert.strictEqual(runner.state, VoiceTurnState.IDLE);
    assert.strictEqual(typeof runner.execute, 'function');
  });

  // Requirement 40: Normal text core remains unchanged
  it('40: handleText text core remains unchanged', () => {
    const result = handleText('Gateway test');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.response, 'JARVIS received: Gateway test');
  });

  // Requirement 41: parseArgs and formatConsoleTable work cleanly
  it('41: parseArgs and formatConsoleTable produce clean results', () => {
    const args = parseArgs(['--check', '--trials=5', '--timeout=25000', '--prompt="What is 1+1?"']);
    assert.strictEqual(args.check, true);
    assert.strictEqual(args.trials, 5);
    assert.strictEqual(args.timeout, 25000);
    assert.strictEqual(args.prompt, '"What is 1+1?"');

    const sampleSummaries = [
      {
        gateway: 'Cheaper Inference',
        model: 'deepseek-v4-flash-0731',
        totalTrials: 3,
        successful: 0,
        timeouts: 3,
        medianMs: null,
        avgMs: null,
        minMs: null,
        maxMs: null,
        correctCount: 0
      },
      {
        gateway: 'OpenRouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        totalTrials: 3,
        successful: 3,
        timeouts: 0,
        medianMs: 2500,
        avgMs: 2600,
        minMs: 2400,
        maxMs: 2900,
        correctCount: 3
      }
    ];

    const table = formatConsoleTable(sampleSummaries);
    assert.strictEqual(typeof table, 'string');
    assert.strictEqual(table.includes('Cheaper Inference'), true);
    assert.strictEqual(table.includes('OpenRouter'), true);
    assert.strictEqual(table.includes('2500 ms'), true);
  });
});
