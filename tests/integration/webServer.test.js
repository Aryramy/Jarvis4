import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../src/web/server.js';
import { CheaperInferenceProvider } from '../../src/providers/cheaperInference.js';

describe('Web Server - Brick 2 & Brick 4', () => {
  const AI_ENV_VARS = [
    'CHEAPER_INFERENCE_API_KEY',
    'CHEAPER_INFERENCE_BASE_URL',
    'CHEAPER_INFERENCE_MODEL',
    'CHEAPER_INFERENCE_TIMEOUT_MS'
  ];

  let originalEnv = {};
  let server;
  let baseUrl;

  before(async () => {
    // Environment isolation: save and isolate ambient AI variables during test run
    originalEnv = {};
    for (const key of AI_ENV_VARS) {
      if (key in process.env) {
        originalEnv[key] = process.env[key];
        delete process.env[key];
      }
    }

    // Start on ephemeral port 0 to prevent port collisions
    server = await startServer(0, '127.0.0.1');
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after((done) => {
    // Restore ambient environment state
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

  test('server starts successfully and binds to local host', () => {
    assert.ok(server);
    const addr = server.address();
    assert.equal(addr.address, '127.0.0.1');
    assert.ok(addr.port > 0);
  });

  test('GET / serves the minimal web page HTML', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);

    const body = await res.text();
    assert.match(body, /JARVIS4/);
    assert.match(body, /id="text-input"/);
    assert.match(body, /id="send-btn"/);
    assert.match(body, /id="ask-ai-btn"/);
    assert.match(body, /id="ask-ai-stream-btn"/);
    assert.match(body, /id="response-area"/);
    assert.match(body, /id="status-indicator"/);
  });

  test('POST /api/text accepts valid text and returns deterministic response from text core', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello Jarvis' })
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);

    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.input, 'Hello Jarvis');
    assert.equal(data.response, 'JARVIS received: Hello Jarvis');
  });

  test('POST /api/text normalizes surrounding whitespace via text core', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '   Hello Jarvis   ' })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.input, 'Hello Jarvis');
    assert.equal(data.response, 'JARVIS received: Hello Jarvis');
  });

  test('POST /api/text handles empty input safely with controlled error', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Input cannot be empty');
  });

  test('POST /api/text handles whitespace-only input safely', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '     ' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Input cannot be empty');
  });

  test('POST /api/text handles non-string input safely', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 12345 })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Input must be a string');
  });

  test('POST /api/text handles invalid JSON body without crashing server', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid-non-json-string'
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Invalid JSON body');
  });

  test('GET /api/text rejects wrong method with 405 Method Not Allowed', async () => {
    const res = await fetch(`${baseUrl}/api/text`, {
      method: 'GET'
    });

    assert.equal(res.status, 405);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Method Not Allowed');
  });

  test('GET /nonexistent returns 404 Not Found', async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.error, 'Not Found');
  });

  // =========================================================================
  // Brick 4 — Real AI Endpoint (/api/ai) Tests
  // =========================================================================

  test('POST /api/ai accepts valid text, invokes provider abstraction, and returns response', async () => {
    let capturedPrompt = null;
    const mockProvider = {
      apiKey: 'test-secret-key-12345',
      validateConfig() { return { valid: true }; },
      async generate(prompt) {
        capturedPrompt = prompt;
        return {
          success: true,
          text: 'Power BI is a business analytics service.'
        };
      }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Explain Power BI in one sentence.' })
      });

      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /application\/json/);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.response, 'Power BI is a business analytics service.');
      assert.equal(capturedPrompt, 'Explain Power BI in one sentence.');
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai normalizes surrounding whitespace before sending to provider', async () => {
    let capturedPrompt = null;
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async generate(prompt) {
        capturedPrompt = prompt;
        return {
          success: true,
          text: 'Response to trimmed prompt'
        };
      }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '   Hello AI   ' })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.response, 'Response to trimmed prompt');
      assert.equal(capturedPrompt, 'Hello AI');
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai rejects empty and whitespace-only input safely', async () => {
    let providerCalled = false;
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async generate() { providerCalled = true; return { success: true, text: 'ok' }; }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const resEmpty = await fetch(`${aiBaseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '' })
      });
      assert.equal(resEmpty.status, 400);
      const dataEmpty = await resEmpty.json();
      assert.equal(dataEmpty.success, false);
      assert.equal(dataEmpty.error, 'Input cannot be empty');

      const resWhitespace = await fetch(`${aiBaseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '   \n\t  ' })
      });
      assert.equal(resWhitespace.status, 400);
      const dataWhitespace = await resWhitespace.json();
      assert.equal(dataWhitespace.success, false);
      assert.equal(dataWhitespace.error, 'Input cannot be empty');

      assert.equal(providerCalled, false);
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai rejects non-string input safely', async () => {
    let providerCalled = false;
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async generate() { providerCalled = true; return { success: true, text: 'ok' }; }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const invalidInputs = [12345, true, null, {}, []];
      for (const input of invalidInputs) {
        const res = await fetch(`${aiBaseUrl}/api/ai`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input })
        });
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.error, 'Input must be a string');
      }

      const resMissing = await fetch(`${aiBaseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(resMissing.status, 400);
      const dataMissing = await resMissing.json();
      assert.equal(dataMissing.success, false);
      assert.equal(dataMissing.error, 'Input must be a string');

      assert.equal(providerCalled, false);
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai handles invalid JSON body safely without crashing', async () => {
    const aiServer = await startServer(0, '127.0.0.1');
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'non-json-data-string{'
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Invalid JSON body');
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('GET /api/ai rejects wrong method with 405 Method Not Allowed', async () => {
    const aiServer = await startServer(0, '127.0.0.1');
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai`, {
        method: 'GET'
      });

      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Method Not Allowed');
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai handles provider error as controlled API error without crashing', async () => {
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async generate() {
        return {
          success: false,
          error: 'Provider HTTP 500: Internal Server Error'
        };
      }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Hello' })
      });

      assert.equal(res.status, 500);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Provider HTTP 500: Internal Server Error');
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai handles provider timeout as controlled API error', async () => {
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async generate() {
        return {
          success: false,
          error: 'Request timed out after 30000ms'
        };
      }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Hello' })
      });

      assert.equal(res.status, 500);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Request timed out/);
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai redacts API key from error responses', async () => {
    const secretKey = 'super-secret-api-key-9999';
    const mockProvider = {
      apiKey: secretKey,
      validateConfig() { return { valid: true }; },
      async generate() {
        return {
          success: false,
          error: `Provider HTTP 401: Unauthorized request with key ${secretKey}`
        };
      }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Hello' })
      });

      assert.equal(res.status, 500);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /\[REDACTED\]/);
      assert.equal(data.error.includes(secretKey), false);
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai integrates with real CheaperInferenceProvider via mock fetchFn', async () => {
    const mockFetch = async (url, options) => {
      const parsed = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'deepseek-v4-flash-0731',
          choices: [
            {
              message: {
                role: 'assistant',
                content: `AI response to: ${parsed.messages[0].content}`
              }
            }
          ]
        })
      };
    };

    const realProvider = new CheaperInferenceProvider({
      apiKey: 'test-real-key',
      baseUrl: 'https://api.cheaperinference.com/v1',
      model: 'deepseek-v4-flash-0731',
      fetchFn: mockFetch
    });

    const aiServer = await startServer(0, '127.0.0.1', { provider: realProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Hello live AI' })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.response, 'AI response to: Hello live AI');
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai handles missing configuration safely with controlled error', async () => {
    const unconfiguredProvider = new CheaperInferenceProvider({
      apiKey: '',
      model: ''
    });

    const aiServer = await startServer(0, '127.0.0.1', { provider: unconfiguredProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Hello' })
      });

      assert.equal(res.status, 500);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Configuration error/);
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  // =========================================================================
  // Brick 5 — Streaming AI Endpoint (/api/ai/stream) Tests
  // =========================================================================

  test('POST /api/ai/stream accepts valid text, streams NDJSON deltas progressively, and terminates with done event', async () => {
    let capturedPrompt = null;
    const mockProvider = {
      apiKey: 'test-secret-key-12345',
      validateConfig() { return { valid: true }; },
      async *stream(prompt) {
        capturedPrompt = prompt;
        yield 'Streaming ';
        yield 'AI ';
        yield 'response.';
      }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Stream this prompt' })
      });

      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /application\/x-ndjson/);

      const rawBody = await res.text();
      const lines = rawBody.trim().split('\n').map(l => JSON.parse(l));

      assert.deepEqual(lines, [
        { type: 'delta', text: 'Streaming ' },
        { type: 'delta', text: 'AI ' },
        { type: 'delta', text: 'response.' },
        { type: 'done' }
      ]);
      assert.equal(capturedPrompt, 'Stream this prompt');
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai/stream delivers deltas progressively before stream completion', async () => {
    let releaseSecondDelta;
    const secondDeltaPromise = new Promise((resolve) => {
      releaseSecondDelta = resolve;
    });

    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async *stream() {
        yield 'First delta ';
        await secondDeltaPromise;
        yield 'Second delta';
      }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Test streaming progression' })
      });

      assert.equal(res.status, 200);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      // Read first chunk from network — must arrive before second delta is yielded
      const firstRead = await reader.read();
      assert.equal(firstRead.done, false);
      const firstText = decoder.decode(firstRead.value);
      const firstLines = firstText.trim().split('\n').map(l => JSON.parse(l));
      assert.equal(firstLines.length, 1);
      assert.equal(firstLines[0].type, 'delta');
      assert.equal(firstLines[0].text, 'First delta ');

      // Now release second delta
      releaseSecondDelta();

      // Read remainder of stream
      let remainingText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        remainingText += decoder.decode(value);
      }

      const remainingLines = remainingText.trim().split('\n').map(l => JSON.parse(l));
      assert.deepEqual(remainingLines, [
        { type: 'delta', text: 'Second delta' },
        { type: 'done' }
      ]);
    } finally {
      releaseSecondDelta();
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai/stream normalizes surrounding whitespace before streaming', async () => {
    let capturedPrompt = null;
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async *stream(prompt) {
        capturedPrompt = prompt;
        yield 'OK';
      }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '   Trimmed prompt   ' })
      });

      assert.equal(res.status, 200);
      const rawBody = await res.text();
      assert.equal(capturedPrompt, 'Trimmed prompt');
      assert.match(rawBody, /"type":"delta"/);
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai/stream rejects empty and whitespace-only input safely', async () => {
    let streamCalled = false;
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async *stream() { streamCalled = true; yield 'ok'; }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      // Empty string
      const resEmpty = await fetch(`${aiBaseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '' })
      });
      assert.equal(resEmpty.status, 400);
      const dataEmpty = await resEmpty.json();
      assert.equal(dataEmpty.success, false);
      assert.equal(dataEmpty.error, 'Input cannot be empty');

      // Whitespace-only string
      const resWhitespace = await fetch(`${aiBaseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '   \n\t  ' })
      });
      assert.equal(resWhitespace.status, 400);
      const dataWhitespace = await resWhitespace.json();
      assert.equal(dataWhitespace.success, false);
      assert.equal(dataWhitespace.error, 'Input cannot be empty');

      assert.equal(streamCalled, false);
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai/stream rejects non-string input safely', async () => {
    let streamCalled = false;
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async *stream() { streamCalled = true; yield 'ok'; }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const invalidInputs = [12345, true, null, {}, []];
      for (const input of invalidInputs) {
        const res = await fetch(`${aiBaseUrl}/api/ai/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input })
        });
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.error, 'Input must be a string');
      }

      assert.equal(streamCalled, false);
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai/stream handles invalid JSON body safely without crashing', async () => {
    const aiServer = await startServer(0, '127.0.0.1');
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json-text{'
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Invalid JSON body');
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('GET /api/ai/stream rejects wrong method with 405 Method Not Allowed', async () => {
    const aiServer = await startServer(0, '127.0.0.1');
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai/stream`, {
        method: 'GET'
      });

      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Method Not Allowed');
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai/stream handles provider stream error as controlled error event', async () => {
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async *stream() {
        yield 'Start delta';
        throw new Error('Provider stream disrupted mid-flight');
      }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Test error' })
      });

      assert.equal(res.status, 200);
      const rawBody = await res.text();
      const lines = rawBody.trim().split('\n').map(l => JSON.parse(l));

      assert.deepEqual(lines, [
        { type: 'delta', text: 'Start delta' },
        { type: 'error', message: 'Provider stream disrupted mid-flight' }
      ]);
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai/stream redacts API key from error events', async () => {
    const secretKey = 'stream-secret-key-8888';
    const mockProvider = {
      apiKey: secretKey,
      validateConfig() { return { valid: true }; },
      async *stream() {
        throw new Error(`Provider HTTP 403: Forbidden for key ${secretKey}`);
      }
    };

    const aiServer = await startServer(0, '127.0.0.1', { provider: mockProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Test secret redaction' })
      });

      assert.equal(res.status, 200);
      const rawBody = await res.text();
      const lines = rawBody.trim().split('\n').map(l => JSON.parse(l));

      assert.equal(lines.length, 1);
      assert.equal(lines[0].type, 'error');
      assert.match(lines[0].message, /\[REDACTED\]/);
      assert.equal(lines[0].message.includes(secretKey), false);
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });

  test('POST /api/ai/stream handles missing configuration safely with controlled error', async () => {
    const unconfiguredProvider = new CheaperInferenceProvider({
      apiKey: '',
      model: ''
    });

    const aiServer = await startServer(0, '127.0.0.1', { provider: unconfiguredProvider });
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      const res = await fetch(`${aiBaseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Hello' })
      });

      assert.equal(res.status, 500);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Configuration error/);
    } finally {
      await new Promise(r => aiServer.close(r));
    }
  });
});

