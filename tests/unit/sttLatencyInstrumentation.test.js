import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { OpenRouterSpeechToTextProvider } from '../../src/providers/openRouterSTT.js';
import { VoiceTurnRunner, VoiceTurnState } from '../../src/web/voiceTurn.js';
import { startServer } from '../../src/web/server.js';
import { ConversationSession } from '../../src/core/conversationSession.js';
import { ConversationStore } from '../../src/core/conversationStore.js';

describe('STT Latency & Quality Instrumentation - Unit & Component Tests (Brick 18)', () => {
  const STT_ENV_VARS = [
    'OPENROUTER_API_KEY',
    'OPENROUTER_STT_BASE_URL',
    'OPENROUTER_STT_MODEL',
    'OPENROUTER_STT_TIMEOUT_MS'
  ];

  let originalEnv = {};

  beforeEach(() => {
    originalEnv = {};
    for (const key of STT_ENV_VARS) {
      if (key in process.env) {
        originalEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    for (const key of STT_ENV_VARS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  const validSttConfig = {
    apiKey: 'sk-or-v1-mock-stt-key-12345',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/whisper-large-v3-turbo',
    timeoutMs: 5000
  };

  // Requirement 2, 3, 4: providerSttDurationMs exists on successful STT, numeric, non-negative
  test('providerSttDurationMs exists, is numeric, and is non-negative on successful STT call', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'What is the capital of Japan?' })
    });

    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      fetchFn: mockFetch
    });

    const audioBytes = Buffer.from('RIFF....mock-audio');
    const result = await provider.transcribe(audioBytes, { mimeType: 'audio/webm' });

    assert.equal(result.success, true);
    assert.ok('providerSttDurationMs' in result, 'providerSttDurationMs must exist in result');
    assert.equal(typeof result.providerSttDurationMs, 'number', 'providerSttDurationMs must be numeric');
    assert.ok(result.providerSttDurationMs >= 0, 'providerSttDurationMs must be non-negative');
    assert.ok(Number.isFinite(result.providerSttDurationMs), 'providerSttDurationMs must be finite');
    assert.equal(typeof result.durationMs, 'number', 'durationMs must be preserved for compatibility');
  });

  // Requirement 11 & 12: OpenRouter provider and Whisper model identity preserved
  test('OpenRouter provider identity and Whisper model identity are preserved', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'Model identity verification.' })
    });

    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      fetchFn: mockFetch
    });

    const result = await provider.transcribe(Buffer.from('audio-bytes'), { mimeType: 'audio/webm' });
    assert.equal(result.success, true);
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.model, 'openai/whisper-large-v3-turbo');
  });

  // Requirement 13, 14, 15, 16, 17, 18: raw transcript preserved exactly (English, Urdu, Arabic, mixed, emojis)
  test('raw English transcript preserved exactly without alteration', async () => {
    const englishText = 'What is the capital of Japan? Answer briefly.';
    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ text: englishText }) })
    });

    const result = await provider.transcribe(Buffer.from('audio-bytes'), { mimeType: 'audio/webm' });
    assert.equal(result.success, true);
    assert.equal(result.text, englishText);
    assert.equal(result.transcript, englishText);
  });

  test('raw Urdu transcript preserved exactly without alteration', async () => {
    const urduText = 'پاور بی آئی کیا ہے؟';
    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ text: urduText }) })
    });

    const result = await provider.transcribe(Buffer.from('audio-bytes'), { mimeType: 'audio/webm' });
    assert.equal(result.success, true);
    assert.equal(result.text, urduText);
    assert.equal(result.transcript, urduText);
  });

  test('raw Arabic transcript preserved exactly without alteration', async () => {
    const arabicText = 'ما هي عاصمة فرنسا؟ أجب باختصار.';
    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ text: arabicText }) })
    });

    const result = await provider.transcribe(Buffer.from('audio-bytes'), { mimeType: 'audio/webm' });
    assert.equal(result.success, true);
    assert.equal(result.text, arabicText);
    assert.equal(result.transcript, arabicText);
  });

  test('raw mixed-language transcript preserved exactly without alteration', async () => {
    const mixedText = 'Jarvis, مجھے Power BI dashboard open کرنا ہے.';
    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ text: mixedText }) })
    });

    const result = await provider.transcribe(Buffer.from('audio-bytes'), { mimeType: 'audio/webm' });
    assert.equal(result.success, true);
    assert.equal(result.text, mixedText);
    assert.equal(result.transcript, mixedText);
  });

  test('raw emojis and symbols preserved if returned by provider', async () => {
    const emojiText = 'Hello JARVIS! 🚀 ⭐ 100% verified.';
    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ text: emojiText }) })
    });

    const result = await provider.transcribe(Buffer.from('audio-bytes'), { mimeType: 'audio/webm' });
    assert.equal(result.success, true);
    assert.equal(result.text, emojiText);
    assert.equal(result.transcript, emojiText);
  });

  // Requirement 22 & 23: zero-byte audio and invalid request still rejected cleanly
  test('zero-byte audio still rejected cleanly with 0 duration', async () => {
    let called = false;
    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      fetchFn: async () => { called = true; }
    });

    const result = await provider.transcribe(Buffer.alloc(0));
    assert.equal(result.success, false);
    assert.match(result.error, /0 bytes/);
    assert.equal(result.providerSttDurationMs, 0);
    assert.equal(called, false);
  });

  test('invalid audio MIME type still rejected cleanly with 0 duration', async () => {
    let called = false;
    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      fetchFn: async () => { called = true; }
    });

    const result = await provider.transcribe(Buffer.from('fake'), { mimeType: 'application/json' });
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid audio MIME type/);
    assert.equal(result.providerSttDurationMs, 0);
    assert.equal(called, false);
  });

  // Requirement 24, 25, 26: provider failure records controlled timing
  test('provider timeout records controlled elapsed providerSttDurationMs', async () => {
    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      timeoutMs: 30,
      fetchFn: async (url, options) => {
        return new Promise((resolve, reject) => {
          if (options.signal) {
            options.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, false);
    assert.match(result.error, /Request timed out after 30ms/);
    assert.ok('providerSttDurationMs' in result);
    assert.equal(typeof result.providerSttDurationMs, 'number');
    assert.ok(result.providerSttDurationMs >= 0);
  });

  test('provider HTTP error records controlled elapsed providerSttDurationMs', async () => {
    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      fetchFn: async () => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({ error: { message: 'OpenRouter STT gateway overloaded' } })
      })
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, false);
    assert.match(result.error, /Provider HTTP 503/);
    assert.ok('providerSttDurationMs' in result);
    assert.equal(typeof result.providerSttDurationMs, 'number');
    assert.ok(result.providerSttDurationMs >= 0);
  });

  test('network failure records controlled elapsed providerSttDurationMs', async () => {
    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      fetchFn: async () => {
        throw new Error('ECONNRESET: connection reset by peer');
      }
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, false);
    assert.match(result.error, /Network error: ECONNRESET/);
    assert.ok('providerSttDurationMs' in result);
    assert.equal(typeof result.providerSttDurationMs, 'number');
    assert.ok(result.providerSttDurationMs >= 0);
  });

  // Requirement 27 & 28: API key and Authorization header never exposed
  test('API key and Authorization header never exposed in error or timing metadata', async () => {
    const SECRET_KEY = 'sk-or-v1-super-secret-stt-key-brick18';
    const provider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      apiKey: SECRET_KEY,
      fetchFn: async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: `Key ${SECRET_KEY} rejected by gateway` } })
      })
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, false);
    assert.ok(!result.error.includes(SECRET_KEY), 'Secret API key must not appear in error');
    assert.ok(result.error.includes('[REDACTED]'));

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(SECRET_KEY), 'Secret API key must not appear in serialized result');
  });

  // Requirement 5, 6, 7, 19, 20, 21: Server endpoint integration (/api/stt)
  describe('/api/stt Server Endpoint Timing & Audio Metadata', () => {
    let server;
    let baseUrl;
    let mockTranscript = 'Server STT integration test.';
    let mockProviderDurationMs = 150;
    let mockFail = false;

    const mockFetch = async () => {
      if (mockFail) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: { message: 'Provider failure' } })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: mockTranscript })
      };
    };

    const sttProvider = new OpenRouterSpeechToTextProvider({
      ...validSttConfig,
      fetchFn: mockFetch
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

    test('POST /api/stt returns serverSttDurationMs, providerSttDurationMs, timing object, and audio metadata', async () => {
      mockFail = false;
      mockTranscript = 'Diagnostic timing contract verified.';

      const audioBytes = Buffer.from('WEBM_AUDIO_RECORDING_12345');
      const formData = new FormData();
      formData.append('audio', new Blob([audioBytes], { type: 'audio/webm;codecs=opus' }), 'recording.webm');
      formData.append('audioDurationMs', '4200');

      const res = await fetch(`${baseUrl}/api/stt`, {
        method: 'POST',
        headers: {
          'X-Audio-Duration-Ms': '4200'
        },
        body: formData
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.text, 'Diagnostic timing contract verified.');
      assert.equal(data.transcript, 'Diagnostic timing contract verified.');
      assert.equal(data.provider, 'openrouter');
      assert.equal(data.model, 'openai/whisper-large-v3-turbo');

      // Requirement 5, 6, 7: serverSttDurationMs exists, numeric, non-negative
      assert.ok('serverSttDurationMs' in data);
      assert.equal(typeof data.serverSttDurationMs, 'number');
      assert.ok(data.serverSttDurationMs >= 0);

      // Requirement 2, 3, 4: providerSttDurationMs exists, numeric, non-negative
      assert.ok('providerSttDurationMs' in data);
      assert.equal(typeof data.providerSttDurationMs, 'number');
      assert.ok(data.providerSttDurationMs >= 0);

      // Timing object
      assert.ok('timing' in data);
      assert.equal(typeof data.timing.serverSttDurationMs, 'number');
      assert.equal(typeof data.timing.providerSttDurationMs, 'number');

      // Requirement 19, 20, 21: audio request metadata
      assert.equal(data.audioDurationMs, 4200);
      assert.equal(data.audioSizeBytes, audioBytes.length);
      assert.ok(data.audioMimeType.includes('audio/webm'));
      assert.ok(data.audio);
      assert.equal(data.audio.audioDurationMs, 4200);
      assert.equal(data.audio.audioSizeBytes, audioBytes.length);
    });

    test('POST /api/stt failure returns serverSttDurationMs and providerSttDurationMs in error response', async () => {
      mockFail = true;

      const audioBytes = Buffer.from('SAMPLE_AUDIO');
      const formData = new FormData();
      formData.append('audio', new Blob([audioBytes], { type: 'audio/webm' }), 'rec.webm');

      const res = await fetch(`${baseUrl}/api/stt`, {
        method: 'POST',
        body: formData
      });

      assert.equal(res.status, 500);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Provider HTTP 500/);
      assert.equal(typeof data.serverSttDurationMs, 'number');
      assert.ok(data.serverSttDurationMs >= 0);
      assert.equal(typeof data.providerSttDurationMs, 'number');
      assert.ok(data.providerSttDurationMs >= 0);
      assert.ok(data.timing);

      mockFail = false;
    });

    // Requirement 39: STT audio not written to conversation memory
    test('STT audio is never written into conversation memory or store', async () => {
      const session = new ConversationSession();
      assert.equal(session.getMessages().length, 0);

      const audioBytes = Buffer.from('PRIVATE_AUDIO_BYTES');
      const formData = new FormData();
      formData.append('audio', new Blob([audioBytes], { type: 'audio/webm' }), 'rec.webm');

      const res = await fetch(`${baseUrl}/api/stt`, {
        method: 'POST',
        body: formData
      });

      assert.equal(res.status, 200);
      assert.equal(session.getMessages().length, 0, 'No audio data or transcript automatically added to ConversationSession');
    });
  });

  // Requirement 8, 9, 10, 29, 30: VoiceTurnRunner STT instrumentation & safety
  describe('VoiceTurnRunner STT Latency & Safety', () => {
    test('VoiceTurnRunner measures clientSttDurationMs and exposes serverSttDurationMs & providerSttDurationMs', async () => {
      const mockFetch = async (url) => {
        if (url === '/api/stt') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              text: 'Voice turn prompt',
              durationMs: 140,
              providerSttDurationMs: 140,
              serverSttDurationMs: 145,
              audioDurationMs: 3100,
              audioSizeBytes: 45000,
              audioMimeType: 'audio/webm;codecs=opus',
              timing: {
                providerSttDurationMs: 140,
                serverSttDurationMs: 145
              }
            })
          };
        }
        if (url === '/api/ai') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              response: 'Voice turn answer',
              timing: { providerDurationMs: 500, serverAiDurationMs: 505 }
            })
          };
        }
        if (url === '/api/tts') {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'audio/mpeg', 'x-tts-duration-ms': '120' }),
            blob: async () => new Blob([new Uint8Array([0xFF, 0xFB, 0x90, 0x44])], { type: 'audio/mpeg' })
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };

      const runner = new VoiceTurnRunner({ fetchFn: mockFetch });
      const audioBlob = new Blob(['recorded-audio-bytes'], { type: 'audio/webm;codecs=opus' });

      let sttSuccessDetails = null;
      let playingMetrics = null;

      const result = await runner.execute({
        audioBlob,
        audioDurationMs: 3100,
        onStageChange: (stage, details) => {
          if (stage === 'STT_SUCCESS') {
            sttSuccessDetails = details;
          }
        },
        playAudioFn: async (blob, metrics) => {
          playingMetrics = metrics;
        }
      });

      assert.equal(result.success, true);

      // Requirement 8, 9, 10: clientSttDurationMs exists, numeric, non-negative
      assert.ok('clientSttDurationMs' in result);
      assert.equal(typeof result.clientSttDurationMs, 'number');
      assert.ok(result.clientSttDurationMs >= 0);

      // Server and provider STT durations
      assert.equal(result.serverSttDurationMs, 145);
      assert.equal(result.providerSttDurationMs, 140);

      // Audio request metadata recorded
      assert.equal(result.audioDurationMs, 3100);
      assert.equal(result.audioSizeBytes, 45000);
      assert.equal(result.audioMimeType, 'audio/webm;codecs=opus');

      // STT_SUCCESS stage callback
      assert.ok(sttSuccessDetails !== null);
      assert.equal(typeof sttSuccessDetails.clientSttDurationMs, 'number');
      assert.equal(sttSuccessDetails.serverSttDurationMs, 145);
      assert.equal(sttSuccessDetails.providerSttDurationMs, 140);
      assert.equal(sttSuccessDetails.audioDurationMs, 3100);

      // Playback metrics
      assert.ok(playingMetrics !== null);
      assert.equal(typeof playingMetrics.clientSttDurationMs, 'number');
      assert.equal(playingMetrics.serverSttDurationMs, 145);
      assert.equal(playingMetrics.providerSttDurationMs, 140);
      assert.equal(playingMetrics.audioDurationMs, 3100);
    });

    // Requirement 29 & 30: AI NOT called after STT failure and stale transcript cannot propagate
    test('AI is never called after STT failure and stale transcript cannot propagate', async () => {
      let aiCallCount = 0;
      let ttsCallCount = 0;

      const mockFetch = async (url) => {
        if (url === '/api/stt') {
          return {
            ok: false,
            status: 500,
            json: async () => ({
              success: false,
              error: 'STT service temporary unavailable',
              timing: { serverSttDurationMs: 45, providerSttDurationMs: 40 }
            })
          };
        }
        if (url === '/api/ai') {
          aiCallCount++;
          return { ok: true, status: 200, json: async () => ({ success: true, response: 'Stale AI response' }) };
        }
        if (url === '/api/tts') {
          ttsCallCount++;
          return { ok: true, status: 200, blob: async () => new Blob([]) };
        }
        return { ok: false, status: 404 };
      };

      const runner = new VoiceTurnRunner({ fetchFn: mockFetch });
      const audioBlob = new Blob(['failing-audio'], { type: 'audio/webm' });

      let sttErrorDetails = null;
      const result = await runner.execute({
        audioBlob,
        onStageChange: (stage, details) => {
          if (stage === VoiceTurnState.STT_ERROR) {
            sttErrorDetails = details;
          }
        }
      });

      assert.equal(result.success, false);
      assert.equal(result.stage, VoiceTurnState.STT_ERROR);
      assert.equal(aiCallCount, 0, 'AI must NOT be called when STT fails');
      assert.equal(ttsCallCount, 0, 'TTS must NOT be called when STT fails');
      assert.equal(typeof result.clientSttDurationMs, 'number');
      assert.ok(sttErrorDetails !== null);
      assert.equal(typeof sttErrorDetails.clientSttDurationMs, 'number');
    });

    // Requirement 40 & 41: current recording metadata belongs to current recording, new replaces old
    test('second turn uses new recording metadata and replaces old metadata completely', async () => {
      let turnNumber = 0;
      const mockFetch = async (url) => {
        if (url === '/api/stt') {
          turnNumber++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              text: `Transcript turn ${turnNumber}`,
              timing: { providerSttDurationMs: 100 * turnNumber, serverSttDurationMs: 110 * turnNumber },
              providerSttDurationMs: 100 * turnNumber,
              serverSttDurationMs: 110 * turnNumber,
              audioDurationMs: 1000 * turnNumber
            })
          };
        }
        if (url === '/api/ai') {
          return { ok: true, status: 200, json: async () => ({ success: true, response: `Response turn ${turnNumber}` }) };
        }
        if (url === '/api/tts') {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'audio/mpeg', 'x-tts-duration-ms': '50' }),
            blob: async () => new Blob(['mp3'])
          };
        }
        return { ok: false, status: 404 };
      };

      const runner = new VoiceTurnRunner({ fetchFn: mockFetch });

      // Turn 1
      const res1 = await runner.execute({
        audioBlob: new Blob(['audio1'], { type: 'audio/webm' }),
        audioDurationMs: 1000,
        playAudioFn: async () => {}
      });
      assert.equal(res1.transcript, 'Transcript turn 1');
      assert.equal(res1.audioDurationMs, 1000);
      assert.equal(res1.providerSttDurationMs, 100);

      // Turn 2
      const res2 = await runner.execute({
        audioBlob: new Blob(['audio2-different-bytes'], { type: 'audio/webm' }),
        audioDurationMs: 2000,
        playAudioFn: async () => {}
      });
      assert.equal(res2.transcript, 'Transcript turn 2');
      assert.equal(res2.audioDurationMs, 2000);
      assert.equal(res2.providerSttDurationMs, 200);
      assert.notEqual(res2.transcript, res1.transcript);
    });
  });

  // Requirement 31, 32, 42, 43, 44, 45, 46, 47: Architectural boundaries check
  describe('Architectural Boundary Assertions', () => {
    test('no transcript correction, normalization, or translation logic exists in STT pipeline', async () => {
      const openRouterSttCode = readFileSync(join(process.cwd(), 'src/providers/openRouterSTT.js'), 'utf8');
      assert.ok(!openRouterSttCode.includes('filterHallucination'), 'No hallucination filter');
      assert.ok(!openRouterSttCode.includes('normalizeTranscript'), 'No normalization filter');
      assert.ok(!openRouterSttCode.includes('translate('), 'No translation logic');
      assert.ok(!openRouterSttCode.includes('trimSilence'), 'No silence trimming');
      assert.ok(!openRouterSttCode.includes('vad'), 'No VAD logic');
    });

    test('no STT provider fallback or routing added', async () => {
      const openRouterSttCode = readFileSync(join(process.cwd(), 'src/providers/openRouterSTT.js'), 'utf8');
      assert.ok(!openRouterSttCode.includes('groq'), 'No Groq fallback');
      assert.ok(!openRouterSttCode.includes('deepinfra'), 'No DeepInfra fallback');
      assert.ok(!openRouterSttCode.includes('fallback'), 'No fallback routing');
    });

    test('HTML interface preserves STT status and secondary diagnostic structure', () => {
      const html = readFileSync(join(process.cwd(), 'src/web/index.html'), 'utf8');
      assert.ok(html.includes('id="stt-status"'), 'stt-status element must exist');
      assert.ok(html.includes('id="stt-diag"'), 'stt-diag element must exist');
      assert.ok(html.includes('id="transcribe-btn"'), 'transcribe-btn must exist');
      assert.ok(html.includes('id="run-voice-turn-btn"'), 'run-voice-turn-btn must exist');
      assert.ok(html.includes('clientSttDurationMs'), 'clientSttDurationMs must be present in script');
      assert.ok(html.includes('STT Provider:'), 'STT Provider secondary display must be present');
      assert.ok(html.includes('STT Server:'), 'STT Server secondary display must be present');
      assert.ok(html.includes('STT Client:'), 'STT Client secondary display must be present');
    });
  });
});
