import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterSpeechToTextProvider } from '../../src/providers/openRouterSTT.js';
import { SpeechToTextProvider } from '../../src/providers/speechToTextBase.js';

describe('OpenRouter Multilingual STT Provider - Brick 10', () => {
  const MOCK_API_KEY = 'sk-or-v1-mock-test-key-98765';
  const MOCK_MODEL = 'openai/whisper-large-v3-turbo';

  test('inherits from SpeechToTextProvider base class', () => {
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL
    });
    assert.ok(provider instanceof SpeechToTextProvider);
    assert.equal(provider.name, 'openrouter-stt');
  });

  test('SpeechToTextProvider base contract throws when transcribe() not implemented', async () => {
    const base = new SpeechToTextProvider();
    await assert.rejects(
      async () => base.transcribe(Buffer.from([1, 2, 3])),
      /transcribe\(\) must be implemented/
    );
  });

  // 1. Provider accepts valid audio
  test('provider accepts valid audio and returns transcription with latency', async () => {
    let capturedUrl = '';
    let capturedOptions = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          text: 'Hello Jarvis, this is multilingual speech test.'
        })
      };
    };

    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: mockFetch
    });

    const audioBytes = Buffer.from('RIFF....fakeaudio');
    const result = await provider.transcribe(audioBytes, { mimeType: 'audio/webm' });

    assert.equal(result.success, true);
    assert.equal(result.text, 'Hello Jarvis, this is multilingual speech test.');
    assert.equal(result.model, MOCK_MODEL);
    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.durationMs >= 0);
    assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/audio/transcriptions');
  });

  // 2. Missing audio rejected
  test('missing audio (null or undefined) rejected cleanly without network call', async () => {
    let called = false;
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => { called = true; }
    });

    const resNull = await provider.transcribe(null);
    assert.equal(resNull.success, false);
    assert.match(resNull.error, /Audio data is required/);
    assert.equal(called, false);

    const resUndef = await provider.transcribe(undefined);
    assert.equal(resUndef.success, false);
    assert.match(resUndef.error, /Audio data is required/);
    assert.equal(called, false);
  });

  // 3. Zero-byte audio rejected
  test('zero-byte audio rejected cleanly without network call', async () => {
    let called = false;
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => { called = true; }
    });

    const emptyBuffer = Buffer.alloc(0);
    const resBuf = await provider.transcribe(emptyBuffer);
    assert.equal(resBuf.success, false);
    assert.match(resBuf.error, /0 bytes/);
    assert.equal(called, false);

    const emptyBlob = new Blob([]);
    const resBlob = await provider.transcribe(emptyBlob);
    assert.equal(resBlob.success, false);
    assert.match(resBlob.error, /0 bytes/);
    assert.equal(called, false);
  });

  // 4. Unsupported / invalid MIME handled safely
  test('unsupported or invalid MIME type handled safely without network call', async () => {
    let called = false;
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => { called = true; }
    });

    const validBytes = Buffer.from('fake-audio-bytes');

    const resImg = await provider.transcribe(validBytes, { mimeType: 'image/png' });
    assert.equal(resImg.success, false);
    assert.match(resImg.error, /Invalid audio MIME type/);
    assert.equal(called, false);

    const resText = await provider.transcribe(validBytes, { mimeType: 'text/plain' });
    assert.equal(resText.success, false);
    assert.match(resText.error, /Invalid audio MIME type/);
    assert.equal(called, false);
  });

  // 5. Actual audio bytes included in request construction
  test('actual audio bytes are included in multipart request construction', async () => {
    let uploadedFile = null;

    const mockFetch = async (url, options) => {
      const formData = options.body;
      uploadedFile = formData.get('file');
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'verified bytes' })
      };
    };

    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: mockFetch
    });

    const rawData = 'AUDIO_BINARY_BYTES_12345';
    const audioBytes = Buffer.from(rawData);

    const result = await provider.transcribe(audioBytes, { mimeType: 'audio/webm' });
    assert.equal(result.success, true);
    assert.ok(uploadedFile);

    const uploadedBuffer = Buffer.from(await uploadedFile.arrayBuffer());
    assert.equal(uploadedBuffer.toString(), rawData);
  });

  // 6. Multipart request uses configured model
  test('multipart request uses configured model', async () => {
    let configuredModelSent = null;

    const mockFetch = async (url, options) => {
      const formData = options.body;
      configuredModelSent = formData.get('model');
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'ok' })
      };
    };

    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: 'openai/whisper-large-v3-turbo',
      fetchFn: mockFetch
    });

    await provider.transcribe(Buffer.from('audio-data'), { mimeType: 'audio/webm' });
    assert.equal(configuredModelSent, 'openai/whisper-large-v3-turbo');
  });

  // 7. Language parameter is NOT sent by default
  test('language parameter is NOT sent by default to enable automatic detection', async () => {
    let languageParamSent = 'INITIAL_VALUE';

    const mockFetch = async (url, options) => {
      const formData = options.body;
      languageParamSent = formData.get('language');
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'multilingual transcript' })
      };
    };

    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: mockFetch
    });

    await provider.transcribe(Buffer.from('speech-audio'), { mimeType: 'audio/webm' });
    assert.equal(languageParamSent, null, 'language parameter must be omitted completely');
  });

  // 8. Transcript text is parsed correctly
  test('transcript text is parsed correctly from response body', async () => {
    const expectedTranscript = 'This is the exact transcription of spoken words.';
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ text: expectedTranscript })
      })
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, true);
    assert.equal(result.text, expectedTranscript);
  });

  // 9. Unicode preserved
  test('Unicode characters are preserved correctly', async () => {
    const unicodeText = 'Café, résumé, señor, naïve, ☕, 🚀 — 100% verified';
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ text: unicodeText })
      })
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, true);
    assert.equal(result.text, unicodeText);
  });

  // 10. Urdu script preserved
  test('Urdu script is preserved without corruption', async () => {
    const urduText = 'ہیلو جاروس، یہ ایک کثیر لسانی ٹیسٹ ہے۔ ہم آواز کی شناخت کی جانچ کر رہے ہیں۔';
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ text: urduText })
      })
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, true);
    assert.equal(result.text, urduText);
  });

  // 11. Arabic script preserved
  test('Arabic script is preserved without corruption', async () => {
    const arabicText = 'مرحبا جارفس، هذا اختبار صوتي متعدد اللغات لتأكيد جودة التعرف على الكلام.';
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ text: arabicText })
      })
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, true);
    assert.equal(result.text, arabicText);
  });

  // 12. Mixed Urdu + English transcript preserved
  test('mixed Urdu and English transcript is preserved without corruption', async () => {
    const mixedText = 'Jarvis, مجھے Power BI dashboard open کرنا ہے اور report check کرنی ہے.';
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ text: mixedText })
      })
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, true);
    assert.equal(result.text, mixedText);
  });

  // 13. HTTP errors controlled
  test('HTTP errors are controlled safely without throwing', async () => {
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'Invalid API key provided' } })
      })
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, false);
    assert.match(result.error, /Provider HTTP 401/);
    assert.match(result.error, /Invalid API key/);
    assert.ok(result.durationMs >= 0);
  });

  // 14. Network failures controlled
  test('network failures are controlled safely without crashing', async () => {
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => {
        throw new Error('connect ECONNREFUSED 104.18.2.1:443');
      }
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, false);
    assert.match(result.error, /Network error: connect ECONNREFUSED/);
    assert.ok(result.durationMs >= 0);
  });

  // 15. Timeout controlled
  test('timeout is controlled using AbortController and reported cleanly', async () => {
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
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
  });

  // 16. Malformed response rejected
  test('malformed response without text property is rejected safely', async () => {
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ other: 'value', count: 123 })
      })
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, false);
    assert.match(result.error, /missing text property/);
  });

  test('malformed non-JSON response is rejected safely', async () => {
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error('Unexpected token < in JSON at position 0'); }
      })
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, false);
    assert.match(result.error, /failed to parse JSON/);
  });

  // 17. API key redacted from errors
  test('API key is redacted from HTTP error messages', async () => {
    const SECRET_KEY = 'sk-or-v1-my-ultra-secret-key-999';
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: SECRET_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({ error: { message: `Authorization failed for key ${SECRET_KEY}` } })
      })
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, false);
    assert.ok(!result.error.includes(SECRET_KEY), 'Secret API key must not appear in error');
    assert.ok(result.error.includes('[REDACTED]'), 'Secret API key must be replaced with [REDACTED]');
  });

  test('API key is redacted from network error messages', async () => {
    const SECRET_KEY = 'sk-or-v1-super-secret-network-key';
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: SECRET_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => {
        throw new Error(`Failed to authenticate with ${SECRET_KEY} to gateway`);
      }
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, false);
    assert.ok(!result.error.includes(SECRET_KEY), 'Secret API key must not appear in network error');
    assert.ok(result.error.includes('[REDACTED]'), 'Secret API key must be replaced with [REDACTED]');
  });

  test('missing API key rejected cleanly by validateConfig without network call', async () => {
    let called = false;
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: '',
      model: MOCK_MODEL,
      fetchFn: async () => { called = true; }
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, false);
    assert.match(result.error, /OpenRouter API key is required/);
    assert.equal(called, false);
  });

  test('missing model rejected cleanly by validateConfig without network call', async () => {
    let called = false;
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: '',
      fetchFn: async () => { called = true; }
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, false);
    assert.match(result.error, /OpenRouter STT model is required/);
    assert.equal(called, false);
  });

  test('includes returned language metadata only if provider returns it', async () => {
    const provider = new OpenRouterSpeechToTextProvider({
      apiKey: MOCK_API_KEY,
      model: MOCK_MODEL,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          text: 'Verified speech',
          language: 'urdu'
        })
      })
    });

    const result = await provider.transcribe(Buffer.from('sample-audio'));
    assert.equal(result.success, true);
    assert.equal(result.text, 'Verified speech');
    assert.equal(result.language, 'urdu');
  });
});
