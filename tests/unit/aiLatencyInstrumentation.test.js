import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CheaperInferenceProvider } from '../../src/providers/cheaperInference.js';
import { VoiceTurnRunner, VoiceTurnState } from '../../src/web/voiceTurn.js';

describe('AI Latency Instrumentation - Unit Tests (Brick 14)', () => {
  const AI_ENV_VARS = [
    'CHEAPER_INFERENCE_API_KEY',
    'CHEAPER_INFERENCE_BASE_URL',
    'CHEAPER_INFERENCE_MODEL',
    'CHEAPER_INFERENCE_TIMEOUT_MS'
  ];

  let originalEnv = {};

  beforeEach(() => {
    originalEnv = {};
    for (const key of AI_ENV_VARS) {
      if (key in process.env) {
        originalEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    for (const key of AI_ENV_VARS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  const validConfig = {
    apiKey: 'test-secret-key-12345',
    baseUrl: 'https://api.cheaperinference.com/v1',
    model: 'mock-hosted-model-v1',
    timeoutMs: 5000
  };

  // Requirement 2, 3, 4: providerDurationMs exists, is numeric, is non-negative
  test('providerDurationMs exists, is numeric, and is non-negative on successful provider call', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          { message: { role: 'assistant', content: 'Latency measurement test response.' } }
        ]
      })
    });

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const result = await provider.generate('Test prompt');
    assert.equal(result.success, true);
    assert.equal(result.text, 'Latency measurement test response.');
    assert.ok('providerDurationMs' in result, 'providerDurationMs must exist in result');
    assert.equal(typeof result.providerDurationMs, 'number', 'providerDurationMs must be numeric');
    assert.ok(result.providerDurationMs >= 0, 'providerDurationMs must be non-negative');
    assert.ok(Number.isFinite(result.providerDurationMs), 'providerDurationMs must be finite');
  });

  // Requirement 14: timing survives English Unicode response
  test('provider timing survives English Unicode response', async () => {
    const englishText = 'The speed of light in vacuum is approximately 299,792,458 meters per second.';
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: englishText } }]
      })
    });

    const provider = new CheaperInferenceProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('What is the speed of light?');
    assert.equal(result.success, true);
    assert.equal(result.text, englishText);
    assert.equal(typeof result.providerDurationMs, 'number');
    assert.ok(result.providerDurationMs >= 0);
  });

  // Requirement 15: timing survives Urdu Unicode response
  test('provider timing survives Urdu Unicode response', async () => {
    const urduText = 'سر، روشنی کی رفتار خلا میں تقریباً 300،000 کلومیٹر فی سیکنڈ ہے۔';
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: urduText } }]
      })
    });

    const provider = new CheaperInferenceProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('روشنی کی رفتار کیا ہے؟');
    assert.equal(result.success, true);
    assert.equal(result.text, urduText);
    assert.equal(typeof result.providerDurationMs, 'number');
    assert.ok(result.providerDurationMs >= 0);
  });

  // Requirement 16: timing survives Arabic Unicode response
  test('provider timing survives Arabic Unicode response', async () => {
    const arabicText = 'سرعة الضوء في الفراغ تبلغ حوالي 300 ألف كيلومتر في الثانية.';
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: arabicText } }]
      })
    });

    const provider = new CheaperInferenceProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('ما هي سرعة الضوء؟');
    assert.equal(result.success, true);
    assert.equal(result.text, arabicText);
    assert.equal(typeof result.providerDurationMs, 'number');
    assert.ok(result.providerDurationMs >= 0);
  });

  // Requirement 17: timing survives mixed-language response
  test('provider timing survives mixed-language code-switched response', async () => {
    const mixedText = 'Jarvis says: پاور بی آئی dashboard پر total latency 124 ms ریکارڈ کی گئی ہے۔';
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: mixedText } }]
      })
    });

    const provider = new CheaperInferenceProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('Dashboard latency status?');
    assert.equal(result.success, true);
    assert.equal(result.text, mixedText);
    assert.equal(typeof result.providerDurationMs, 'number');
    assert.ok(result.providerDurationMs >= 0);
  });

  // Requirement 18 & 19: provider failure records controlled elapsed timing and returns controlled error
  test('provider failure records controlled elapsed providerDurationMs on HTTP error', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => ({ error: { message: 'Upstream gateway timed out' } })
    });

    const provider = new CheaperInferenceProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('Test prompt');
    assert.equal(result.success, false);
    assert.match(result.error, /Provider HTTP 502/);
    assert.ok('providerDurationMs' in result);
    assert.equal(typeof result.providerDurationMs, 'number');
    assert.ok(result.providerDurationMs >= 0);
  });

  test('provider failure records controlled elapsed providerDurationMs on network exception', async () => {
    const mockFetch = async () => {
      throw new Error('ECONNRESET: connection reset by peer');
    };

    const provider = new CheaperInferenceProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('Test prompt');
    assert.equal(result.success, false);
    assert.match(result.error, /Network error: ECONNRESET/);
    assert.ok('providerDurationMs' in result);
    assert.equal(typeof result.providerDurationMs, 'number');
    assert.ok(result.providerDurationMs >= 0);
  });

  test('provider failure records controlled elapsed providerDurationMs on timeout', async () => {
    const mockFetch = async (url, options) => {
      // Simulate timeout
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    const provider = new CheaperInferenceProvider({ ...validConfig, timeoutMs: 50, fetchFn: mockFetch });
    const result = await provider.generate('Test prompt');
    assert.equal(result.success, false);
    assert.match(result.error, /Request timed out/);
    assert.ok('providerDurationMs' in result);
    assert.equal(typeof result.providerDurationMs, 'number');
    assert.ok(result.providerDurationMs >= 0);
  });

  // Requirement 20: no provider secret exposed in timing or error metadata
  test('no provider secret exposed in timing or error metadata', async () => {
    const secretKey = 'super-secret-ci-key-xyz999';
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: `Unauthorized request with key ${secretKey}` } })
    });

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      apiKey: secretKey,
      fetchFn: mockFetch
    });

    const result = await provider.generate('Test prompt');
    assert.equal(result.success, false);
    assert.equal(result.error.includes(secretKey), false);
    assert.match(result.error, /\[REDACTED\]/);
    // Ensure metadata object has no leaked key
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secretKey), false);
  });

  // Requirement 8, 9, 13: client AI timing in browser orchestration & distinct from STT/TTS
  test('VoiceTurnRunner records clientAiDurationMs, serverAiDurationMs, providerDurationMs distinct from STT/TTS', async () => {
    const mockSttDuration = 250;
    const mockTtsDuration = 180;
    const mockProviderDuration = 420;
    const mockServerAiDuration = 435;

    const mockFetch = async (url) => {
      if (url === '/api/stt') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, text: 'Recognized question', durationMs: mockSttDuration })
        };
      }
      if (url === '/api/ai') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            response: 'Answer from JARVIS',
            timing: {
              providerDurationMs: mockProviderDuration,
              serverAiDurationMs: mockServerAiDuration
            },
            providerDurationMs: mockProviderDuration,
            serverAiDurationMs: mockServerAiDuration
          })
        };
      }
      if (url === '/api/tts') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-type': 'audio/mpeg',
            'x-tts-duration-ms': String(mockTtsDuration)
          }),
          blob: async () => new Blob([new Uint8Array([0xFF, 0xFB, 0x90, 0x44])], { type: 'audio/mpeg' })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const runner = new VoiceTurnRunner({ fetchFn: mockFetch });
    const audioBlob = new Blob(['sample-audio-data'], { type: 'audio/webm' });

    let aiSuccessDetails = null;
    let playingMetrics = null;

    const result = await runner.execute({
      audioBlob,
      onStageChange: (stage, details) => {
        if (stage === 'AI_SUCCESS') {
          aiSuccessDetails = details;
        }
      },
      playAudioFn: async (blob, metrics) => {
        playingMetrics = metrics;
      }
    });

    assert.equal(result.success, true);

    // Requirement 8: Client AI timing exists
    assert.equal(typeof result.clientAiDurationMs, 'number');
    assert.ok(result.clientAiDurationMs >= 0);
    assert.equal(typeof result.aiDurationMs, 'number');
    assert.ok(result.aiDurationMs >= 0);

    // AI stage callbacks contain diagnostic metrics
    assert.ok(aiSuccessDetails !== null);
    assert.equal(typeof aiSuccessDetails.durationMs, 'number');
    assert.equal(aiSuccessDetails.providerDurationMs, mockProviderDuration);
    assert.equal(aiSuccessDetails.serverAiDurationMs, mockServerAiDuration);

    // Requirement 13: provider timing is independent, not derived from STT/TTS subtraction
    assert.equal(result.providerDurationMs, mockProviderDuration);
    assert.equal(result.serverAiDurationMs, mockServerAiDuration);
    assert.notEqual(result.providerDurationMs, result.totalDurationMs - mockSttDuration - mockTtsDuration);

    // Metrics passed to playback
    assert.ok(playingMetrics !== null);
    assert.equal(playingMetrics.sttDurationMs, mockSttDuration);
    assert.equal(playingMetrics.ttsDurationMs, mockTtsDuration);
    assert.equal(playingMetrics.providerDurationMs, mockProviderDuration);
    assert.equal(playingMetrics.serverAiDurationMs, mockServerAiDuration);
    assert.equal(typeof playingMetrics.aiDurationMs, 'number');
    assert.equal(typeof playingMetrics.totalDurationMs, 'number');
  });

  // VoiceTurnRunner on AI error captures clientAiDurationMs
  test('VoiceTurnRunner on AI error captures clientAiDurationMs and stops cleanly', async () => {
    const mockFetch = async (url) => {
      if (url === '/api/stt') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, text: 'Question', durationMs: 200 })
        };
      }
      if (url === '/api/ai') {
        return {
          ok: false,
          status: 500,
          json: async () => ({
            success: false,
            error: 'AI Provider timeout',
            timing: { providerDurationMs: 5000, serverAiDurationMs: 5010 }
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const runner = new VoiceTurnRunner({ fetchFn: mockFetch });
    const audioBlob = new Blob(['sample-audio-data'], { type: 'audio/webm' });

    let aiErrorDetails = null;
    const result = await runner.execute({
      audioBlob,
      onStageChange: (stage, details) => {
        if (stage === VoiceTurnState.AI_ERROR) {
          aiErrorDetails = details;
        }
      }
    });

    assert.equal(result.success, false);
    assert.equal(result.stage, VoiceTurnState.AI_ERROR);
    assert.equal(typeof result.clientAiDurationMs, 'number');
    assert.ok(result.clientAiDurationMs >= 0);
    assert.ok(aiErrorDetails !== null);
    assert.equal(typeof aiErrorDetails.clientAiDurationMs, 'number');
  });
});
