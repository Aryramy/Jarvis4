import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CheaperInferenceProvider } from '../../src/providers/cheaperInference.js';

describe('Cheaper Inference Provider Adapter - Brick 3', () => {
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

  test('valid prompt accepted and successful provider response parsed correctly', async () => {
    let capturedUrl = null;
    let capturedOptions = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'chatcmpl-123',
          model: 'mock-hosted-model-v1',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Power BI is a business analytics and data visualization tool by Microsoft.'
              },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 12, completion_tokens: 15, total_tokens: 27 }
        })
      };
    };

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const result = await provider.generate('Explain Power BI in one sentence.');

    assert.equal(result.success, true);
    assert.equal(result.text, 'Power BI is a business analytics and data visualization tool by Microsoft.');
    assert.equal(result.model, 'mock-hosted-model-v1');
    assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 15, total_tokens: 27 });

    // Verify request construction
    assert.equal(capturedUrl, 'https://api.cheaperinference.com/v1/chat/completions');
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
    assert.equal(capturedOptions.headers['Authorization'], 'Bearer test-secret-key-12345');

    const parsedBody = JSON.parse(capturedOptions.body);
    assert.equal(parsedBody.model, 'mock-hosted-model-v1');
    assert.deepEqual(parsedBody.messages, [
      { role: 'user', content: 'Explain Power BI in one sentence.' }
    ]);
  });

  test('empty prompt rejected cleanly without network call', async () => {
    let called = false;
    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: async () => { called = true; }
    });

    const resEmpty = await provider.generate('');
    assert.equal(resEmpty.success, false);
    assert.equal(resEmpty.error, 'Prompt cannot be empty');

    const resWhitespace = await provider.generate('     \n\t  ');
    assert.equal(resWhitespace.success, false);
    assert.equal(resWhitespace.error, 'Prompt cannot be empty');

    assert.equal(called, false);
  });

  test('non-string prompt rejected cleanly without network call', async () => {
    let called = false;
    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: async () => { called = true; }
    });

    const invalidInputs = [null, undefined, 123, true, {}, []];
    for (const input of invalidInputs) {
      const res = await provider.generate(input);
      assert.equal(res.success, false);
      assert.equal(res.error, 'Prompt must be a string');
    }

    assert.equal(called, false);
  });

  test('missing API key rejected cleanly without network call', async () => {
    let called = false;
    const provider = new CheaperInferenceProvider({
      ...validConfig,
      apiKey: '',
      fetchFn: async () => { called = true; }
    });

    const result = await provider.generate('Hello');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Cheaper Inference API key is required');
    assert.equal(called, false);
  });

  test('missing model rejected cleanly without network call', async () => {
    let called = false;
    const provider = new CheaperInferenceProvider({
      ...validConfig,
      model: '',
      fetchFn: async () => { called = true; }
    });

    const result = await provider.generate('Hello');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Cheaper Inference model is required');
    assert.equal(called, false);
  });

  test('HTTP provider error handled cleanly without crashing', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({
        error: { message: 'Invalid API key provided' }
      })
    });

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const result = await provider.generate('Hello');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Provider HTTP 401: Invalid API key provided');
  });

  test('provider error redacts API key if present in error message', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({
        error: { message: `Key test-secret-key-12345 has expired` }
      })
    });

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const result = await provider.generate('Hello');
    assert.equal(result.success, false);
    assert.match(result.error, /Provider HTTP 403: Key \[REDACTED\] has expired/);
    assert.equal(result.error.includes('test-secret-key-12345'), false);
  });

  test('malformed provider response rejected when missing choices array', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'chat-1', choices: [] })
    });

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const result = await provider.generate('Hello');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Malformed response from provider: missing choices array');
  });

  test('malformed provider response rejected when message content is missing', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ index: 0, message: {} }]
      })
    });

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const result = await provider.generate('Hello');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Malformed response from provider: missing message content');
  });

  test('malformed provider response rejected when response is invalid JSON', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('Unexpected token < in JSON'); }
    });

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const result = await provider.generate('Hello');
    assert.equal(result.success, false);
    assert.match(result.error, /failed to parse JSON/);
  });

  test('network failure handled cleanly', async () => {
    const mockFetch = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:443');
    };

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const result = await provider.generate('Hello');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Network error: connect ECONNREFUSED 127.0.0.1:443');
  });

  test('timeout handled cleanly using AbortController', async () => {
    const mockFetch = async (url, options) => {
      return new Promise((resolvePromise, rejectPromise) => {
        options.signal.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          rejectPromise(abortError);
        });
      });
    };

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      timeoutMs: 20, // 20ms short timeout for fast test
      fetchFn: mockFetch
    });

    const result = await provider.generate('Hello');
    assert.equal(result.success, false);
    assert.match(result.error, /Request timed out after 20ms/);
  });
});
