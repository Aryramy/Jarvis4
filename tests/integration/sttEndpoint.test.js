import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../src/web/server.js';
import { OpenRouterSpeechToTextProvider } from '../../src/providers/openRouterSTT.js';

describe('POST /api/stt - Multilingual STT Endpoint Integration (Brick 10)', () => {
  let server;
  let baseUrl;
  let lastMockUrl = '';
  let lastMockOptions = null;
  let mockTranscriptResponse = 'Hello Jarvis, this is an automated integration test.';
  let mockHttpFail = false;

  const mockFetchFn = async (url, options) => {
    lastMockUrl = url;
    lastMockOptions = options;

    if (mockHttpFail) {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Error',
        json: async () => ({ error: { message: 'Upstream gateway error' } })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        text: mockTranscriptResponse
      })
    };
  };

  const sttProvider = new OpenRouterSpeechToTextProvider({
    apiKey: 'sk-or-v1-integration-test-key',
    model: 'openai/whisper-large-v3-turbo',
    fetchFn: mockFetchFn
  });

  before(async () => {
    server = await startServer(0, '127.0.0.1', { sttProvider });
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

  // 18, 19, 20. Accepts valid audio, returns transcript, returns latency
  test('POST /api/stt accepts valid multipart audio, returns transcript and latency', async () => {
    mockTranscriptResponse = 'Hello Jarvis, recording verified.';
    mockHttpFail = false;

    const audioBytes = Buffer.from('WEBM_AUDIO_DATA_VALID');
    const formData = new FormData();
    formData.append('audio', new Blob([audioBytes], { type: 'audio/webm' }), 'recording.webm');

    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      body: formData
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.text, 'Hello Jarvis, recording verified.');
    assert.equal(typeof data.durationMs, 'number');
    assert.ok(data.durationMs >= 0);
  });

  test('POST /api/stt accepts valid raw audio/webm bytes, returns transcript', async () => {
    mockTranscriptResponse = 'Raw stream received accurately.';
    mockHttpFail = false;

    const audioBytes = Buffer.from('RAW_WEBM_BYTES');
    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: audioBytes
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.text, 'Raw stream received accurately.');
    assert.equal(typeof data.durationMs, 'number');
  });

  test('POST /api/stt returns Urdu transcript accurately', async () => {
    mockTranscriptResponse = 'Jarvis, مجھے Power BI dashboard open کرنا ہے';
    mockHttpFail = false;

    const audioBytes = Buffer.from('AUDIO_URDU_SPEECH');
    const formData = new FormData();
    formData.append('audio', new Blob([audioBytes], { type: 'audio/webm' }), 'speech.webm');

    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      body: formData
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.text, 'Jarvis, مجھے Power BI dashboard open کرنا ہے');
  });

  test('POST /api/stt returns Arabic transcript accurately', async () => {
    mockTranscriptResponse = 'مرحبا جارفس، هذا اختبار صوتي متعدد اللغات';
    mockHttpFail = false;

    const audioBytes = Buffer.from('AUDIO_ARABIC_SPEECH');
    const formData = new FormData();
    formData.append('audio', new Blob([audioBytes], { type: 'audio/webm' }), 'arabic.webm');

    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      body: formData
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.text, 'مرحبا جارفس، هذا اختبار صوتي متعدد اللغات');
  });

  // 21. Invalid upload does not crash server
  test('GET /api/stt rejects with 405 Method Not Allowed and server stays alive', async () => {
    const res = await fetch(`${baseUrl}/api/stt`, { method: 'GET' });
    assert.equal(res.status, 405);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Method Not Allowed');
  });

  test('POST /api/stt rejects unsupported Content-Type with 400 and server stays alive', async () => {
    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: 'fake' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Invalid Content-Type/);
  });

  test('POST /api/stt rejects multipart with missing audio file with 400', async () => {
    const formData = new FormData();
    formData.append('description', 'missing audio field');

    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      body: formData
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Audio file is required/);
  });

  test('POST /api/stt rejects zero-byte audio upload with 400', async () => {
    const formData = new FormData();
    formData.append('audio', new Blob([], { type: 'audio/webm' }), 'empty.webm');

    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      body: formData
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /cannot be empty/);
  });

  test('POST /api/stt rejects non-audio MIME type in multipart with 400', async () => {
    const formData = new FormData();
    formData.append('audio', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'image.png');

    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      body: formData
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Invalid audio MIME type/);
  });

  test('POST /api/stt handles malformed multipart stream without crashing server', async () => {
    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=----WebKitFormBoundaryBroken'
      },
      body: Buffer.from('----WebKitFormBoundaryBroken\r\nContent-Disposition: form-data; name="audio"\r\n\r\npartial')
    });
    // Server should reject cleanly with 400 or 500 without crashing
    assert.ok(res.status >= 400);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  test('POST /api/stt handles upstream provider HTTP failure cleanly', async () => {
    mockHttpFail = true;

    const formData = new FormData();
    formData.append('audio', new Blob([Buffer.from('audio-data')], { type: 'audio/webm' }), 'rec.webm');

    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      body: formData
    });

    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Provider HTTP 500/);
    assert.equal(typeof data.durationMs, 'number');

    mockHttpFail = false;
  });

  test('subsequent requests succeed normally after errors', async () => {
    mockTranscriptResponse = 'System recovered and functional.';
    mockHttpFail = false;

    const formData = new FormData();
    formData.append('audio', new Blob([Buffer.from('valid-recovery-audio')], { type: 'audio/webm' }), 'rec.webm');

    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      body: formData
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.text, 'System recovered and functional.');
  });

  test('missing provider configuration returns 500 without crashing server', async () => {
    const unconfiguredServer = await startServer(0, '127.0.0.1', {
      sttProvider: new OpenRouterSpeechToTextProvider({
        apiKey: '',
        model: 'openai/whisper-large-v3-turbo'
      })
    });
    const addr = unconfiguredServer.address();
    const testUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const formData = new FormData();
      formData.append('audio', new Blob([Buffer.from('audio-data')], { type: 'audio/webm' }), 'rec.webm');

      const res = await fetch(`${testUrl}/api/stt`, {
        method: 'POST',
        body: formData
      });

      assert.equal(res.status, 500);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Configuration error/);
    } finally {
      await new Promise(r => unconfiguredServer.close(r));
    }
  });

  // 24. Live OpenRouter environment variable safety
  test('offline verification remains safe when OPENROUTER_API_KEY is present in environment', async () => {
    const prevKey = process.env.OPENROUTER_API_KEY;
    try {
      process.env.OPENROUTER_API_KEY = 'sk-or-v1-live-simulation-key-do-not-call';

      // Ensure that mockFetch is invoked and NO real OpenRouter network call is dispatched
      let offlineMockCalled = false;
      const testProvider = new OpenRouterSpeechToTextProvider({
        apiKey: process.env.OPENROUTER_API_KEY,
        model: 'openai/whisper-large-v3-turbo',
        fetchFn: async () => {
          offlineMockCalled = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ text: 'Simulated offline response' })
          };
        }
      });

      const result = await testProvider.transcribe(Buffer.from('audio-bytes'), { mimeType: 'audio/webm' });
      assert.equal(result.success, true);
      assert.equal(offlineMockCalled, true);
      assert.equal(result.text, 'Simulated offline response');
    } finally {
      if (prevKey !== undefined) {
        process.env.OPENROUTER_API_KEY = prevKey;
      } else {
        delete process.env.OPENROUTER_API_KEY;
      }
    }
  });
});
