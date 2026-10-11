import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/web/server.js';
import { PageReaderError } from '../../src/webpage/urlSafety.js';

function listenOnEphemeralPort(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null) {
        resolvePromise({
          port: address.port,
          url: `http://127.0.0.1:${address.port}`
        });
      } else {
        rejectPromise(new Error('Failed to resolve ephemeral port'));
      }
    });
    server.on('error', rejectPromise);
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
  });
}

test('Web Page Read Endpoint /api/read-page - Integration Tests (Brick 21 Section 41 & 42)', async (t) => {
  await t.test('rejects non-POST methods with 405 Method Not Allowed', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const getRes = await fetch(`${url}/api/read-page`, { method: 'GET' });
      assert.equal(getRes.status, 405);
      const getData = await getRes.json();
      assert.equal(getData.success, false);
      assert.equal(getData.error, 'Method Not Allowed');

      const putRes = await fetch(`${url}/api/read-page`, { method: 'PUT' });
      assert.equal(putRes.status, 405);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('rejects invalid JSON with 400 Bad Request', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/read-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json{{'
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Invalid JSON body');
    } finally {
      await closeServer(server);
    }
  });

  await t.test('68. missing URL rejected with 400 Bad Request', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/read-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'INVALID_URL');
      assert.equal(data.error, 'INVALID_URL');
    } finally {
      await closeServer(server);
    }
  });

  await t.test('69. empty URL rejected with 400 Bad Request', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/read-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: '   ' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'INVALID_URL');
      assert.equal(data.error, 'INVALID_URL');
    } finally {
      await closeServer(server);
    }
  });

  await t.test('70. non-string URL rejected with 400 Bad Request', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/read-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 12345 })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'INVALID_URL');
      assert.equal(data.error, 'INVALID_URL');
    } finally {
      await closeServer(server);
    }
  });

  await t.test('54-67. valid request returns success true and all required metadata fields', async () => {
    const mockPageReaderFn = async (requestedUrl) => {
      return {
        success: true,
        requestedUrl,
        finalUrl: requestedUrl + '/final',
        title: 'Mock Page Title',
        contentType: 'text/html',
        httpStatus: 200,
        redirectCount: 1,
        rawBytes: 1234,
        extractedCharacters: 567,
        truncated: false,
        fetchDurationMs: 45.67,
        extractionDurationMs: 12.34,
        serverReadDurationMs: 60.12,
        text: 'This is mock extracted textual content from the webpage.'
      };
    };

    const server = createServer({ pageReaderFn: mockPageReaderFn });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/read-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/test-article' })
      });

      assert.equal(res.status, 200);
      const data = await res.json();

      // 54. success true
      assert.equal(data.success, true);
      // 55. requestedUrl preserved
      assert.equal(data.requestedUrl, 'https://example.com/test-article');
      // 56. finalUrl preserved
      assert.equal(data.finalUrl, 'https://example.com/test-article/final');
      // 57. title returned
      assert.equal(data.title, 'Mock Page Title');
      // 58. text returned
      assert.equal(data.text, 'This is mock extracted textual content from the webpage.');
      // 59. httpStatus returned
      assert.equal(data.httpStatus, 200);
      // 60. contentType returned
      assert.equal(data.contentType, 'text/html');
      // 61. redirectCount returned
      assert.equal(data.redirectCount, 1);
      // 62. rawBytes returned
      assert.equal(data.rawBytes, 1234);
      // 63. extractedCharacters returned
      assert.equal(data.extractedCharacters, 567);
      // 64. truncated returned
      assert.equal(data.truncated, false);
      // 65. fetchDurationMs returned
      assert.equal(typeof data.fetchDurationMs, 'number');
      assert.ok(data.fetchDurationMs >= 0);
      // 66. extractionDurationMs returned
      assert.equal(typeof data.extractionDurationMs, 'number');
      assert.ok(data.extractionDurationMs >= 0);
      // 67. serverReadDurationMs returned
      assert.equal(typeof data.serverReadDurationMs, 'number');
      assert.ok(data.serverReadDurationMs >= 0);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('71-72. controlled page-reader error mapped safely without stack traces or path leakage', async () => {
    const errorCodesToTest = [
      { code: 'LOCAL_OR_PRIVATE_HOST_BLOCKED', status: 400 },
      { code: 'UNSUPPORTED_PROTOCOL', status: 400 },
      { code: 'PORT_NOT_ALLOWED', status: 400 },
      { code: 'PAGE_TOO_LARGE', status: 413 },
      { code: 'FETCH_TIMEOUT', status: 504 },
      { code: 'UNSUPPORTED_CONTENT_TYPE', status: 422 },
      { code: 'NO_READABLE_CONTENT', status: 422 },
      { code: 'HTTP_ERROR', status: 502 },
      { code: 'FETCH_FAILED', status: 502 }
    ];

    for (const { code, status } of errorCodesToTest) {
      const failingReaderFn = async (requestedUrl) => {
        throw new PageReaderError(code, `Test controlled error for ${code}`, {
          finalUrl: requestedUrl,
          httpStatus: 500
        });
      };

      const server = createServer({ pageReaderFn: failingReaderFn });
      const { url } = await listenOnEphemeralPort(server);

      try {
        const res = await fetch(`${url}/api/read-page`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/fail' })
        });

        assert.equal(res.status, status);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.code, code);
        assert.equal(data.error, code);
        assert.ok(data.message.includes(code));
        assert.equal(typeof data.serverReadDurationMs, 'number');

        // 72. Stack trace must NOT be exposed
        assert.equal(data.stack, undefined);
        assert.equal(typeof data.message, 'string');
        assert.doesNotMatch(data.message, /node_modules|src\\webpage|at async/);
      } finally {
        await closeServer(server);
      }
    }
  });

  await t.test('73-77. regression: /api/auto, /api/ai, /api/search, /api/ai/stream exist and remain functional', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      // POST without body to check input validation remains intact
      const autoRes = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(autoRes.status, 400);

      const aiRes = await fetch(`${url}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(aiRes.status, 400);

      const searchRes = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(searchRes.status, 400);

      const streamRes = await fetch(`${url}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(streamRes.status, 400);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('78-79. regression: ConversationSession and ConversationStore are NOT mutated by /api/read-page', async () => {
    const mockSession = {
      size: 0,
      addUserMessage: () => { throw new Error('Session must not be mutated by /api/read-page'); },
      addAssistantMessage: () => { throw new Error('Session must not be mutated by /api/read-page'); },
      getMessages: () => []
    };

    const mockStore = {
      save: () => { throw new Error('Store must not be mutated by /api/read-page'); },
      load: () => []
    };

    const mockPageReader = async (requestedUrl) => {
      return {
        success: true,
        requestedUrl,
        finalUrl: requestedUrl,
        title: 'Title',
        contentType: 'text/html',
        httpStatus: 200,
        redirectCount: 0,
        rawBytes: 100,
        extractedCharacters: 50,
        truncated: false,
        fetchDurationMs: 10,
        extractionDurationMs: 5,
        serverReadDurationMs: 15,
        text: 'Stateless text'
      };
    };

    const server = createServer({
      session: mockSession,
      store: mockStore,
      pageReaderFn: mockPageReader
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/read-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/stateless' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('83-84. regression: HTML interface includes Web Page Read section and preserves all existing UI sections', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/`);
      assert.equal(res.status, 200);
      const html = await res.text();

      // Check Brick 21 elements
      assert.ok(html.includes('id="page-read-section"'));
      assert.ok(html.includes('id="page-url-input"'));
      assert.ok(html.includes('id="read-page-btn"'));
      assert.ok(html.includes('id="page-read-status"'));
      assert.ok(html.includes('id="page-read-meta"'));
      assert.ok(html.includes('id="page-read-content"'));

      // Check preserved existing elements
      assert.ok(html.includes('id="ask-ai-btn"'));
      assert.ok(html.includes('id="search-web-btn"'));
      assert.ok(html.includes('id="ask-ai-stream-btn"'));
      assert.ok(html.includes('id="clear-conv-btn"'));
      assert.ok(html.includes('id="run-voice-turn-btn"'));
      assert.ok(html.includes('id="start-mic-btn"'));
      assert.ok(html.includes('id="stop-mic-btn"'));
      assert.ok(html.includes('id="transcribe-btn"'));
      assert.ok(html.includes('id="ask-jarvis-btn"'));
      assert.ok(html.includes('id="speak-response-btn"'));
    } finally {
      await closeServer(server);
    }
  });
});
