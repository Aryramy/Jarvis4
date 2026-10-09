import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { startServer } from '../../src/web/server.js';
import { CheaperInferenceProvider } from '../../src/providers/cheaperInference.js';
import { ConversationSession } from '../../src/core/conversationSession.js';
import { ConversationStore } from '../../src/core/conversationStore.js';
import { VoiceTurnRunner, VoiceTurnState } from '../../src/web/voiceTurn.js';

describe('AI Latency Instrumentation - Integration Tests (Brick 14)', () => {
  const AI_ENV_VARS = [
    'CHEAPER_INFERENCE_API_KEY',
    'CHEAPER_INFERENCE_BASE_URL',
    'CHEAPER_INFERENCE_MODEL',
    'CHEAPER_INFERENCE_TIMEOUT_MS'
  ];

  let originalEnv = {};
  let server;
  let baseUrl;
  let testStoreFile;
  let sharedSession;
  let sharedStore;

  let mockAiResponseText = 'Default integrated AI response';
  let mockAiFail = false;
  let mockProviderDurationMs = 150;
  let lastCapturedMessages = null;

  beforeEach(() => {
    mockAiResponseText = 'Default integrated AI response';
    mockAiFail = false;
    mockProviderDurationMs = 150;
    lastCapturedMessages = null;
  });

  before(async () => {
    for (const key of AI_ENV_VARS) {
      if (key in process.env) {
        originalEnv[key] = process.env[key];
      }
    }

    process.env.CHEAPER_INFERENCE_API_KEY = 'test-key-integration-123';
    process.env.CHEAPER_INFERENCE_BASE_URL = 'https://api.cheaperinference.com/v1';
    process.env.CHEAPER_INFERENCE_MODEL = 'deepseek-v4-flash-0731';
    process.env.CHEAPER_INFERENCE_TIMEOUT_MS = '5000';

    testStoreFile = join(tmpdir(), `jarvis4-latency-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    sharedStore = new ConversationStore({ filePath: testStoreFile });
    sharedSession = new ConversationSession({ maxMessages: 10 });

    const mockFetchFn = async (url, options) => {
      if (mockAiFail) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Error',
          json: async () => ({ error: { message: 'Provider internal error' } })
        };
      }

      const body = options?.body ? JSON.parse(options.body) : {};
      lastCapturedMessages = body.messages || null;

      if (body.stream) {
        const sseContent = `data: ${JSON.stringify({ choices: [{ delta: { content: mockAiResponseText } }] })}\n\ndata: [DONE]\n\n`;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sseContent));
              controller.close();
            }
          })
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: mockAiResponseText } }]
        })
      };
    };

    const provider = new CheaperInferenceProvider({
      apiKey: 'test-key-integration-123',
      baseUrl: 'https://api.cheaperinference.com/v1',
      model: 'deepseek-v4-flash-0731',
      fetchFn: mockFetchFn
    });

    server = await startServer(0, '127.0.0.1', {
      provider,
      session: sharedSession,
      store: sharedStore
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after((done) => {
    if (testStoreFile && existsSync(testStoreFile)) {
      try { unlinkSync(testStoreFile); } catch {}
    }
    for (const key of AI_ENV_VARS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  // Requirement 5, 6, 7: serverAiDurationMs exists, is numeric, is non-negative
  test('POST /api/ai returns serverAiDurationMs and providerDurationMs in timing metadata', async () => {
    mockAiResponseText = 'Response with timing verification.';

    const res = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Explain quantum computing in one sentence.' })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.response, 'Response with timing verification.');

    // Requirement 5, 6, 7
    assert.ok(data.timing, 'timing metadata object must exist in /api/ai response');
    assert.equal(typeof data.timing.serverAiDurationMs, 'number', 'serverAiDurationMs must be numeric');
    assert.ok(data.timing.serverAiDurationMs >= 0, 'serverAiDurationMs must be non-negative');

    // Requirement 2, 3, 4
    assert.equal(typeof data.timing.providerDurationMs, 'number', 'providerDurationMs must be numeric');
    assert.ok(data.timing.providerDurationMs >= 0, 'providerDurationMs must be non-negative');

    // Top-level compatibility fields
    assert.equal(typeof data.serverAiDurationMs, 'number');
    assert.ok(data.serverAiDurationMs >= 0);
    assert.equal(typeof data.providerDurationMs, 'number');
    assert.ok(data.providerDurationMs >= 0);
  });

  // Requirement 21 & 22: ConversationSession and ConversationStore behavior unchanged
  test('ConversationSession and ConversationStore remain intact across instrumented requests', async () => {
    sharedSession.clear();
    sharedStore.clear();

    mockAiResponseText = 'Understood, memory stored.';
    const res1 = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'My secret pin is 7890.' })
    });
    assert.equal(res1.status, 200);

    const history = sharedSession.getMessages();
    assert.equal(history.length, 2);
    assert.equal(history[0].role, 'user');
    assert.equal(history[0].content, 'My secret pin is 7890.');
    assert.equal(history[1].role, 'assistant');
    assert.equal(history[1].content, 'Understood, memory stored.');

    // Verifies persistence on disk
    const stored = sharedStore.load();
    assert.equal(stored.length, 2);
    assert.equal(stored[0].content, 'My secret pin is 7890.');
  });

  // Requirement 23: Typed Ask JARVIS still works
  test('typed Ask JARVIS request still works with Unicode Urdu', async () => {
    const urduQuery = 'پاکستان کا دارالحکومت کیا ہے؟';
    const urduAns = 'پاکستان کا دارالحکومت اسلام آباد ہے۔';
    mockAiResponseText = urduAns;

    const res = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: urduQuery })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.response, urduAns);
    assert.ok(data.timing);
    assert.ok(data.timing.serverAiDurationMs >= 0);
    assert.ok(data.timing.providerDurationMs >= 0);
  });

  // Requirement 25: Existing streaming AI still works
  test('existing streaming AI endpoint (/api/ai/stream) still works unaffected', async () => {
    mockAiResponseText = 'Streaming delta response content.';

    const res = await fetch(`${baseUrl}/api/ai/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Stream this answer.' })
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"type":"delta"/);
    assert.match(text, /"type":"done"/);
  });

  // Requirement 9, 10, 11, 12: Web UI displays AI latency alongside STT, TTS, Voice Turn Total
  test('HTML contract includes AI latency display in script and UI structure', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();

    // Verify key status elements exist
    assert.match(html, /id="stt-status"/);
    assert.match(html, /id="jarvis-status"/);
    assert.match(html, /id="tts-status"/);
    assert.match(html, /id="voice-turn-status"/);

    // Verify AI latency instrumentation is implemented in client handlers
    assert.match(html, /AI:\s*\$\{clientAiDurationMs\}\s*ms|AI:\s*'\s*\+\s*clientAiDurationMs/);
    assert.match(html, /details\.durationMs[\s\S]*?AI:\s*\$\{details\.durationMs\}\s*ms|AI:\s*'\s*\+\s*details\.durationMs/);

    // Verify STT, TTS, and Voice Turn Total still display
    assert.match(html, /STT:\s*\$\{details\.durationMs\}\s*ms|STT:\s*'\s*\+\s*details\.durationMs/);
    assert.match(html, /TTS:\s*\$\{details\.durationMs\}\s*ms|TTS:\s*'\s*\+\s*details\.durationMs/);
    assert.match(html, /Voice Turn Total:\s*\$\{(?:details|metrics)\.totalDurationMs\}\s*ms|Voice Turn Total:\s*'\s*\+\s*(?:details|metrics)\.totalDurationMs/);
  });

  // Requirement 24 & 28: voice Run Voice Turn still works with stale-data protection
  test('VoiceTurnRunner integrated with real local endpoints executes with AI latency', async () => {
    // Provide a mocked runner fetchFn that directs /api/ai to our local test server
    const mockAudioBlob = new Blob(['sample-audio-wav'], { type: 'audio/webm' });
    const localFetch = async (endpoint, opts) => {
      if (endpoint === '/api/stt') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, text: 'What is the capital of France?', durationMs: 280 })
        };
      }
      if (endpoint === '/api/tts') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-type': 'audio/mpeg',
            'x-tts-duration-ms': '210'
          }),
          blob: async () => new Blob([new Uint8Array([0xFF, 0xFB, 0x90, 0x12])], { type: 'audio/mpeg' })
        };
      }
      // Route /api/ai to actual server
      return fetch(`${baseUrl}${endpoint}`, opts);
    };

    mockAiResponseText = 'The capital of France is Paris.';
    const runner = new VoiceTurnRunner({ fetchFn: localFetch });

    let receivedAiSuccess = null;
    let playedMetrics = null;

    const result = await runner.execute({
      audioBlob: mockAudioBlob,
      onStageChange: (stage, details) => {
        if (stage === 'AI_SUCCESS') {
          receivedAiSuccess = details;
        }
      },
      playAudioFn: async (blob, metrics) => {
        playedMetrics = metrics;
      }
    });

    assert.equal(result.success, true);
    assert.equal(result.transcript, 'What is the capital of France?');
    assert.equal(result.response, 'The capital of France is Paris.');

    // AI stage timing
    assert.equal(typeof result.clientAiDurationMs, 'number');
    assert.ok(result.clientAiDurationMs >= 0);
    assert.equal(typeof result.serverAiDurationMs, 'number');
    assert.ok(result.serverAiDurationMs >= 0);
    assert.equal(typeof result.providerDurationMs, 'number');
    assert.ok(result.providerDurationMs >= 0);

    // AI_SUCCESS callback
    assert.ok(receivedAiSuccess !== null);
    assert.equal(typeof receivedAiSuccess.durationMs, 'number');
    assert.equal(typeof receivedAiSuccess.serverAiDurationMs, 'number');
    assert.equal(typeof receivedAiSuccess.providerDurationMs, 'number');

    // Metrics passed to audio playback
    assert.ok(playedMetrics !== null);
    assert.equal(playedMetrics.sttDurationMs, 280);
    assert.equal(playedMetrics.ttsDurationMs, 210);
    assert.equal(typeof playedMetrics.aiDurationMs, 'number');
    assert.equal(typeof playedMetrics.totalDurationMs, 'number');
  });

  // Requirement 20: No secrets exposed in /api/ai response on failure
  test('provider error in /api/ai returns controlled timing without secret exposure', async () => {
    mockAiFail = true;

    const res = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Will fail.' })
    });

    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Provider internal error/);
    assert.equal(data.error.includes('test-key-integration-123'), false);

    // Timing exists even on controlled failure
    assert.ok(data.timing);
    assert.equal(typeof data.timing.serverAiDurationMs, 'number');
    assert.ok(data.timing.serverAiDurationMs >= 0);
    assert.equal(JSON.stringify(data.timing).includes('test-key-integration-123'), false);
  });
});
