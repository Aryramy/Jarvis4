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

test('Web Page Q&A Endpoint /api/page-qa - Integration Tests (Brick 22 Sections 35-38)', async (t) => {
  await t.test('rejects non-POST methods with 405 Method Not Allowed', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const getRes = await fetch(`${url}/api/page-qa`, { method: 'GET' });
      assert.equal(getRes.status, 405);
      const getData = await getRes.json();
      assert.equal(getData.success, false);
      assert.equal(getData.error, 'Method Not Allowed');

      const putRes = await fetch(`${url}/api/page-qa`, { method: 'PUT' });
      assert.equal(putRes.status, 405);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('rejects invalid JSON with 400 Bad Request', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/page-qa`, {
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

  await t.test('rejects missing or empty URL and question with 400 Bad Request', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const noUrlRes = await fetch(`${url}/api/page-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'What is this?' })
      });
      assert.equal(noUrlRes.status, 400);
      const noUrlData = await noUrlRes.json();
      assert.equal(noUrlData.code, 'INVALID_URL');

      const noQRes = await fetch(`${url}/api/page-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/' })
      });
      assert.equal(noQRes.status, 400);
      const noQData = await noQRes.json();
      assert.equal(noQData.code, 'INVALID_QUESTION');

      const emptyQRes = await fetch(`${url}/api/page-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/', question: '   ' })
      });
      assert.equal(emptyQRes.status, 400);
      const emptyQData = await emptyQRes.json();
      assert.equal(emptyQData.code, 'INVALID_QUESTION');
    } finally {
      await closeServer(server);
    }
  });

  // --- Section 35: Success Integration ---
  await t.test('33-46. Section 35: Successful grounded Q&A returns structured response & diagnostics', async () => {
    const mockPageReader = async (targetUrl) => ({
      success: true,
      requestedUrl: targetUrl,
      finalUrl: 'https://example.com/canonical',
      title: 'Example Documentation',
      httpStatus: 200,
      contentType: 'text/html',
      redirectCount: 0,
      rawBytes: 500,
      extractedCharacters: 120,
      truncated: false,
      fetchDurationMs: 40.5,
      extractionDurationMs: 5.2,
      serverReadDurationMs: 46.1,
      text: 'This domain is for use in illustrative examples in documents.'
    });

    const mockAiProvider = {
      model: 'deepseek/deepseek-v4-flash-0731',
      generateMessages: async (messages, opts) => {
        assert.ok(Array.isArray(messages));
        assert.equal(messages.length, 2);
        assert.equal(messages[0].role, 'system');
        assert.equal(messages[1].role, 'user');
        assert.ok(messages[1].content.includes('<WEBPAGE_CONTENT>'));
        assert.ok(messages[1].content.includes('<USER_QUESTION>'));
        assert.equal(opts.maxTokens, 1000);
        return {
          success: true,
          text: 'This domain is intended for illustrative examples in documents.',
          model: 'deepseek/deepseek-v4-flash-0731',
          provider: 'openrouter',
          providerDurationMs: 185
        };
      }
    };

    const server = createServer({
      pageReaderFn: mockPageReader,
      provider: mockAiProvider
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/page-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com/',
          question: 'What is this domain used for?'
        })
      });

      assert.equal(res.status, 200);
      const data = await res.json();

      // 33. POST /api/page-qa returns success true
      assert.equal(data.success, true);
      // 34. answer returned
      assert.equal(data.answer, 'This domain is intended for illustrative examples in documents.');
      // 35. grounded true returned
      assert.equal(data.grounded, true);
      // 36. groundingSourceCount = 1
      assert.equal(data.groundingSourceCount, 1);
      // 37. source object returned
      assert.ok(data.source && typeof data.source === 'object');
      // 38. requestedUrl preserved
      assert.equal(data.requestedUrl, 'https://example.com/');
      assert.equal(data.source.requestedUrl, 'https://example.com/');
      // 39. finalUrl preserved
      assert.equal(data.finalUrl, 'https://example.com/canonical');
      assert.equal(data.source.finalUrl, 'https://example.com/canonical');
      // 40. title preserved
      assert.equal(data.title, 'Example Documentation');
      assert.equal(data.source.title, 'Example Documentation');
      // 41. pageTruncated preserved
      assert.equal(data.pageTruncated, false);
      assert.equal(data.source.truncated, false);
      // 42. provider preserved
      assert.equal(data.provider, 'openrouter');
      // 43. model preserved
      assert.equal(data.model, 'deepseek/deepseek-v4-flash-0731');
      // 44. pageReadDurationMs returned
      assert.equal(typeof data.pageReadDurationMs, 'number');
      assert.ok(data.pageReadDurationMs >= 0);
      // 45. providerQaDurationMs returned
      assert.equal(data.providerQaDurationMs, 185);
      // 46. serverPageQaDurationMs returned
      assert.equal(typeof data.serverPageQaDurationMs, 'number');
      assert.ok(data.serverPageQaDurationMs >= 0);
    } finally {
      await closeServer(server);
    }
  });

  // --- Section 36: Failures Integration ---
  await t.test('47-51. Section 36: Page reader failures stop pipeline without AI invocation', async () => {
    let aiCallCount = 0;
    const trackingAiProvider = {
      model: 'deepseek/deepseek-v4-flash-0731',
      generateMessages: async () => {
        aiCallCount++;
        return { success: true, text: 'Should not be called' };
      }
    };

    const failingCases = [
      {
        err: new PageReaderError('LOCAL_OR_PRIVATE_HOST_BLOCKED', 'Access to private IP blocked'),
        expectedStatus: 400,
        expectedCode: 'LOCAL_OR_PRIVATE_HOST_BLOCKED'
      },
      {
        err: new PageReaderError('UNSUPPORTED_CONTENT_TYPE', 'Only HTML supported'),
        expectedStatus: 422,
        expectedCode: 'UNSUPPORTED_CONTENT_TYPE'
      },
      {
        err: new PageReaderError('FETCH_TIMEOUT', 'Timed out'),
        expectedStatus: 504,
        expectedCode: 'FETCH_TIMEOUT'
      },
      {
        err: new PageReaderError('NO_READABLE_CONTENT', 'No readable text content'),
        expectedStatus: 422,
        expectedCode: 'NO_READABLE_CONTENT'
      }
    ];

    for (const testCase of failingCases) {
      const server = createServer({
        pageReaderFn: async () => { throw testCase.err; },
        provider: trackingAiProvider
      });
      const { url } = await listenOnEphemeralPort(server);

      try {
        const res = await fetch(`${url}/api/page-qa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://test.local/', question: 'What is this?' })
        });
        assert.equal(res.status, testCase.expectedStatus);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.code, testCase.expectedCode);
      } finally {
        await closeServer(server);
      }
    }

    // 47. page-reader failure prevents AI call
    assert.equal(aiCallCount, 0);
  });

  await t.test('52-54. Section 36: AI provider failure returns controlled error, does not call search or mutate conversation', async () => {
    const mockPageReader = async () => ({
      success: true,
      requestedUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      title: 'Valid Page',
      text: 'Valid content',
      truncated: false
    });

    let searchCalled = false;
    const mockSearchProvider = {
      search: async () => {
        searchCalled = true;
        return { success: true, answer: 'Searched answer' };
      }
    };

    const failingAiProvider = {
      model: 'deepseek/deepseek-v4-flash-0731',
      generateMessages: async () => ({
        success: false,
        error: 'OpenRouter service unavailable (503)'
      })
    };

    let sessionMutated = false;
    const mockSession = {
      addUserMessage: () => { sessionMutated = true; },
      addAssistantMessage: () => { sessionMutated = true; }
    };

    let storeMutated = false;
    const mockStore = {
      save: () => { storeMutated = true; }
    };

    const server = createServer({
      pageReaderFn: mockPageReader,
      provider: failingAiProvider,
      searchProvider: mockSearchProvider,
      session: mockSession,
      store: mockStore
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/page-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/', question: 'What is this?' })
      });

      assert.equal(res.status, 502);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'PROVIDER_ERROR');
      assert.match(data.message, /OpenRouter service unavailable/);

      // 53. does not call search
      assert.equal(searchCalled, false);
      // 54. does not mutate conversation
      assert.equal(sessionMutated, false);
      assert.equal(storeMutated, false);
    } finally {
      await closeServer(server);
    }
  });

  // --- Section 37: Statelessness Tests ---
  await t.test('55-59. Section 37: Statelessness - conversation session & store strictly untouched', async () => {
    let sessionAddUserCalled = false;
    let sessionAddAssistantCalled = false;
    let storeSaveCalled = false;

    const mockSession = {
      addUserMessage: () => { sessionAddUserCalled = true; },
      addAssistantMessage: () => { sessionAddAssistantCalled = true; }
    };

    const mockStore = {
      save: () => { storeSaveCalled = true; }
    };

    const mockPageReader = async () => ({
      success: true,
      requestedUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      title: 'Valid Page',
      text: 'Extracted secret page body that must never be persisted.',
      truncated: false
    });

    const mockAiProvider = {
      model: 'deepseek/deepseek-v4-flash-0731',
      generateMessages: async () => ({
        success: true,
        text: 'Grounded answer that must not enter conversation history.'
      })
    };

    const server = createServer({
      pageReaderFn: mockPageReader,
      provider: mockAiProvider,
      session: mockSession,
      store: mockStore
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/page-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/', question: 'What is the secret?' })
      });

      assert.equal(res.status, 200);
      assert.equal(sessionAddUserCalled, false);
      assert.equal(sessionAddAssistantCalled, false);
      assert.equal(storeSaveCalled, false);
    } finally {
      await closeServer(server);
    }
  });

  // --- Section 38: Regression Tests ---
  await t.test('60-75. Section 38: Regressions - other endpoints & UI intact', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      // 67. Read Page UI elements present
      const homeRes = await fetch(`${url}/`);
      assert.equal(homeRes.status, 200);
      const html = await homeRes.text();

      assert.ok(html.includes('id="read-page-btn"'), 'Read Page button preserved');
      assert.ok(html.includes('id="page-qa-btn"'), 'Web Page Q&A button present');
      assert.ok(html.includes('id="page-qa-url-input"'), 'Web Page Q&A URL input present');
      assert.ok(html.includes('id="page-qa-question-input"'), 'Web Page Q&A Question input present');

      // 63. /api/read-page rejects GET
      const readPageRes = await fetch(`${url}/api/read-page`, { method: 'GET' });
      assert.equal(readPageRes.status, 405);

      // 60. /api/auto rejects GET
      const autoRes = await fetch(`${url}/api/auto`, { method: 'GET' });
      assert.equal(autoRes.status, 405);

      // 61. /api/ai rejects GET
      const aiRes = await fetch(`${url}/api/ai`, { method: 'GET' });
      assert.equal(aiRes.status, 405);

      // 62. /api/search rejects GET
      const searchRes = await fetch(`${url}/api/search`, { method: 'GET' });
      assert.equal(searchRes.status, 405);

      // 73. Brick-21 SSRF protection on /api/read-page directly blocks loopback
      const ssrfRes = await fetch(`${url}/api/read-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1/' })
      });
      assert.equal(ssrfRes.status, 400);
      const ssrfData = await ssrfRes.json();
      assert.equal(ssrfData.code, 'LOCAL_OR_PRIVATE_HOST_BLOCKED');

      // SSRF protection on /api/page-qa also directly blocks loopback
      const ssrfQaRes = await fetch(`${url}/api/page-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1/', question: 'What is this?' })
      });
      assert.equal(ssrfQaRes.status, 400);
      const ssrfQaData = await ssrfQaRes.json();
      assert.equal(ssrfQaData.code, 'LOCAL_OR_PRIVATE_HOST_BLOCKED');
    } finally {
      await closeServer(server);
    }
  });
});
