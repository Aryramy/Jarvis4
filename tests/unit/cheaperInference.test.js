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

  // =========================================================================
  // Brick 5 — Streaming Tests
  // =========================================================================

  test('provider.stream accepts valid prompt and yields text deltas in order', async () => {
    let capturedUrl = null;
    let capturedOptions = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield 'data: {"id":"1","choices":[{"delta":{"content":"Power"}}]}\n\n';
          yield 'data: {"id":"2","choices":[{"delta":{"content":" BI"}}]}\n\n';
          yield 'data: {"id":"3","choices":[{"delta":{"content":" is useful."}}]}\n\n';
          yield 'data: [DONE]\n\n';
        })()
      };
    };

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const deltas = [];
    for await (const delta of provider.stream('Explain Power BI')) {
      deltas.push(delta);
    }

    assert.deepEqual(deltas, ['Power', ' BI', ' is useful.']);
    assert.equal(capturedUrl, 'https://api.cheaperinference.com/v1/chat/completions');
    assert.equal(capturedOptions.method, 'POST');
    const parsedBody = JSON.parse(capturedOptions.body);
    assert.equal(parsedBody.stream, true);
    assert.equal(parsedBody.model, 'mock-hosted-model-v1');
    assert.deepEqual(parsedBody.messages, [{ role: 'user', content: 'Explain Power BI' }]);
  });

  test('empty prompt rejected cleanly without network call in stream', async () => {
    let called = false;
    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: async () => { called = true; }
    });

    await assert.rejects(
      async () => {
        for await (const _ of provider.stream('')) {}
      },
      { message: 'Prompt cannot be empty' }
    );

    await assert.rejects(
      async () => {
        for await (const _ of provider.stream('   \n\t  ')) {}
      },
      { message: 'Prompt cannot be empty' }
    );

    assert.equal(called, false);
  });

  test('non-string prompt rejected cleanly without network call in stream', async () => {
    let called = false;
    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: async () => { called = true; }
    });

    const invalidInputs = [null, undefined, 123, true, {}, []];
    for (const input of invalidInputs) {
      await assert.rejects(
        async () => {
          for await (const _ of provider.stream(input)) {}
        },
        { message: 'Prompt must be a string' }
      );
    }

    assert.equal(called, false);
  });

  test('stream handles malformed events and comments safely without crashing', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield ': keep-alive\n\n';
        yield 'data: not-valid-json\n\n';
        yield 'data: {"choices":[{"delta":{"content":"Valid"}}]}\n\n';
        yield 'data: {"choices":[]}\n\n';
        yield 'data: {"choices":[{"delta":{}}]}\n\n';
        yield 'data: {"choices":[{"delta":{"content":" text"}}]}\n\n';
        yield 'data: [DONE]\n\n';
      })()
    });

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const deltas = [];
    for await (const delta of provider.stream('Hello')) {
      deltas.push(delta);
    }

    assert.deepEqual(deltas, ['Valid', ' text']);
  });

  test('stream handles provider HTTP error cleanly with redacted secrets', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({
        error: { message: `Unauthorized for key ${validConfig.apiKey}` }
      })
    });

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    await assert.rejects(
      async () => {
        for await (const _ of provider.stream('Hello')) {}
      },
      (err) => {
        assert.match(err.message, /Provider HTTP 401: Unauthorized for key \[REDACTED\]/);
        assert.equal(err.message.includes(validConfig.apiKey), false);
        return true;
      }
    );
  });

  test('stream handles network failure cleanly', async () => {
    const mockFetch = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:443');
    };

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    await assert.rejects(
      async () => {
        for await (const _ of provider.stream('Hello')) {}
      },
      { message: 'Network error: connect ECONNREFUSED 127.0.0.1:443' }
    );
  });

  test('stream handles timeout cleanly using AbortController', async () => {
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
      timeoutMs: 20,
      fetchFn: mockFetch
    });

    await assert.rejects(
      async () => {
        for await (const _ of provider.stream('Hello')) {}
      },
      /Request timed out after 20ms/
    );
  });

  test('stream cleans up and aborts request if caller breaks early', async () => {
    let aborted = false;

    const mockFetch = async (url, options) => {
      options.signal.addEventListener('abort', () => {
        aborted = true;
      });
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield 'data: {"choices":[{"delta":{"content":"Delta 1"}}]}\n\n';
          yield 'data: {"choices":[{"delta":{"content":"Delta 2"}}]}\n\n';
          yield 'data: {"choices":[{"delta":{"content":"Delta 3"}}]}\n\n';
        })()
      };
    };

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const collected = [];
    for await (const delta of provider.stream('Hello')) {
      collected.push(delta);
      break;
    }

    assert.equal(collected.length, 1);
    assert.equal(collected[0], 'Delta 1');
    assert.equal(aborted, true);
  });

  // =========================================================================
  // Brick 6 — Message-based request support (generateMessages)
  // =========================================================================

  test('generateMessages preserves role and content order in provider request', async () => {
    let capturedOptions = null;

    const mockFetch = async (url, options) => {
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Your name is Ary.'
              }
            }
          ]
        })
      };
    };

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const messages = [
      { role: 'user', content: 'My name is Ary.' },
      { role: 'assistant', content: 'Nice to meet you, Ary.' },
      { role: 'user', content: 'What is my name?' }
    ];

    const result = await provider.generateMessages(messages);

    assert.equal(result.success, true);
    assert.equal(result.text, 'Your name is Ary.');

    const parsedBody = JSON.parse(capturedOptions.body);
    assert.deepEqual(parsedBody.messages, [
      { role: 'user', content: 'My name is Ary.' },
      { role: 'assistant', content: 'Nice to meet you, Ary.' },
      { role: 'user', content: 'What is my name?' }
    ]);
  });

  test('generateMessages rejects non-array or empty messages without network call', async () => {
    let called = false;
    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: async () => { called = true; }
    });

    const invalidInputs = [null, undefined, 'string', 123, {}, []];
    for (const input of invalidInputs) {
      const result = await provider.generateMessages(input);
      assert.equal(result.success, false);
      assert.match(result.error, /Messages must be a non-empty array/);
    }

    assert.equal(called, false);
  });

  test('generateMessages rejects malformed message items without network call', async () => {
    let called = false;
    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: async () => { called = true; }
    });

    const testCases = [
      [{ role: 'user' }], // missing content
      [{ content: 'hello' }], // missing role
      [{ role: 123, content: 'hello' }], // non-string role
      [{ role: 'user', content: 123 }], // non-string content
      [{ role: 'user', content: '' }], // empty content
      [{ role: 'user', content: '   ' }] // whitespace-only content
    ];

    for (const messages of testCases) {
      const result = await provider.generateMessages(messages);
      assert.equal(result.success, false);
    }

    assert.equal(called, false);
  });

  // =========================================================================
  // Brick 7 — Message-based streaming support (streamMessages)
  // =========================================================================

  test('streamMessages accepts ordered conversation messages, preserves role/content order, and yields deltas progressively', async () => {
    let capturedOptions = null;

    const mockFetch = async (url, options) => {
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield 'data: {"choices":[{"delta":{"content":"Your "}}]}\n\n';
          yield 'data: {"choices":[{"delta":{"content":"code "}}]}\n\n';
          yield 'data: {"choices":[{"delta":{"content":"is ORANGE-741"}}]}\n\n';
          yield 'data: [DONE]\n\n';
        })()
      };
    };

    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: mockFetch
    });

    const messages = [
      { role: 'user', content: 'My code is ORANGE-741' },
      { role: 'assistant', content: 'Got it.' },
      { role: 'user', content: 'What is my code?' }
    ];

    const deltas = [];
    for await (const delta of provider.streamMessages(messages)) {
      deltas.push(delta);
    }

    assert.deepEqual(deltas, ['Your ', 'code ', 'is ORANGE-741']);

    const parsedBody = JSON.parse(capturedOptions.body);
    assert.equal(parsedBody.stream, true);
    assert.deepEqual(parsedBody.messages, [
      { role: 'user', content: 'My code is ORANGE-741' },
      { role: 'assistant', content: 'Got it.' },
      { role: 'user', content: 'What is my code?' }
    ]);
  });

  test('streamMessages rejects non-array or empty messages without network call', async () => {
    let called = false;
    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: async () => { called = true; }
    });

    const invalidInputs = [null, undefined, 'string', 123, {}, []];
    for (const input of invalidInputs) {
      await assert.rejects(
        async () => {
          for await (const _ of provider.streamMessages(input)) {}
        },
        /Messages must be a non-empty array/
      );
    }

    assert.equal(called, false);
  });

  test('streamMessages rejects malformed message items without network call', async () => {
    let called = false;
    const provider = new CheaperInferenceProvider({
      ...validConfig,
      fetchFn: async () => { called = true; }
    });

    const testCases = [
      [{ role: 'user' }], // missing content
      [{ content: 'hello' }], // missing role
      [{ role: 123, content: 'hello' }], // non-string role
      [{ role: 'user', content: 123 }], // non-string content
      [{ role: 'user', content: '' }], // empty content
      [{ role: 'user', content: '   ' }] // whitespace-only content
    ];

    for (const messages of testCases) {
      await assert.rejects(
        async () => {
          for await (const _ of provider.streamMessages(messages)) {}
        }
      );
    }

    assert.equal(called, false);
  });
});
