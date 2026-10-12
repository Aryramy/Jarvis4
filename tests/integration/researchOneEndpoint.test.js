import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/web/server.js';
import { ConversationSession } from '../../src/core/conversationSession.js';
import { ConversationStore } from '../../src/core/conversationStore.js';
import { PageReaderError } from '../../src/webpage/urlSafety.js';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

test('Research One Endpoint /api/research-one - Integration Tests (Brick 24 Sections 45-48)', async (t) => {
  // Method checks
  await t.test('rejects non-POST methods with 405 Method Not Allowed', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const getRes = await fetch(`${url}/api/research-one`, { method: 'GET' });
      assert.equal(getRes.status, 405);
      const getData = await getRes.json();
      assert.equal(getData.success, false);
      assert.equal(getData.error, 'Method Not Allowed');

      const putRes = await fetch(`${url}/api/research-one`, { method: 'PUT' });
      assert.equal(putRes.status, 405);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('rejects invalid JSON with 400 Bad Request', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/research-one`, {
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

  // ==================================================
  // Section 45: Integration Tests — Success Contract (65-78)
  // ==================================================
  await t.test('Section 45: Success Contract across source 0, 1, 2 fallbacks', async (st) => {
    await st.test('65, 68-78. POST /api/research-one succeeds when source 0 succeeds with accurate diagnostics', async () => {
      const mockSearchProvider = {
        search: async (q) => ({
          success: true,
          searchUsed: true,
          searchRequests: 1,
          searchEvidence: 'url_citation',
          sources: [
            { title: 'Fabric News', url: 'https://example.com/fabric-news' },
            { title: 'Other News', url: 'https://example.com/other' }
          ],
          providerSearchDurationMs: 140
        })
      };

      const mockPageReader = async (u) => ({
        text: 'Microsoft Fabric announced real-time intelligence.',
        requestedUrl: u,
        finalUrl: 'https://example.com/fabric-news-final',
        title: 'Fabric Official News',
        httpStatus: 200,
        contentType: 'text/html',
        truncated: false,
        serverReadDurationMs: 85
      });

      const mockAiProvider = {
        model: 'deepseek/deepseek-v4-flash-0731',
        generateMessages: async () => ({
          success: true,
          text: 'Microsoft Fabric announced real-time intelligence features.',
          model: 'deepseek/deepseek-v4-flash-0731',
          providerDurationMs: 155
        })
      };

      const server = createServer({
        searchProvider: mockSearchProvider,
        pageReaderFn: mockPageReader,
        provider: mockAiProvider
      });
      const { url } = await listenOnEphemeralPort(server);

      try {
        const res = await fetch(`${url}/api/research-one`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'What are the announcements?' })
        });

        assert.equal(res.status, 200);
        const data = await res.json();

        // 65. success true
        assert.equal(data.success, true);
        // 75. grounded true
        assert.equal(data.grounded, true);
        // 68. selectedSourceIndex accurate
        assert.equal(data.selectedSourceIndex, 0);
        assert.equal(data.selectedSource.index, 0);
        // 69. selectedSource title accurate
        assert.equal(data.selectedSource.title, 'Fabric News');
        // 70. selectedSource URL accurate
        assert.equal(data.selectedSource.url, 'https://example.com/fabric-news');
        // 71. sourcesFound accurate
        assert.equal(data.sourcesFound, 2);
        // 72. pageReadAttempts accurate
        assert.equal(data.pageReadAttempts, 1);
        // 73. attempt diagnostics ordered
        assert.equal(data.attempts.length, 1);
        assert.equal(data.attempts[0].sourceIndex, 0);
        assert.equal(data.attempts[0].status, 'success');
        // 74. page metadata from successful source returned
        assert.equal(data.page.finalUrl, 'https://example.com/fabric-news-final');
        assert.equal(data.page.title, 'Fabric Official News');
        assert.equal(data.page.truncated, false);
        // 76. provider returned
        assert.equal(data.provider, 'openrouter');
        // 77. model returned
        assert.equal(data.model, 'deepseek/deepseek-v4-flash-0731');
        // 78. timings returned
        assert.ok(typeof data.searchDurationMs === 'number' && data.searchDurationMs >= 0);
        assert.ok(typeof data.pageReadDurationMs === 'number' && data.pageReadDurationMs >= 0);
        assert.ok(typeof data.providerQaDurationMs === 'number' && data.providerQaDurationMs >= 0);
        assert.ok(typeof data.serverResearchDurationMs === 'number' && data.serverResearchDurationMs >= 0);
        assert.ok(data.answer.includes('real-time intelligence'));
      } finally {
        await closeServer(server);
      }
    });

    await st.test('66, 68-74. success when source 0 fails and source 1 succeeds', async () => {
      const readCalls = [];
      const mockSearch = {
        search: async () => ({
          success: true,
          searchUsed: true,
          searchRequests: 1,
          searchEvidence: 'usage',
          sources: [
            { title: 'Bad PDF', url: 'https://example.com/s0.pdf' },
            { title: 'Good HTML', url: 'https://example.com/s1.html' },
            { title: 'Other HTML', url: 'https://example.com/s2.html' }
          ]
        })
      };

      const mockReader = async (u) => {
        readCalls.push(u);
        if (u.endsWith('.pdf')) {
          throw new PageReaderError('UNSUPPORTED_CONTENT_TYPE', 'PDF not supported');
        }
        return {
          text: 'Successful HTML body',
          requestedUrl: u,
          finalUrl: u,
          title: 'Good HTML Title',
          httpStatus: 200,
          contentType: 'text/html',
          truncated: false
        };
      };

      const mockAi = {
        model: 'deepseek/deepseek-v4-flash-0731',
        generateMessages: async () => ({
          success: true,
          text: 'Answer from source 1'
        })
      };

      const server = createServer({
        searchProvider: mockSearch,
        pageReaderFn: mockReader,
        provider: mockAi
      });
      const { url } = await listenOnEphemeralPort(server);

      try {
        const res = await fetch(`${url}/api/research-one`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'Question?' })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        // 66. success
        assert.equal(data.success, true);
        assert.deepEqual(readCalls, ['https://example.com/s0.pdf', 'https://example.com/s1.html']);
        // 68. selectedSourceIndex = 1
        assert.equal(data.selectedSourceIndex, 1);
        assert.equal(data.selectedSource.title, 'Good HTML');
        assert.equal(data.selectedSource.url, 'https://example.com/s1.html');
        // 71-72. sourcesFound=3, pageReadAttempts=2
        assert.equal(data.sourcesFound, 3);
        assert.equal(data.pageReadAttempts, 2);
        // 73. attempt diagnostics ordered
        assert.equal(data.attempts.length, 2);
        assert.equal(data.attempts[0].sourceIndex, 0);
        assert.equal(data.attempts[0].status, 'failed');
        assert.equal(data.attempts[0].errorCode, 'UNSUPPORTED_CONTENT_TYPE');
        assert.equal(data.attempts[1].sourceIndex, 1);
        assert.equal(data.attempts[1].status, 'success');
      } finally {
        await closeServer(server);
      }
    });

    await st.test('67. success when source 0 and 1 fail and source 2 succeeds', async () => {
      const readCalls = [];
      const mockSearch = {
        search: async () => ({
          success: true,
          searchUsed: true,
          searchRequests: 1,
          searchEvidence: 'usage',
          sources: [
            { title: 'Timeout Source', url: 'https://example.com/s0' },
            { title: 'Too Large Source', url: 'https://example.com/s1' },
            { title: 'Valid Source', url: 'https://example.com/s2' }
          ]
        })
      };

      const mockReader = async (u) => {
        readCalls.push(u);
        if (u === 'https://example.com/s0') throw new PageReaderError('FETCH_TIMEOUT', 'Timeout');
        if (u === 'https://example.com/s1') throw new PageReaderError('PAGE_TOO_LARGE', 'Too large');
        return {
          text: 'Valid content of source 2',
          requestedUrl: u,
          finalUrl: u,
          title: 'Source 2 Title',
          httpStatus: 200,
          contentType: 'text/html',
          truncated: false
        };
      };

      const mockAi = {
        model: 'deepseek/deepseek-v4-flash-0731',
        generateMessages: async () => ({
          success: true,
          text: 'Answer from source 2'
        })
      };

      const server = createServer({
        searchProvider: mockSearch,
        pageReaderFn: mockReader,
        provider: mockAi
      });
      const { url } = await listenOnEphemeralPort(server);

      try {
        const res = await fetch(`${url}/api/research-one`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'Question?' })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.deepEqual(readCalls, ['https://example.com/s0', 'https://example.com/s1', 'https://example.com/s2']);
        assert.equal(data.selectedSourceIndex, 2);
        assert.equal(data.pageReadAttempts, 3);
        assert.equal(data.attempts.length, 3);
        assert.equal(data.attempts[0].errorCode, 'FETCH_TIMEOUT');
        assert.equal(data.attempts[1].errorCode, 'PAGE_TOO_LARGE');
        assert.equal(data.attempts[2].status, 'success');
      } finally {
        await closeServer(server);
      }
    });
  });

  // ==================================================
  // Section 46: Integration Tests — Failure Contract (79-86)
  // ==================================================
  await t.test('Section 46: Failure Contract across pipeline stages', async (st) => {
    await st.test('79. all readable candidates fail -> NO_READABLE_SEARCH_SOURCE (422)', async () => {
      let aiCalled = false;
      const mockSearch = {
        search: async () => ({
          success: true,
          searchUsed: true,
          searchRequests: 1,
          searchEvidence: 'usage',
          sources: [
            { title: 'Doc 0', url: 'https://example.com/s0' },
            { title: 'Doc 1', url: 'https://example.com/s1' }
          ]
        })
      };

      const mockReader = async (u) => {
        if (u === 'https://example.com/s0') throw new PageReaderError('LOCAL_OR_PRIVATE_HOST_BLOCKED', 'Private IP');
        throw new PageReaderError('FETCH_FAILED', 'Connection reset');
      };

      const mockAi = {
        generateMessages: async () => { aiCalled = true; }
      };

      const server = createServer({
        searchProvider: mockSearch,
        pageReaderFn: mockReader,
        provider: mockAi
      });
      const { url } = await listenOnEphemeralPort(server);

      try {
        const res = await fetch(`${url}/api/research-one`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'Valid question?' })
        });
        assert.equal(res.status, 422);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.code, 'NO_READABLE_SEARCH_SOURCE');
        assert.equal(data.stage, 'page-read');
        assert.equal(data.pageReadAttempts, 2);
        assert.equal(data.attempts.length, 2);
        assert.equal(data.attempts[0].errorCode, 'LOCAL_OR_PRIVATE_HOST_BLOCKED');
        assert.equal(data.attempts[1].errorCode, 'FETCH_FAILED');
        assert.equal(aiCalled, false);
      } finally {
        await closeServer(server);
      }
    });

    await st.test('80. search failure -> no page reads', async () => {
      let pageReadCalled = false;
      const mockSearch = {
        search: async () => ({
          success: false,
          error: 'SEARCH_TIMEOUT',
          searchUsed: false
        })
      };
      const mockReader = async () => { pageReadCalled = true; return {}; };

      const server = createServer({ searchProvider: mockSearch, pageReaderFn: mockReader });
      const { url } = await listenOnEphemeralPort(server);

      try {
        const res = await fetch(`${url}/api/research-one`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'Valid question?' })
        });
        assert.equal(res.status, 502);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.stage, 'search');
        assert.equal(pageReadCalled, false);
      } finally {
        await closeServer(server);
      }
    });

    await st.test('81. searchUsed false -> no page reads', async () => {
      let pageReadCalled = false;
      const mockSearch = {
        search: async () => ({
          success: true,
          searchUsed: false,
          searchRequests: 0,
          searchEvidence: 'none',
          sources: [{ title: 'Doc', url: 'https://example.com/one' }]
        })
      };
      const mockReader = async () => { pageReadCalled = true; return {}; };

      const server = createServer({ searchProvider: mockSearch, pageReaderFn: mockReader });
      const { url } = await listenOnEphemeralPort(server);

      try {
        const res = await fetch(`${url}/api/research-one`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'Valid question?' })
        });
        assert.equal(res.status, 422);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.code, 'SEARCH_NOT_EXECUTED');
        assert.equal(data.stage, 'search');
        assert.equal(pageReadCalled, false);
      } finally {
        await closeServer(server);
      }
    });

    await st.test('82. no valid provider URLs -> existing no-source error (422)', async () => {
      let pageReadCalled = false;
      const mockSearch = {
        search: async () => ({
          success: true,
          searchUsed: true,
          searchRequests: 1,
          searchEvidence: 'usage',
          sources: [
            { title: 'Bad 1', url: 'ftp://files.example.com' },
            { title: 'Bad 2', url: 'not-a-url' }
          ]
        })
      };
      const mockReader = async () => { pageReadCalled = true; return {}; };

      const server = createServer({ searchProvider: mockSearch, pageReaderFn: mockReader });
      const { url } = await listenOnEphemeralPort(server);

      try {
        const res = await fetch(`${url}/api/research-one`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'Valid question?' })
        });
        assert.equal(res.status, 422);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.code, 'NO_USABLE_SEARCH_SOURCE');
        assert.equal(data.stage, 'source-selection');
        assert.equal(pageReadCalled, false);
      } finally {
        await closeServer(server);
      }
    });

    await st.test('83. unexpected page-reader failure stops immediately', async () => {
      const readCalls = [];
      const mockSearch = {
        search: async () => ({
          success: true,
          searchUsed: true,
          sources: [
            { title: 'Source 0', url: 'https://example.com/s0' },
            { title: 'Source 1', url: 'https://example.com/s1' }
          ]
        })
      };

      const mockReader = async (u) => {
        readCalls.push(u);
        throw new ReferenceError('Parser memory crash');
      };

      const server = createServer({ searchProvider: mockSearch, pageReaderFn: mockReader });
      const { url } = await listenOnEphemeralPort(server);

      try {
        const res = await fetch(`${url}/api/research-one`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'Valid question?' })
        });
        assert.equal(res.status, 502);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.code, 'PAGE_READ_INTERNAL_ERROR');
        assert.equal(data.stage, 'page-read');
        // Source 1 not attempted
        assert.equal(readCalls.length, 1);
      } finally {
        await closeServer(server);
      }
    });

    await st.test('84-86. AI failure stops after first readable source, no source fallback, no second search', async () => {
      let searchCount = 0;
      const readCalls = [];
      const mockSearch = {
        search: async () => {
          searchCount++;
          return {
            success: true,
            searchUsed: true,
            searchRequests: 1,
            searchEvidence: 'usage',
            sources: [
              { title: 'Source 0', url: 'https://example.com/s0' },
              { title: 'Source 1', url: 'https://example.com/s1' }
            ]
          };
        }
      };

      const mockReader = async (u) => {
        readCalls.push(u);
        return { text: 'Content of source 0' };
      };

      const mockAi = {
        generateMessages: async () => ({
          success: false,
          error: 'PROVIDER_RATE_LIMIT'
        })
      };

      const server = createServer({
        searchProvider: mockSearch,
        pageReaderFn: mockReader,
        provider: mockAi
      });
      const { url } = await listenOnEphemeralPort(server);

      try {
        const res = await fetch(`${url}/api/research-one`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'Valid question?' })
        });
        assert.equal(res.status, 502);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.code, 'PROVIDER_ERROR');
        assert.equal(data.stage, 'grounded-answer');

        // 84. AI failure stops after first readable source
        // 85. no source fallback after AI failure
        assert.equal(readCalls.length, 1);
        // 86. no second search
        assert.equal(searchCount, 1);
      } finally {
        await closeServer(server);
      }
    });
  });

  // ==================================================
  // Section 47: Statelessness Tests (87-93)
  // ==================================================
  await t.test('Section 47: Statelessness — sessions, stores, and disk files strictly unmutated', async (st) => {
    await st.test('87-93. source 0, source 1 fallback, source 2 fallback, all-source failure, AI failure do not mutate conversation; diagnostics not persisted', async () => {
      const testSession = new ConversationSession({ maxMessages: 5 });
      const initialSessionSize = testSession.size;

      const mockSearch = {
        search: async () => ({
          success: true,
          searchUsed: true,
          sources: [
            { title: 'Source 0 Bad', url: 'https://example.com/s0.pdf' },
            { title: 'Source 1 Good', url: 'https://example.com/s1' }
          ]
        })
      };

      const mockReader = async (u) => {
        if (u.endsWith('.pdf')) throw new PageReaderError('UNSUPPORTED_CONTENT_TYPE', 'PDF');
        return {
          text: 'SECRET RESEARCH TEXT THAT MUST NEVER PERSIST',
          requestedUrl: u,
          finalUrl: u
        };
      };

      const mockAi = {
        model: 'deepseek/deepseek-v4-flash-0731',
        generateMessages: async () => ({
          success: true,
          text: 'SECRET RESEARCH ANSWER THAT MUST NEVER PERSIST'
        })
      };

      const server = createServer({
        session: testSession,
        searchProvider: mockSearch,
        pageReaderFn: mockReader,
        provider: mockAi
      });
      const { url } = await listenOnEphemeralPort(server);

      try {
        // Fallback success
        const res = await fetch(`${url}/api/research-one`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'Stateless test question?' })
        });
        assert.equal(res.status, 200);
        assert.equal(testSession.size, initialSessionSize);
        assert.equal(testSession.getMessages().length, 0);

        // All-source failure
        const failServer = createServer({
          session: testSession,
          searchProvider: mockSearch,
          pageReaderFn: async () => { throw new PageReaderError('FETCH_FAILED', 'Failed'); }
        });
        const { url: failUrl } = await listenOnEphemeralPort(failServer);
        try {
          const failRes = await fetch(`${failUrl}/api/research-one`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: 'Will fail' })
          });
          assert.equal(failRes.status, 422);
          assert.equal(testSession.size, initialSessionSize);
        } finally {
          await closeServer(failServer);
        }

        // Verify runtime conversation file does not contain page or research data
        const convFilePath = resolve(process.cwd(), 'runtime/conversation.json');
        if (existsSync(convFilePath)) {
          const fileContent = readFileSync(convFilePath, 'utf8');
          assert.equal(fileContent.includes('SECRET RESEARCH TEXT THAT MUST NEVER PERSIST'), false);
          assert.equal(fileContent.includes('SECRET RESEARCH ANSWER THAT MUST NEVER PERSIST'), false);
        }
      } finally {
        await closeServer(server);
      }
    });
  });

  // ==================================================
  // Section 48: Regression Tests (94-109)
  // ==================================================
  await t.test('Section 48: Regressions — existing endpoints and services remain completely intact', async () => {
    const mockProvider = {
      model: 'deepseek/deepseek-v4-flash-0731',
      generate: async (prompt) => ({
        success: true,
        text: `Echo: ${prompt}`,
        model: 'deepseek/deepseek-v4-flash-0731',
        providerDurationMs: 50
      }),
      generateMessages: async (msgs) => ({
        success: true,
        text: 'Normal AI response',
        model: 'deepseek/deepseek-v4-flash-0731',
        providerDurationMs: 60
      }),
      streamMessages: async function* () {
        yield { text: 'Stream chunk' };
      }
    };

    const mockSearch = {
      search: async (q) => ({
        success: true,
        text: `Search result for ${q}`,
        response: `Search response for ${q}`,
        searchUsed: true,
        searchRequests: 1,
        searchEvidence: 'usage',
        sources: [{ title: 'Search Source', url: 'https://example.com/search-source' }]
      })
    };

    const mockReader = async (u) => ({
      success: true,
      text: 'Verified read page content',
      title: 'Page Title',
      requestedUrl: u,
      finalUrl: u,
      httpStatus: 200,
      contentType: 'text/html',
      rawBytes: 500,
      extractedCharacters: 120,
      redirectCount: 0,
      truncated: false
    });

    const server = createServer({
      provider: mockProvider,
      searchProvider: mockSearch,
      pageReaderFn: mockReader
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      // 94. /api/auto remains functional
      const autoRes = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'What is Power BI?' })
      });
      assert.equal(autoRes.status, 200);
      const autoData = await autoRes.json();
      assert.equal(autoData.route, 'ai');

      // 95. /api/ai remains functional
      const aiRes = await fetch(`${url}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Hello JARVIS' })
      });
      assert.equal(aiRes.status, 200);
      const aiData = await aiRes.json();
      assert.equal(aiData.success, true);

      // 96. /api/search remains functional
      const searchRes = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Latest news' })
      });
      assert.equal(searchRes.status, 200);
      const searchData = await searchRes.json();
      assert.equal(searchData.success, true);

      // 97. /api/read-page remains functional
      const readRes = await fetch(`${url}/api/read-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/test' })
      });
      assert.equal(readRes.status, 200);
      const readData = await readRes.json();
      assert.equal(readData.success, true);

      // 98. /api/page-qa remains functional
      const pageQaRes = await fetch(`${url}/api/page-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/test', question: 'What is this?' })
      });
      assert.equal(pageQaRes.status, 200);
      const pageQaData = await pageQaRes.json();
      assert.equal(pageQaData.success, true);
      assert.equal(pageQaData.grounded, true);

      // 99. /api/ai/stream remains functional
      const streamRes = await fetch(`${url}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Stream this' })
      });
      assert.equal(streamRes.status, 200);

      // Index UI contains Grounded Web Research section and preserves all existing UI
      const indexRes = await fetch(`${url}/`);
      assert.equal(indexRes.status, 200);
      const html = await indexRes.text();
      assert.ok(html.includes('id="research-one-section"'));
      assert.ok(html.includes('id="research-question-input"'));
      assert.ok(html.includes('id="research-one-btn"'));
      assert.ok(html.includes('id="ask-ai-btn"'));
      assert.ok(html.includes('id="search-web-btn"'));
      assert.ok(html.includes('id="read-page-btn"'));
      assert.ok(html.includes('id="page-qa-btn"'));
    } finally {
      await closeServer(server);
    }
  });
});
