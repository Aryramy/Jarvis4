import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterTextProvider } from '../../src/providers/openRouterText.js';
import { AIProvider } from '../../src/providers/base.js';
import { CheaperInferenceProvider } from '../../src/providers/cheaperInference.js';
import { createRequestListener } from '../../src/web/server.js';
import { ConversationSession } from '../../src/core/conversationSession.js';

describe('OpenRouter Text Provider Adapter & Production Migration - Brick 17', () => {
  const OPENROUTER_ENV_VARS = [
    'OPENROUTER_API_KEY',
    'OPENROUTER_TEXT_BASE_URL',
    'OPENROUTER_TEXT_MODEL',
    'OPENROUTER_TEXT_TIMEOUT_MS',
    'CHEAPER_INFERENCE_API_KEY',
    'CHEAPER_INFERENCE_BASE_URL',
    'CHEAPER_INFERENCE_MODEL',
    'CHEAPER_INFERENCE_TIMEOUT_MS'
  ];

  let originalEnv = {};

  beforeEach(() => {
    originalEnv = {};
    for (const key of OPENROUTER_ENV_VARS) {
      if (key in process.env) {
        originalEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    for (const key of OPENROUTER_ENV_VARS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  const validConfig = {
    apiKey: 'sk-or-test-secret-key-12345',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4-flash-0731',
    timeoutMs: 30000
  };

  // Requirement 2 & 3: OpenRouterTextProvider exists & satisfies contract
  test('OpenRouterTextProvider exists and inherits from AIProvider', () => {
    const provider = new OpenRouterTextProvider(validConfig);
    assert.ok(provider instanceof AIProvider, 'must inherit from AIProvider');
    assert.equal(typeof provider.generate, 'function');
    assert.equal(typeof provider.generateMessages, 'function');
    assert.equal(typeof provider.stream, 'function');
    assert.equal(typeof provider.streamMessages, 'function');
    assert.equal(provider.name, 'openrouter-text');
  });

  // Requirement 4 & 5: Correct OpenRouter text endpoint and model used
  test('uses correct OpenRouter text endpoint and target model by default', () => {
    const provider = new OpenRouterTextProvider();
    assert.equal(provider.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(provider.model, 'deepseek/deepseek-v4-flash-0731');
    assert.equal(provider.timeoutMs, 30000);
  });

  // Config validation
  test('validateConfig rejects missing or empty API key', () => {
    const provider = new OpenRouterTextProvider({ model: 'deepseek/deepseek-v4-flash-0731' });
    const check = provider.validateConfig();
    assert.equal(check.valid, false);
    assert.equal(check.error, 'OpenRouter API key is required');
  });

  test('validateConfig rejects missing or empty model', () => {
    const provider = new OpenRouterTextProvider({ apiKey: 'sk-or-test', model: '' });
    const check = provider.validateConfig();
    assert.equal(check.valid, false);
    assert.equal(check.error, 'OpenRouter text model is required');
  });

  test('validateConfig accepts valid configuration', () => {
    const provider = new OpenRouterTextProvider(validConfig);
    const check = provider.validateConfig();
    assert.equal(check.valid, true);
  });

  // Requirement 6, 7, 8: Headers and API key security
  test('Authorization header generated internally and API key never leaked', async () => {
    let capturedUrl = null;
    let capturedHeaders = null;
    let capturedBody = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: '4' } }]
        })
      };
    };

    const provider = new OpenRouterTextProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('What is 2 + 2?');

    assert.equal(result.success, true);
    assert.equal(result.text, '4');
    assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(capturedHeaders['Authorization'], 'Bearer sk-or-test-secret-key-12345');
    assert.equal(capturedHeaders['Content-Type'], 'application/json');
    assert.equal(capturedBody.model, 'deepseek/deepseek-v4-flash-0731');

    // Result object must not contain raw API key
    assert.equal(JSON.stringify(result).includes('sk-or-test-secret-key-12345'), false);
  });

  test('API key never appears in controlled errors', async () => {
    const mockFetch = async () => {
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({
          error: { message: 'Invalid credentials with sk-or-test-secret-key-12345' }
        })
      };
    };

    const provider = new OpenRouterTextProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('Hello');

    assert.equal(result.success, false);
    assert.equal(result.error.includes('sk-or-test-secret-key-12345'), false);
    assert.equal(result.error.includes('[REDACTED]'), true);
  });

  // Requirement 9, 10, 11, 12: Request format & message preservation
  test('messages, system prompt, and conversation history preserved in exact order', async () => {
    let capturedBody = null;

    const mockFetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Response from OpenRouter' } }]
        })
      };
    };

    const provider = new OpenRouterTextProvider({ ...validConfig, fetchFn: mockFetch });
    const history = [
      { role: 'system', content: 'You are JARVIS.' },
      { role: 'user', content: 'My code is NOVA-17.' },
      { role: 'assistant', content: 'Recorded.' },
      { role: 'user', content: 'What is my code?' }
    ];

    const result = await provider.generateMessages(history);
    assert.equal(result.success, true);
    assert.equal(capturedBody.messages.length, 4);
    assert.deepEqual(capturedBody.messages, history);
  });

  // Requirement 13, 14, 15, 16: Multilingual Unicode preservation
  test('preserves Unicode English, Urdu, Arabic, and mixed code-switched text verbatim', async () => {
    const prompts = [
      'What is 2 + 2?',
      'پاور بی آئی کیا ہے؟ ایک مختصر جواب دو۔',
      'ما هو Power BI؟ أجب بجملة قصيرة.',
      'Can you explain پاور بی آئی dashboard in Urdu and English?'
    ];

    for (const promptText of prompts) {
      let capturedBody = null;
      const mockFetch = async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: `Echo: ${promptText}` } }]
          })
        };
      };

      const provider = new OpenRouterTextProvider({ ...validConfig, fetchFn: mockFetch });
      const result = await provider.generate(promptText);
      assert.equal(result.success, true);
      assert.equal(capturedBody.messages[0].content, promptText);
      assert.equal(result.text, `Echo: ${promptText}`);
    }
  });

  // Requirement 17, 18, 19, 20: providerDurationMs measurement & timeout
  test('providerDurationMs is numeric, non-negative, and measured monotonically', async () => {
    const mockFetch = async () => {
      await new Promise(r => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Hello' } }]
        })
      };
    };

    const provider = new OpenRouterTextProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('test');
    assert.equal(result.success, true);
    assert.equal(typeof result.providerDurationMs, 'number');
    assert.ok(result.providerDurationMs >= 15, `duration was ${result.providerDurationMs}`);
  });

  test('timeout is respected and reports controlled timeout error', async () => {
    const mockFetch = async (url, options) => {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };

    const provider = new OpenRouterTextProvider({ ...validConfig, timeoutMs: 30, fetchFn: mockFetch });
    const result = await provider.generate('Slow request');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('timed out after 30ms'));
    assert.equal(typeof result.providerDurationMs, 'number');
  });

  // Requirement 21, 22, 24, 25: Error handling & malformed responses
  test('handles network errors safely without throwing', async () => {
    const mockFetch = async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    };

    const provider = new OpenRouterTextProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('fail');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('Network error: fetch failed: ECONNREFUSED'));
  });

  test('handles malformed provider responses safely without throwing', async () => {
    const mockFetch = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ unexpected: true })
      };
    };

    const provider = new OpenRouterTextProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('malformed');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('missing choices array'));
  });

  test('handles empty message content safely', async () => {
    const mockFetch = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: {} }] })
      };
    };

    const provider = new OpenRouterTextProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('empty content');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('missing message content'));
  });

  // Requirement 29: Diagnostic provider and model identity
  test('returns safe diagnostic provider and model identity in response', async () => {
    const mockFetch = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'deepseek/deepseek-v4-flash-0731',
          choices: [{ message: { role: 'assistant', content: 'OK' } }]
        })
      };
    };

    const provider = new OpenRouterTextProvider({ ...validConfig, fetchFn: mockFetch });
    const result = await provider.generate('identity');
    assert.equal(result.success, true);
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.model, 'deepseek/deepseek-v4-flash-0731');
  });

  // Requirement 33, 34, 35, 36: Streaming AI with OpenRouter
  test('streaming AI chunks reconstructed correctly with OpenRouter', async () => {
    const ssePayload = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      '',
      ': keep-alive comment',
      'data: {"choices":[{"delta":{"content":" world!"}}]}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    const mockFetch = async (url, options) => {
      assert.equal(JSON.parse(options.body).stream, true);
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield ssePayload;
        })()
      };
    };

    const provider = new OpenRouterTextProvider({ ...validConfig, fetchFn: mockFetch });
    const deltas = [];
    for await (const chunk of provider.stream('Say hello')) {
      deltas.push(chunk);
    }

    assert.deepEqual(deltas, ['Hello', ' world!']);
  });

  // Requirement 26, 27, 28, 49, 50: Production Web Server uses OpenRouterTextProvider
  test('/api/ai uses OpenRouterTextProvider and returns provider diagnostic identity', async () => {
    let providerCalled = false;
    const mockFetch = async (url, options) => {
      providerCalled = true;
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'OpenRouter live answer: 4' } }]
        })
      };
    };

    const openRouterProvider = new OpenRouterTextProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const listener = createRequestListener({ provider: openRouterProvider });

    // Mock incoming req / res
    let resStatus = null;
    let resHeaders = {};
    let resBody = '';

    await new Promise((resolve) => {
      const req = {
        method: 'POST',
        url: '/api/ai',
        headers: { host: '127.0.0.1:8080' },
        on(event, handler) {
          if (event === 'data') handler(JSON.stringify({ input: 'What is 2 + 2?' }));
          if (event === 'end') setTimeout(() => handler(), 0);
        }
      };

      const res = {
        writeHead(status, headers) {
          resStatus = status;
          resHeaders = headers;
        },
        end(body) {
          resBody = body;
          resolve();
        }
      };

      listener(req, res);
    });

    assert.equal(providerCalled, true);
    assert.equal(resStatus, 200);
    const parsed = JSON.parse(resBody);
    assert.equal(parsed.success, true);
    assert.equal(parsed.response, 'OpenRouter live answer: 4');
    assert.equal(parsed.provider, 'openrouter');
    assert.equal(parsed.model, 'deepseek/deepseek-v4-flash-0731');
    assert.equal(typeof parsed.timing.providerDurationMs, 'number');
    assert.equal(typeof parsed.timing.serverAiDurationMs, 'number');
  });

  test('PRODUCTION PROVIDER ASSERTION: default server text AI resolves to OpenRouter and NOT Cheaper', async () => {
    // When no provider option is passed, createRequestListener must use OpenRouterTextProvider
    let calledUrl = null;
    let calledModel = null;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, options) => {
      calledUrl = url;
      const body = JSON.parse(options.body);
      calledModel = body.model;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Production OpenRouter Answer' } }]
        })
      };
    };

    try {
      process.env.OPENROUTER_API_KEY = 'sk-or-production-test-key';
      const listener = createRequestListener(); // Zero options passed: uses default production provider

      let resStatus = null;
      let resBody = '';

      await new Promise((resolve) => {
        const req = {
          method: 'POST',
          url: '/api/ai',
          headers: { host: '127.0.0.1:8080' },
          on(event, handler) {
            if (event === 'data') handler(JSON.stringify({ input: 'Hello production' }));
            if (event === 'end') setTimeout(() => handler(), 0);
          }
        };

        const res = {
          writeHead(status) { resStatus = status; },
          end(body) {
            resBody = body;
            resolve();
          }
        };

        listener(req, res);
      });

      assert.equal(resStatus, 200);
      assert.equal(calledUrl, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(calledModel, 'deepseek/deepseek-v4-flash-0731');
      assert.notEqual(calledUrl, 'https://api.cheaperinference.com/v1/chat/completions');

      const data = JSON.parse(resBody);
      assert.equal(data.provider, 'openrouter');
      assert.equal(data.model, 'deepseek/deepseek-v4-flash-0731');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('no fallback to Cheaper Inference when OpenRouter fails', async () => {
    let cheaperCalled = false;
    const mockCheaperFetch = async () => {
      cheaperCalled = true;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Fallback' } }] }) };
    };

    const failingOpenRouter = new OpenRouterTextProvider({
      ...validConfig,
      fetchFn: async () => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({ error: { message: 'OpenRouter down' } })
      })
    });

    const listener = createRequestListener({ provider: failingOpenRouter });

    let resStatus = null;
    let resBody = '';

    await new Promise((resolve) => {
      const req = {
        method: 'POST',
        url: '/api/ai',
        headers: { host: '127.0.0.1:8080' },
        on(event, handler) {
          if (event === 'data') handler(JSON.stringify({ input: 'test' }));
          if (event === 'end') setTimeout(() => handler(), 0);
        }
      };

      const res = {
        writeHead(status) { resStatus = status; },
        end(body) {
          resBody = body;
          resolve();
        }
      };

      listener(req, res);
    });

    assert.equal(cheaperCalled, false, 'Cheaper provider must NEVER be called as a fallback');
    assert.equal(resStatus, 500);
    const parsed = JSON.parse(resBody);
    assert.equal(parsed.success, false);
    assert.ok(parsed.error.includes('Provider HTTP 503'));
  });

  test('ConversationSession transactional rollback on AI failure remains intact', async () => {
    const session = new ConversationSession();

    const failingOpenRouter = new OpenRouterTextProvider({
      ...validConfig,
      fetchFn: async () => ({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        json: async () => ({ error: { message: 'Provider failed' } })
      })
    });

    const listener = createRequestListener({ provider: failingOpenRouter, session });

    await new Promise((resolve) => {
      const req = {
        method: 'POST',
        url: '/api/ai',
        headers: { host: '127.0.0.1:8080' },
        on(event, handler) {
          if (event === 'data') handler(JSON.stringify({ input: 'Failed turn' }));
          if (event === 'end') setTimeout(() => handler(), 0);
        }
      };

      const res = {
        writeHead() {},
        end() {
          resolve();
        }
      };

      listener(req, res);
    });

    // Turn should be rolled back cleanly
    assert.equal(session.getMessages().length, 0);
  });

  // Requirement 51: CheaperInferenceProvider still exists for diagnostics
  test('CheaperInferenceProvider still exists and can be instantiated for diagnostics', () => {
    const cheaper = new CheaperInferenceProvider({
      apiKey: 'test-ci-key',
      model: 'deepseek-v4-flash-0731'
    });
    assert.ok(cheaper instanceof AIProvider);
    assert.equal(cheaper.name, 'cheaper-inference');
    assert.equal(cheaper.model, 'deepseek-v4-flash-0731');
  });
});
