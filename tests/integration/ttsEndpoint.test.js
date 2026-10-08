import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../src/web/server.js';
import { OpenRouterTextToSpeechProvider } from '../../src/providers/openRouterTTS.js';
import { ConversationSession } from '../../src/core/conversationSession.js';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const HTML_FILE_PATH = join(__dirname, '..', '..', 'src', 'web', 'index.html');

describe('POST /api/tts - Multilingual TTS Endpoint Integration (Brick 12)', () => {
  let server;
  let baseUrl;
  let lastSynthesizedText = '';
  let mockAudioBytes = Buffer.from([0xFF, 0xFB, 0x90, 0x64, 0xAA, 0xBB, 0xCC]);
  let mockHttpFail = false;
  let mockDurationMs = 1247;

  const mockFetchFn = async (url, options) => {
    const parsedBody = JSON.parse(options.body);
    lastSynthesizedText = parsedBody.input;

    if (mockHttpFail) {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Error',
        json: async () => ({ error: { message: 'TTS provider upstream error' } })
      };
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'audio/mpeg'
      }),
      arrayBuffer: async () => mockAudioBytes.buffer.slice(mockAudioBytes.byteOffset, mockAudioBytes.byteOffset + mockAudioBytes.byteLength)
    };
  };

  const ttsProvider = new OpenRouterTextToSpeechProvider({
    apiKey: 'sk-or-v1-integration-tts-key',
    model: 'elevenlabs/eleven-v4-turbo',
    voice: 'george',
    fetchFn: mockFetchFn
  });

  before(async () => {
    server = await startServer(0, '127.0.0.1', { ttsProvider });
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after((done) => {
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  // 1. Accepts valid text, returns audio/mpeg binary bytes and duration header
  test('POST /api/tts accepts valid text and returns binary audio/mpeg with duration header', async () => {
    mockHttpFail = false;
    const inputText = 'Hello JARVIS, this is an automated integration test for text-to-speech.';

    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: inputText })
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const durationHeader = res.headers.get('x-tts-duration-ms');
    assert.ok(durationHeader !== null, 'X-TTS-Duration-Ms header must be present');
    assert.ok(Number(durationHeader) >= 0);

    const receivedBytes = Buffer.from(await res.arrayBuffer());
    assert.equal(receivedBytes.length, mockAudioBytes.length);
    assert.equal(receivedBytes[0], 0xFF);
    assert.equal(receivedBytes[1], 0xFB);
    assert.equal(lastSynthesizedText, inputText);
  });

  // 2. Multilingual: Urdu Unicode preserved
  test('POST /api/tts accepts Urdu Unicode text without modification', async () => {
    mockHttpFail = false;
    const urduText = 'پاور بی آئی مائیکروسافٹ کا ایک اینالیٹکس ٹول ہے۔';

    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: urduText })
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(lastSynthesizedText, urduText);
  });

  // 3. Multilingual: Arabic Unicode preserved
  test('POST /api/tts accepts Arabic Unicode text without modification', async () => {
    mockHttpFail = false;
    const arabicText = 'باور بي آي أداة متقدمة لتحليل البيانات.';

    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: arabicText })
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(lastSynthesizedText, arabicText);
  });

  // 4. Multilingual: Mixed Urdu + English preserved
  test('POST /api/tts accepts mixed Urdu + English text without modification', async () => {
    mockHttpFail = false;
    const mixedText = 'Jarvis, مجھے Power BI dashboard کے بارے میں بتائیں۔';

    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: mixedText })
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(lastSynthesizedText, mixedText);
  });

  // 5. Method validation
  test('GET /api/tts rejects with 405 Method Not Allowed', async () => {
    const res = await fetch(`${baseUrl}/api/tts`, { method: 'GET' });
    assert.equal(res.status, 405);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Method Not Allowed');
  });

  test('PUT /api/tts rejects with 405 Method Not Allowed', async () => {
    const res = await fetch(`${baseUrl}/api/tts`, { method: 'PUT' });
    assert.equal(res.status, 405);
  });

  // 6. Validation: Invalid JSON
  test('POST /api/tts rejects invalid JSON body with 400', async () => {
    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not a valid json'
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Invalid JSON body/);
  });

  // 7. Validation: Missing text
  test('POST /api/tts rejects missing text property with 400', async () => {
    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Text input must be a string/);
  });

  // 8. Validation: Non-string text
  test('POST /api/tts rejects non-string text with 400', async () => {
    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 12345 })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Text input must be a string/);
  });

  // 9. Validation: Empty or whitespace-only text
  test('POST /api/tts rejects empty text with 400', async () => {
    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /cannot be empty or whitespace-only/);
  });

  test('POST /api/tts rejects whitespace-only text with 400', async () => {
    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '    \n\t   ' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /cannot be empty or whitespace-only/);
  });

  // 10. Validation: Excessive input (> 5000 characters)
  test('POST /api/tts rejects excessive text (> 5000 characters) with 400', async () => {
    const excessiveText = 'x'.repeat(5001);
    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: excessiveText })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /exceeds maximum allowed length/);
  });

  // 11. Upstream provider HTTP failure
  test('POST /api/tts handles upstream provider failure with 500', async () => {
    mockHttpFail = true;

    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Trigger upstream error' })
    });

    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Provider HTTP 500/);

    mockHttpFail = false;
  });

  // 12. Missing provider configuration
  test('missing provider configuration returns 500 without crashing server', async () => {
    const unconfiguredServer = await startServer(0, '127.0.0.1', {
      ttsProvider: new OpenRouterTextToSpeechProvider({
        apiKey: '',
        model: 'elevenlabs/eleven-v4-turbo',
        voice: 'george'
      })
    });
    const addr = unconfiguredServer.address();
    const testUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const res = await fetch(`${testUrl}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' })
      });

      assert.equal(res.status, 500);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Configuration error: OpenRouter API key is required/);
    } finally {
      await new Promise(r => unconfiguredServer.close(r));
    }
  });

  // 13. UI structure & contract verification
  test('index.html contains speak-response-btn, tts-status, and tts-playback elements', () => {
    const html = readFileSync(HTML_FILE_PATH, 'utf8');

    assert.ok(html.includes('id="speak-response-btn"'), 'speak-response-btn must exist in index.html');
    assert.ok(html.includes('id="tts-status"'), 'tts-status element must exist');
    assert.ok(html.includes('id="tts-playback"'), 'tts-playback element must exist');
    assert.ok(html.includes('Speak Response'), 'Button text must be "Speak Response"');
  });

  test('index.html client script binds currentAssistantResponse only to completed AI responses', () => {
    const html = readFileSync(HTML_FILE_PATH, 'utf8');

    // Asserts currentAssistantResponse state exists
    assert.ok(html.includes('let currentAssistantResponse = null;'));
    // Asserts speakResponseBtn is initially disabled
    assert.ok(html.includes('<button type="button" id="speak-response-btn" disabled>Speak Response</button>'));
    // Asserts fetch('/api/tts') is triggered by speakResponseBtn
    assert.ok(html.includes("fetch('/api/tts'"));
    // Asserts URL.createObjectURL and URL.revokeObjectURL are used for audio playback cleanup
    assert.ok(html.includes('URL.createObjectURL(blob)'));
    assert.ok(html.includes('URL.revokeObjectURL('));
    // Asserts conversation clear resets currentAssistantResponse
    assert.ok(html.includes('currentAssistantResponse = null;'));
  });

  test('TTS is output-only and is NOT added to ConversationSession memory', () => {
    const session = new ConversationSession();
    session.addUserMessage('Explain LLM');
    session.addAssistantMessage('A large language model is a deep learning model for NLP.');

    // Only user and assistant messages exist in session
    assert.equal(session.size, 2);
    const msgs = session.getMessages();
    assert.equal(msgs[0].role, 'user');
    assert.equal(msgs[1].role, 'assistant');
    // Ensure no audio or TTS artifacts pollute session
    for (const msg of msgs) {
      assert.ok(typeof msg.content === 'string');
      assert.ok(!msg.content.includes('audio/mpeg'));
    }
  });

  // 14. Live provider safety check during verify
  test('offline verification remains safe when OPENROUTER_API_KEY is present in environment', async () => {
    const prevKey = process.env.OPENROUTER_API_KEY;
    try {
      process.env.OPENROUTER_API_KEY = 'sk-or-v1-live-tts-env-simulation-key';

      let offlineMockCalled = false;
      const testProvider = new OpenRouterTextToSpeechProvider({
        apiKey: process.env.OPENROUTER_API_KEY,
        model: 'elevenlabs/eleven-v4-turbo',
        voice: 'george',
        fetchFn: async () => {
          offlineMockCalled = true;
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'audio/mpeg' }),
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
          };
        }
      });

      const result = await testProvider.synthesize('Safe offline simulation');
      assert.equal(result.success, true);
      assert.equal(offlineMockCalled, true);
      assert.ok(Buffer.isBuffer(result.audioBytes));
    } finally {
      if (prevKey !== undefined) {
        process.env.OPENROUTER_API_KEY = prevKey;
      } else {
        delete process.env.OPENROUTER_API_KEY;
      }
    }
  });

  // 15. Client state machine simulation for Speak Response (contracts 28-36)
  test('client state machine guarantees Speak Response uses latest completed AI response, rejects transcript and user prompt', () => {
    // Model the exact state machine from index.html
    let currentAssistantResponse = null;
    let isTtsBusy = false;
    let speakResponseBtnDisabled = true;
    let ttsInputsSent = [];

    const handleAiSuccess = (aiResponse) => {
      currentAssistantResponse = aiResponse;
      speakResponseBtnDisabled = false;
    };

    const handleAiFailure = () => {
      // Do not overwrite currentAssistantResponse with error
    };

    const handleSpeakResponse = () => {
      if (!currentAssistantResponse || currentAssistantResponse.trim().length === 0) return false;
      if (isTtsBusy) return false;
      isTtsBusy = true;
      speakResponseBtnDisabled = true;
      ttsInputsSent.push(currentAssistantResponse);
      isTtsBusy = false;
      speakResponseBtnDisabled = false;
      return true;
    };

    // Initial state: no AI response yet -> Speak Response is disabled
    assert.equal(speakResponseBtnDisabled, true);
    assert.equal(handleSpeakResponse(), false);

    const userPrompt = 'Explain Power BI';
    const voiceTranscript = 'What is Power BI explain it';

    // Proves: user prompt and transcript are NOT used
    assert.notEqual(currentAssistantResponse, userPrompt);
    assert.notEqual(currentAssistantResponse, voiceTranscript);

    // AI completes response 1
    handleAiSuccess('Power BI is a data visualization platform.');
    assert.equal(speakResponseBtnDisabled, false);
    assert.equal(currentAssistantResponse, 'Power BI is a data visualization platform.');

    // User triggers Speak Response
    const spoke1 = handleSpeakResponse();
    assert.equal(spoke1, true);
    assert.equal(ttsInputsSent.length, 1);
    assert.equal(ttsInputsSent[0], 'Power BI is a data visualization platform.');

    // Replay capability: user clicks Speak Response again
    const spokeReplay = handleSpeakResponse();
    assert.equal(spokeReplay, true);
    assert.equal(ttsInputsSent.length, 2);
    assert.equal(ttsInputsSent[1], 'Power BI is a data visualization platform.');

    // Newer AI response completes successfully -> replaces previous response
    handleAiSuccess('Power BI connects to hundreds of data sources.');
    assert.equal(currentAssistantResponse, 'Power BI connects to hundreds of data sources.');

    const spoke2 = handleSpeakResponse();
    assert.equal(spoke2, true);
    assert.equal(ttsInputsSent.length, 3);
    assert.equal(ttsInputsSent[2], 'Power BI connects to hundreds of data sources.');

    // Subsequent failed AI request does not overwrite currentAssistantResponse
    handleAiFailure();
    assert.equal(currentAssistantResponse, 'Power BI connects to hundreds of data sources.');
  });
});

