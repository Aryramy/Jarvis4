import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterTextToSpeechProvider } from '../../src/providers/openRouterTTS.js';
import { TextToSpeechProvider } from '../../src/providers/textToSpeechBase.js';

describe('OpenRouter Multilingual TTS Provider - Brick 12', () => {
  const MOCK_API_KEY = 'sk-or-v1-mock-test-tts-key-12345';
  const MOCK_MODEL = 'elevenlabs/eleven-v4-turbo';
  const MOCK_VOICE = 'george';

  test('inherits from TextToSpeechProvider base class', () => {
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      voice: MOCK_VOICE
    });
    assert.ok(provider instanceof TextToSpeechProvider);
    assert.equal(provider.name, 'openrouter-tts');
  });

  test('TextToSpeechProvider base contract throws when synthesize() not implemented', async () => {
    const base = new TextToSpeechProvider();
    await assert.rejects(
      async () => base.synthesize('hello'),
      /synthesize\(\) must be implemented/
    );
  });

  // 1. Accepts valid text and returns binary audio bytes with latency
  test('provider accepts valid text and returns binary audio bytes with duration', async () => {
    let capturedUrl = '';
    let capturedOptions = null;
    const fakeMp3Bytes = Buffer.from([0xFF, 0xFB, 0x90, 0x64, 0x00, 0x01, 0x02, 0x03]);

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        arrayBuffer: async () => fakeMp3Bytes.buffer.slice(fakeMp3Bytes.byteOffset, fakeMp3Bytes.byteOffset + fakeMp3Bytes.byteLength)
      };
    };

    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      voice: MOCK_VOICE,
      fetchFn: mockFetch
    });

    const result = await provider.synthesize('Hello Jarvis, speech synthesis is operational.');
    assert.equal(result.success, true);
    assert.ok(Buffer.isBuffer(result.audioBytes));
    assert.equal(result.audioBytes.length, fakeMp3Bytes.length);
    assert.equal(result.mimeType, 'audio/mpeg');
    assert.equal(result.model, MOCK_MODEL);
    assert.equal(result.voice, MOCK_VOICE);
    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.durationMs >= 0);
    assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/audio/speech');

    const parsedBody = JSON.parse(capturedOptions.body);
    assert.equal(parsedBody.model, MOCK_MODEL);
    assert.equal(parsedBody.voice, MOCK_VOICE);
    assert.equal(parsedBody.response_format, 'mp3');
    assert.equal(parsedBody.input, 'Hello Jarvis, speech synthesis is operational.');
    assert.equal(parsedBody.language, undefined, 'CRITICAL: language parameter must not be present');
  });

  // 2. Missing text rejected
  test('missing text (null or undefined) rejected cleanly without network call', async () => {
    let called = false;
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async () => { called = true; }
    });

    const resNull = await provider.synthesize(null);
    assert.equal(resNull.success, false);
    assert.match(resNull.error, /Text input is required/);
    assert.equal(called, false);

    const resUndef = await provider.synthesize(undefined);
    assert.equal(resUndef.success, false);
    assert.match(resUndef.error, /Text input is required/);
    assert.equal(called, false);
  });

  // 3. Non-string text rejected
  test('non-string text rejected cleanly without network call', async () => {
    let called = false;
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async () => { called = true; }
    });

    const resNum = await provider.synthesize(12345);
    assert.equal(resNum.success, false);
    assert.match(resNum.error, /Text input must be a string/);
    assert.equal(called, false);

    const resObj = await provider.synthesize({ text: 'hello' });
    assert.equal(resObj.success, false);
    assert.match(resObj.error, /Text input must be a string/);
    assert.equal(called, false);
  });

  // 4. Empty text rejected
  test('empty text rejected cleanly without network call', async () => {
    let called = false;
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async () => { called = true; }
    });

    const result = await provider.synthesize('');
    assert.equal(result.success, false);
    assert.match(result.error, /Text input cannot be empty/);
    assert.equal(called, false);
  });

  // 5. Whitespace-only text rejected
  test('whitespace-only text rejected cleanly without network call', async () => {
    let called = false;
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async () => { called = true; }
    });

    const result = await provider.synthesize('   \n\t  ');
    assert.equal(result.success, false);
    assert.match(result.error, /Text input cannot be empty or whitespace-only/);
    assert.equal(called, false);
  });

  // 6. Excessive input safely rejected
  test('excessive input (> maxTextLength) safely rejected without network call', async () => {
    let called = false;
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      maxTextLength: 100,
      fetchFn: async () => { called = true; }
    });

    const longText = 'a'.repeat(101);
    const result = await provider.synthesize(longText);
    assert.equal(result.success, false);
    assert.match(result.error, /exceeds maximum allowed length/);
    assert.equal(called, false);
  });

  // 7, 8, 9, 10, 11. Configured endpoint, model, voice, mp3, no language parameter
  test('uses configured endpoint, model, voice, format mp3 and omits language parameter', async () => {
    let capturedBody = null;
    let capturedUrl = '';
    let capturedHeaders = null;

    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: 'sk-or-custom-test-key',
      baseUrl: 'https://custom.openrouter.proxy/v1',
      model: 'elevenlabs/eleven-v4-turbo',
      voice: 'george',
      fetchFn: async (url, options) => {
        capturedUrl = url;
        capturedHeaders = options.headers;
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'audio/mpeg' }),
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
        };
      }
    });

    const result = await provider.synthesize('Testing request construction');
    assert.equal(result.success, true);
    assert.equal(capturedUrl, 'https://custom.openrouter.proxy/v1/audio/speech');
    assert.equal(capturedHeaders['Authorization'], 'Bearer sk-or-custom-test-key');
    assert.equal(capturedHeaders['Content-Type'], 'application/json');
    assert.equal(capturedBody.model, 'elevenlabs/eleven-v4-turbo');
    assert.equal(capturedBody.voice, 'george');
    assert.equal(capturedBody.response_format, 'mp3');
    assert.equal(capturedBody.input, 'Testing request construction');
    assert.equal(capturedBody.language, undefined);
  });

  // 12. English preserved exactly
  test('preserves exact English text without modification', async () => {
    let receivedInput = '';
    const text = 'Power BI is an interactive data visualization platform by Microsoft.';
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async (url, options) => {
        receivedInput = JSON.parse(options.body).input;
        return {
          ok: true,
          headers: new Headers(),
          arrayBuffer: async () => new Uint8Array([1, 2]).buffer
        };
      }
    });

    await provider.synthesize(text);
    assert.equal(receivedInput, text);
  });

  // 13. Urdu Unicode preserved exactly
  test('preserves exact Urdu Unicode text without transliteration or translation', async () => {
    let receivedInput = '';
    const text = 'پاور بی آئی مائیکروسافٹ کا ایک ڈیٹا اینالیٹکس ٹول ہے۔';
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async (url, options) => {
        receivedInput = JSON.parse(options.body).input;
        return {
          ok: true,
          headers: new Headers(),
          arrayBuffer: async () => new Uint8Array([1, 2]).buffer
        };
      }
    });

    await provider.synthesize(text);
    assert.equal(receivedInput, text);
  });

  // 14. Arabic Unicode preserved exactly
  test('preserves exact Arabic Unicode text without transliteration or translation', async () => {
    let receivedInput = '';
    const text = 'باور بي آي هي أداة قوية لتحليل البيانات وتصورها من مايكروسوفت.';
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async (url, options) => {
        receivedInput = JSON.parse(options.body).input;
        return {
          ok: true,
          headers: new Headers(),
          arrayBuffer: async () => new Uint8Array([1, 2]).buffer
        };
      }
    });

    await provider.synthesize(text);
    assert.equal(receivedInput, text);
  });

  // 15. Mixed Urdu + English preserved exactly
  test('preserves exact mixed Urdu + English text', async () => {
    let receivedInput = '';
    const text = 'Jarvis, مجھے Power BI dashboard کے بارے میں بتائیں۔';
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async (url, options) => {
        receivedInput = JSON.parse(options.body).input;
        return {
          ok: true,
          headers: new Headers(),
          arrayBuffer: async () => new Uint8Array([1, 2]).buffer
        };
      }
    });

    await provider.synthesize(text);
    assert.equal(receivedInput, text);
  });

  // 16. Unicode symbols / emojis preserved exactly
  test('preserves emojis and symbols without corruption', async () => {
    let receivedInput = '';
    const text = 'Hello 🤖, your system is 100% operational! ✨';
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async (url, options) => {
        receivedInput = JSON.parse(options.body).input;
        return {
          ok: true,
          headers: new Headers(),
          arrayBuffer: async () => new Uint8Array([1, 2]).buffer
        };
      }
    });

    await provider.synthesize(text);
    assert.equal(receivedInput, text);
  });

  // 17. Valid binary MP3 response accepted
  test('accepts valid binary MP3 bytes and wraps in Buffer', async () => {
    const rawBytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]);
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        arrayBuffer: async () => rawBytes.buffer
      })
    });

    const res = await provider.synthesize('valid binary');
    assert.equal(res.success, true);
    assert.equal(res.audioBytes.length, rawBytes.length);
    assert.equal(res.audioBytes[0], 0x49);
    assert.equal(res.audioBytes[1], 0x44);
    assert.equal(res.audioBytes[2], 0x33);
  });

  // 18. Empty binary audio rejected
  test('empty binary audio from provider (0 bytes) rejected cleanly', async () => {
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        arrayBuffer: async () => new ArrayBuffer(0)
      })
    });

    const res = await provider.synthesize('empty response');
    assert.equal(res.success, false);
    assert.match(res.error, /empty audio response \(0 bytes\)/);
  });

  // 19. HTTP failure controlled
  test('provider HTTP failure handled with status and message', async () => {
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'Invalid API key provided' } })
      })
    });

    const res = await provider.synthesize('test error');
    assert.equal(res.success, false);
    assert.match(res.error, /Provider HTTP 401/);
    assert.match(res.error, /Invalid API key provided/);
  });

  // 20. Timeout controlled
  test('request timeout aborts cleanly and returns controlled timeout error', async () => {
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      timeoutMs: 50,
      fetchFn: async (url, options) => {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
    });

    const res = await provider.synthesize('timeout test');
    assert.equal(res.success, false);
    assert.match(res.error, /Request timed out after 50ms/);
  });

  // 21. Network failure controlled
  test('network failure (connection refused/dns error) handled cleanly', async () => {
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:443');
      }
    });

    const res = await provider.synthesize('network error test');
    assert.equal(res.success, false);
    assert.match(res.error, /Network error: connect ECONNREFUSED/);
  });

  // 22. Malformed/unexpected response controlled
  test('malformed binary response read failure handled cleanly', async () => {
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: MOCK_API_KEY,
      fetchFn: async () => ({
        ok: true,
        headers: new Headers(),
        arrayBuffer: async () => {
          throw new Error('Stream read interrupted');
        }
      })
    });

    const res = await provider.synthesize('malformed test');
    assert.equal(res.success, false);
    assert.match(res.error, /failed to read binary audio/);
  });

  // 23. API key redacted from errors
  test('API key is redacted from any error string', async () => {
    const secretKey = 'sk-or-v1-super-secret-tts-token-999';
    const provider = new OpenRouterTextToSpeechProvider({
      apiKey: secretKey,
      fetchFn: async () => {
        throw new Error(`Failed to authenticate with token ${secretKey}`);
      }
    });

    const res = await provider.synthesize('redaction test');
    assert.equal(res.success, false);
    assert.ok(!res.error.includes(secretKey), 'API key must not appear in error');
    assert.ok(res.error.includes('[REDACTED]'), 'Redacted token marker must appear');
  });

  // Validate config checks
  test('validateConfig rejects missing or empty apiKey, model, or voice', () => {
    const missingKey = new OpenRouterTextToSpeechProvider({ apiKey: '', model: MOCK_MODEL, voice: MOCK_VOICE });
    assert.equal(missingKey.validateConfig().valid, false);

    const missingModel = new OpenRouterTextToSpeechProvider({ apiKey: MOCK_API_KEY, model: '', voice: MOCK_VOICE });
    assert.equal(missingModel.validateConfig().valid, false);

    const missingVoice = new OpenRouterTextToSpeechProvider({ apiKey: MOCK_API_KEY, model: MOCK_MODEL, voice: '' });
    assert.equal(missingVoice.validateConfig().valid, false);

    const valid = new OpenRouterTextToSpeechProvider({ apiKey: MOCK_API_KEY, model: MOCK_MODEL, voice: MOCK_VOICE });
    assert.equal(valid.validateConfig().valid, true);
  });
});
