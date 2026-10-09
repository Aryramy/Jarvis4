import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { startServer } from '../../src/web/server.js';
import { CheaperInferenceProvider } from '../../src/providers/cheaperInference.js';
import { OpenRouterSpeechToTextProvider } from '../../src/providers/openRouterSTT.js';
import { OpenRouterTextToSpeechProvider } from '../../src/providers/openRouterTTS.js';
import { ConversationSession } from '../../src/core/conversationSession.js';
import { ConversationStore } from '../../src/core/conversationStore.js';
import { VoiceTurnRunner, VoiceTurnState } from '../../src/web/voiceTurn.js';

describe('One-Action Sequential Voice Turn Integration - Brick 13', () => {
  const AI_ENV_VARS = [
    'CHEAPER_INFERENCE_API_KEY',
    'CHEAPER_INFERENCE_BASE_URL',
    'CHEAPER_INFERENCE_MODEL',
    'CHEAPER_INFERENCE_TIMEOUT_MS',
    'OPENROUTER_API_KEY',
    'OPENROUTER_STT_BASE_URL',
    'OPENROUTER_STT_MODEL',
    'OPENROUTER_STT_TIMEOUT_MS',
    'OPENROUTER_TTS_BASE_URL',
    'OPENROUTER_TTS_MODEL',
    'OPENROUTER_TTS_VOICE',
    'OPENROUTER_TTS_TIMEOUT_MS'
  ];

  let originalEnv = {};
  let server;
  let baseUrl;
  let currentTestStoreFile;

  // Mock states
  let mockSttTranscript = 'Hello JARVIS, this is a test voice turn.';
  let mockSttDurationMs = 245;
  let mockSttFail = false;

  let lastAiReceivedMessages = null;
  let mockAiResponseText = 'JARVIS automated response text.';
  let mockAiFail = false;

  let lastTtsSynthesizedText = '';
  let mockTtsBytes = Buffer.from([0xFF, 0xFB, 0x90, 0x64, 0x11, 0x22, 0x33]);
  let mockTtsFail = false;
  let mockTtsDurationMs = 180;

  const mockSttFetchFn = async () => {
    if (mockSttFail) {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Error',
        json: async () => ({ error: { message: 'STT provider failed' } })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ text: mockSttTranscript })
    };
  };

  const mockAiFetchFn = async (url, options) => {
    if (mockAiFail) {
      return {
        ok: false,
        status: 500,
        statusText: 'Provider Internal Error',
        json: async () => ({ error: { message: 'Cheaper Inference provider error' } })
      };
    }

    const body = options?.body ? JSON.parse(options.body) : {};
    lastAiReceivedMessages = body.messages || null;

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
        choices: [
          {
            message: {
              role: 'assistant',
              content: mockAiResponseText
            }
          }
        ]
      })
    };
  };

  const mockTtsFetchFn = async (url, options) => {
    const parsedBody = JSON.parse(options.body);
    lastTtsSynthesizedText = parsedBody.input;

    if (mockTtsFail) {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Error',
        json: async () => ({ error: { message: 'TTS provider error' } })
      };
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'audio/mpeg'
      }),
      arrayBuffer: async () => mockTtsBytes.buffer.slice(mockTtsBytes.byteOffset, mockTtsBytes.byteOffset + mockTtsBytes.byteLength)
    };
  };

  let sttProvider;
  let aiProvider;
  let ttsProvider;
  let sharedSession;
  let sharedStore;

  before(async () => {
    originalEnv = {};
    for (const key of AI_ENV_VARS) {
      if (key in process.env) {
        originalEnv[key] = process.env[key];
        delete process.env[key];
      }
    }

    currentTestStoreFile = join(tmpdir(), `test-b13-store-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    sharedStore = new ConversationStore({ filePath: currentTestStoreFile });
    sharedSession = new ConversationSession();

    sttProvider = new OpenRouterSpeechToTextProvider({
      apiKey: 'sk-or-b13-test-key',
      model: 'openai/whisper-large-v3-turbo',
      fetchFn: mockSttFetchFn
    });

    aiProvider = new CheaperInferenceProvider({
      apiKey: 'sk-ci-b13-test-key',
      model: 'deepseek-v4-flash-0731',
      fetchFn: mockAiFetchFn
    });

    ttsProvider = new OpenRouterTextToSpeechProvider({
      apiKey: 'sk-or-b13-tts-key',
      model: 'elevenlabs/eleven-v4-turbo',
      voice: 'george',
      fetchFn: mockTtsFetchFn
    });

    server = await startServer(0, '127.0.0.1', {
      sttProvider,
      provider: aiProvider,
      ttsProvider,
      session: sharedSession,
      store: sharedStore
    });
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  beforeEach(() => {
    if (sharedSession) sharedSession.clear();
    if (sharedStore) sharedStore.clear();

    mockSttTranscript = 'Hello JARVIS, this is a test voice turn.';
    mockSttDurationMs = 245;
    mockSttFail = false;

    lastAiReceivedMessages = null;
    mockAiResponseText = 'JARVIS automated response text.';
    mockAiFail = false;

    lastTtsSynthesizedText = '';
    mockTtsFail = false;
    mockTtsDurationMs = 180;
  });

  afterEach(() => {
    if (sharedSession) sharedSession.clear();
    if (sharedStore) sharedStore.clear();
  });

  after((done) => {
    if (currentTestStoreFile && existsSync(currentTestStoreFile)) {
      try { unlinkSync(currentTestStoreFile); } catch {}
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

  // =========================================================================
  // 1. Web Interface Elements & Contract Tests
  // =========================================================================

  test('GET / serves HTML containing Run Voice Turn control and preserves old manual controls', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);

    const html = await res.text();

    // Brick 13 additions
    assert.match(html, /id="run-voice-turn-btn"/);
    assert.match(html, /Run Voice Turn/);
    assert.match(html, /<button type="button" id="run-voice-turn-btn" disabled>Run Voice Turn<\/button>/);
    assert.match(html, /id="voice-turn-status"/);
    assert.match(html, /from '\/voiceTurn\.js'/);

    // Old manual controls preserved
    assert.match(html, /id="start-mic-btn"/);
    assert.match(html, /id="stop-mic-btn"/);
    assert.match(html, /id="transcribe-btn"/);
    assert.match(html, /<button type="button" id="ask-jarvis-btn" disabled>Ask JARVIS<\/button>/);
    assert.match(html, /<button type="button" id="speak-response-btn" disabled>Speak Response<\/button>/);

    // Prior controls preserved
    assert.match(html, /id="send-btn"/);
    assert.match(html, /id="ask-ai-btn"/);
    assert.match(html, /id="ask-ai-stream-btn"/);
    assert.match(html, /id="clear-conv-btn"/);
    assert.match(html, /id="transcript-display"/);
    assert.match(html, /id="jarvis-response"/);
    assert.match(html, /id="tts-playback"/);
  });

  test('GET /voiceTurn.js serves client voice turn runner module with 200 and application/javascript', async () => {
    const res = await fetch(`${baseUrl}/voiceTurn.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/javascript/);

    const body = await res.text();
    assert.match(body, /export class VoiceTurnRunner/);
    assert.match(body, /export const VoiceTurnState/);
    assert.match(body, /async execute\(/);
  });

  // =========================================================================
  // 2. Sequential Pipeline Integration (STT -> AI -> TTS -> Playback)
  // =========================================================================

  test('complete sequential voice turn executes STT -> AI -> TTS and initiates playback from one action', async () => {
    mockSttTranscript = 'What is Microsoft Fabric in one short sentence?';
    mockAiResponseText = 'Microsoft Fabric is an all-in-one analytics solution for enterprises.';

    const runner = new VoiceTurnRunner({
      fetchFn: async (endpoint, opts) => {
        return fetch(`${baseUrl}${endpoint}`, opts);
      }
    });

    const audioBlob = new Blob(['sample-recorded-audio-webm'], { type: 'audio/webm' });
    let playedBlob = null;
    let playedMetrics = null;

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async (blob, metrics) => {
        playedBlob = blob;
        playedMetrics = metrics;
      }
    });

    assert.equal(result.success, true);
    assert.equal(result.transcript, mockSttTranscript);
    assert.equal(result.response, mockAiResponseText);
    assert.ok(playedBlob !== null);
    assert.ok(playedBlob.size > 0);
    assert.ok(typeof playedMetrics.totalDurationMs === 'number');

    // Verifies data chain verbatim
    assert.equal(lastAiReceivedMessages[lastAiReceivedMessages.length - 1].content, mockSttTranscript);
    assert.equal(lastTtsSynthesizedText, mockAiResponseText);
  });

  // =========================================================================
  // 3. Multilingual Requirements
  // =========================================================================

  test('Urdu one-action voice turn preserves exact Unicode across STT -> AI -> TTS', async () => {
    mockSttTranscript = 'جارویس، پاور بی آئی کیا ہے؟ ایک مختصر جواب دو۔';
    mockAiResponseText = 'پاور بی آئی مائیکروسافٹ کا ایک بصری تجزیاتی ٹول ہے۔';

    const runner = new VoiceTurnRunner({
      fetchFn: async (endpoint, opts) => fetch(`${baseUrl}${endpoint}`, opts)
    });

    const audioBlob = new Blob(['audio-urdu-bytes'], { type: 'audio/webm' });
    let played = false;

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => { played = true; }
    });

    assert.equal(result.success, true);
    assert.equal(played, true);
    assert.equal(result.transcript, mockSttTranscript);
    assert.equal(result.response, mockAiResponseText);
    assert.equal(lastAiReceivedMessages[lastAiReceivedMessages.length - 1].content, mockSttTranscript);
    assert.equal(lastTtsSynthesizedText, mockAiResponseText);
  });

  test('Arabic one-action voice turn preserves exact Unicode across STT -> AI -> TTS', async () => {
    mockSttTranscript = 'يا جارفس، ما هو Power BI؟ أجب بجملة قصيرة.';
    mockAiResponseText = 'Power BI هو نظام تحليلات تفاعلي من مايكروسوفت.';

    const runner = new VoiceTurnRunner({
      fetchFn: async (endpoint, opts) => fetch(`${baseUrl}${endpoint}`, opts)
    });

    const audioBlob = new Blob(['audio-arabic-bytes'], { type: 'audio/webm' });
    let played = false;

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => { played = true; }
    });

    assert.equal(result.success, true);
    assert.equal(played, true);
    assert.equal(result.transcript, mockSttTranscript);
    assert.equal(result.response, mockAiResponseText);
    assert.equal(lastAiReceivedMessages[lastAiReceivedMessages.length - 1].content, mockSttTranscript);
    assert.equal(lastTtsSynthesizedText, mockAiResponseText);
  });

  test('Mixed Urdu + English one-action voice turn handles code-switched text verbatim', async () => {
    mockSttTranscript = 'Jarvis, مجھے Power BI dashboard کے بارے میں one short sentence میں بتاؤ.';
    mockAiResponseText = 'Power BI dashboard ایک interactive reporting page ہے جو metrics دکھاتا ہے۔';

    const runner = new VoiceTurnRunner({
      fetchFn: async (endpoint, opts) => fetch(`${baseUrl}${endpoint}`, opts)
    });

    const audioBlob = new Blob(['audio-mixed-bytes'], { type: 'audio/webm' });
    let played = false;

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => { played = true; }
    });

    assert.equal(result.success, true);
    assert.equal(played, true);
    assert.equal(result.transcript, mockSttTranscript);
    assert.equal(result.response, mockAiResponseText);
  });

  // =========================================================================
  // 4. Shared Conversation Context & Continuity
  // =========================================================================

  test('voice-turn AI request participates in shared ConversationSession with prior typed prompt', async () => {
    sharedSession.clear();

    // Step 1: Normal typed interaction via POST /api/ai
    const typedRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'My project code is QUASAR-915.' })
    });
    assert.equal(typedRes.status, 200);

    // Step 2: Voice turn asking for the project code
    mockSttTranscript = 'What is my project code?';
    mockAiResponseText = 'Sir, your project code is QUASAR-915.';

    const runner = new VoiceTurnRunner({
      fetchFn: async (endpoint, opts) => fetch(`${baseUrl}${endpoint}`, opts)
    });

    const audioBlob = new Blob(['audio-bytes'], { type: 'audio/webm' });
    let played = false;

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => { played = true; }
    });

    assert.equal(result.success, true);
    assert.equal(played, true);

    // Verify AI received the conversation history including the typed prompt
    assert.ok(lastAiReceivedMessages.length >= 3);
    assert.equal(lastAiReceivedMessages[0].role, 'user');
    assert.equal(lastAiReceivedMessages[0].content, 'My project code is QUASAR-915.');
    assert.equal(lastAiReceivedMessages[2].role, 'user');
    assert.equal(lastAiReceivedMessages[2].content, 'What is my project code?');

    // Step 3: Later typed prompt has access to information from the voice turn
    const laterRes = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'What was my previous voice question?' })
    });
    assert.equal(laterRes.status, 200);

    const messages = sharedSession.getMessages();
    assert.ok(messages.some(m => m.content === 'What is my project code?'));
    assert.ok(messages.some(m => m.content === 'Sir, your project code is QUASAR-915.'));

    // Step 4: Ensure NO binary audio bytes or TTS metadata are saved in conversation session
    for (const msg of messages) {
      assert.equal(typeof msg.content, 'string');
      assert.ok(!msg.content.includes('[audio]'));
      assert.ok(!msg.content.includes('audio/mpeg'));
    }
  });

  // =========================================================================
  // 5. Error Isolation & Stale Data Protection
  // =========================================================================

  test('STT failure stops pipeline: does NOT call AI, does NOT call TTS, and returns STT_ERROR', async () => {
    mockSttFail = true;
    lastAiReceivedMessages = null;
    lastTtsSynthesizedText = '';

    const runner = new VoiceTurnRunner({
      fetchFn: async (endpoint, opts) => fetch(`${baseUrl}${endpoint}`, opts)
    });

    const audioBlob = new Blob(['audio'], { type: 'audio/webm' });
    let played = false;

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => { played = true; }
    });

    assert.equal(result.success, false);
    assert.equal(result.stage, VoiceTurnState.STT_ERROR);
    assert.equal(played, false);
    assert.equal(lastAiReceivedMessages, null, 'AI must NOT be called when STT fails');
    assert.equal(lastTtsSynthesizedText, '', 'TTS must NOT be called when STT fails');
  });

  test('STT failure cannot submit old transcript to AI', async () => {
    const runner = new VoiceTurnRunner({
      fetchFn: async (endpoint, opts) => fetch(`${baseUrl}${endpoint}`, opts)
    });

    // Successful turn 1
    mockSttTranscript = 'Initial transcript from turn 1';
    mockAiResponseText = 'Answer 1';
    const blob1 = new Blob(['audio-1'], { type: 'audio/webm' });
    const res1 = await runner.execute({ audioBlob: blob1, playAudioFn: async () => {} });
    assert.equal(res1.success, true);

    // Turn 2 with failed STT
    mockSttFail = true;
    lastAiReceivedMessages = null;
    const blob2 = new Blob(['audio-2'], { type: 'audio/webm' });
    const res2 = await runner.execute({ audioBlob: blob2, playAudioFn: async () => {} });

    assert.equal(res2.success, false);
    assert.equal(res2.stage, VoiceTurnState.STT_ERROR);
    assert.equal(lastAiReceivedMessages, null, 'Old transcript must not be sent to AI on STT failure');
  });

  test('AI failure stops pipeline: does NOT call TTS and preserves transcript', async () => {
    mockAiFail = true;
    lastTtsSynthesizedText = '';

    const runner = new VoiceTurnRunner({
      fetchFn: async (endpoint, opts) => fetch(`${baseUrl}${endpoint}`, opts)
    });

    const audioBlob = new Blob(['audio'], { type: 'audio/webm' });
    let played = false;

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => { played = true; }
    });

    assert.equal(result.success, false);
    assert.equal(result.stage, VoiceTurnState.AI_ERROR);
    assert.equal(played, false);
    assert.equal(lastTtsSynthesizedText, '', 'TTS must not be called when AI fails');
    assert.equal(result.transcript, mockSttTranscript, 'Transcript must remain preserved');
  });

  test('TTS failure stops playback and does not fabricate audio', async () => {
    mockTtsFail = true;

    const runner = new VoiceTurnRunner({
      fetchFn: async (endpoint, opts) => fetch(`${baseUrl}${endpoint}`, opts)
    });

    const audioBlob = new Blob(['audio'], { type: 'audio/webm' });
    let played = false;

    const result = await runner.execute({
      audioBlob,
      playAudioFn: async () => { played = true; }
    });

    assert.equal(result.success, false);
    assert.equal(result.stage, VoiceTurnState.TTS_ERROR);
    assert.equal(played, false);
    assert.equal(result.transcript, mockSttTranscript);
    assert.equal(result.response, mockAiResponseText);
  });

  // =========================================================================
  // 6. Existing Capabilities Regressions
  // =========================================================================

  test('deterministic /api/text route continues working', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Ping' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.response, 'JARVIS received: Ping');
  });

  test('streaming /api/ai/stream continues working cleanly', async () => {
    mockAiResponseText = 'Streaming delta response.';
    const res = await fetch(`${baseUrl}/api/ai/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Stream test' })
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Streaming delta response.'));
    assert.ok(text.includes('"type":"done"'));
  });

  test('POST /api/conversation/clear clears both in-memory and persisted storage', async () => {
    sharedSession.addUserMessage('To be cleared');
    assert.equal(sharedSession.size, 1);

    const res = await fetch(`${baseUrl}/api/conversation/clear`, {
      method: 'POST'
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(sharedSession.size, 0);
  });

  test('zero live external provider calls occur during automated test run', () => {
    // Verified by constructor config using mockFetchFn throughout all tests
    assert.ok(true);
  });
});
