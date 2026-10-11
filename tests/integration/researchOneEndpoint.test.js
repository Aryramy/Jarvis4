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

test('Research One Endpoint /api/research-one - Integration Tests (Brick 23 Sections 38-41)', async (t) => {
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
  // Section 38: Integration Tests — Success
  // ==================================================
  await t.test('36-51. Section 38: Successful Research-One execution returns complete structured response', async () => {
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
        body: JSON.stringify({
          question: 'What are the latest Microsoft Fabric announcements?'
        })
      });

      assert.equal(res.status, 200);
      const data = await res.json();

      // 36. success true
      assert.equal(data.success, true);
      // 37. grounded true
      assert.equal(data.grounded, true);
      // 38. search evidence returned
      assert.ok(data.search);
      assert.equal(data.search.searchUsed, true);
      assert.equal(data.search.searchEvidence, 'url_citation');
      assert.equal(data.search.searchRequests, 1);
      // 39. sourcesFound returned
      assert.equal(data.search.sourcesFound, 2);
      assert.equal(data.sourcesFound, 2);
      // 40. selectedSourceIndex returned
      assert.equal(data.selectedSourceIndex, 0);
      assert.equal(data.selectedSource.index, 0);
      // 41. selectedSource title returned
      assert.equal(data.selectedSource.title, 'Fabric News');
      // 42. selectedSource URL returned
      assert.equal(data.selectedSource.url, 'https://example.com/fabric-news');
      // 43. page final URL returned
      assert.equal(data.page.finalUrl, 'https://example.com/fabric-news-final');
      // 44. page title returned
      assert.equal(data.page.title, 'Fabric Official News');
      // 45. page truncated returned
      assert.equal(data.page.truncated, false);
      assert.equal(data.pageTruncated, false);
      // 46. provider returned
      assert.equal(data.provider, 'openrouter');
      // 47. model returned
      assert.equal(data.model, 'deepseek/deepseek-v4-flash-0731');
      // 48. searchDurationMs returned
      assert.ok(typeof data.searchDurationMs === 'number' && data.searchDurationMs >= 0);
      // 49. pageReadDurationMs returned
      assert.ok(typeof data.pageReadDurationMs === 'number' && data.pageReadDurationMs >= 0);
      // 50. providerQaDurationMs returned
      assert.ok(typeof data.providerQaDurationMs === 'number' && data.providerQaDurationMs >= 0);
      // 51. serverResearchDurationMs returned
      assert.ok(typeof data.serverResearchDurationMs === 'number' && data.serverResearchDurationMs >= 0);

      assert.ok(data.answer.includes('real-time intelligence'));
    } finally {
      await closeServer(server);
    }
  });

  // ==================================================
  // Section 39: Integration Tests — Failure
  // ==================================================
  await t.test('52-60. Section 39: Failure cases enforce stages and stop pipeline immediately', async (st) => {
    await st.test('52. invalid question rejected before search (stage: validation)', async () => {
      let searchCalled = false;
      const mockSearch = { search: async () => { searchCalled = true; return {}; } };
      const server = createServer({ searchProvider: mockSearch });
      const { url } = await listenOnEphemeralPort(server);

      try {
        const res = await fetch(`${url}/api/research-one`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: '   ' })
        });
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.code, 'INVALID_QUESTION');
        assert.equal(data.stage, 'validation');
        assert.equal(searchCalled, false);
      } finally {
        await closeServer(server);
      }
    });

    await st.test('53. search failure prevents page read (stage: search)', async () => {
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

    await st.test('54. searchUsed false prevents page read (stage: search)', async () => {
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

    await st.test('55. no usable source prevents page read (stage: source-selection)', async () => {
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

    await st.test('56. page-reader failure prevents AI call (stage: page-read)', async () => {
      let aiCalled = false;
      const mockSearch = {
        search: async () => ({
          success: true,
          searchUsed: true,
          searchRequests: 1,
          searchEvidence: 'usage',
          sources: [{ title: 'Doc', url: 'https://example.com/page' }]
        })
      };
      const mockReader = async () => {
        const err = new PageReaderError('LOCAL_OR_PRIVATE_HOST_BLOCKED', 'SSRF blocked');
        throw err;
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
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.code, 'LOCAL_OR_PRIVATE_HOST_BLOCKED');
        assert.equal(data.stage, 'page-read');
        assert.equal(aiCalled, false);
      } finally {
        await closeServer(server);
      }
    });

    await st.test('57-60. AI failure does not invoke search again, does not read another source, no normal AI fallback, returns controlled stage', async () => {
      let searchCount = 0;
      let pageReadCount = 0;
      const mockSearch = {
        search: async () => {
          searchCount++;
          return {
            success: true,
            searchUsed: true,
            searchRequests: 1,
            searchEvidence: 'usage',
            sources: [
              { title: 'Doc 1', url: 'https://example.com/one' },
              { title: 'Doc 2', url: 'https://example.com/two' }
            ]
          };
        }
      };
      const mockReader = async () => {
        pageReadCount++;
        return { text: 'Valid page content' };
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
        assert.ok(data.message.includes('PROVIDER_RATE_LIMIT'));
        assert.equal(data.stage, 'grounded-answer');

        // Exactly one search, exactly one page read
        assert.equal(searchCount, 1);
        assert.equal(pageReadCount, 1);
      } finally {
        await closeServer(server);
      }
    });
  });

  // ==================================================
  // Section 40: Statelessness Tests
  // ==================================================
  await t.test('61-67. Section 40: Statelessness — session, store, and file strictly unmutated', async () => {
    const testSession = new ConversationSession({ maxMessages: 5 });
    const initialSessionSize = testSession.size;

    const mockSearchProvider = {
      search: async () => ({
        success: true,
        searchUsed: true,
        searchRequests: 1,
        searchEvidence: 'usage',
        sources: [{ title: 'Doc', url: 'https://example.com/doc' }]
      })
    };
    const mockPageReader = async () => ({
      text: 'SECRET WEBPAGE CONTENT THAT MUST NEVER PERSIST',
      requestedUrl: 'https://example.com/doc',
      finalUrl: 'https://example.com/doc'
    });
    const mockAiProvider = {
      model: 'deepseek/deepseek-v4-flash-0731',
      generateMessages: async () => ({
        success: true,
        text: 'GROUNDED RESEARCH ANSWER THAT MUST NEVER PERSIST'
      })
    };

    const server = createServer({
      session: testSession,
      searchProvider: mockSearchProvider,
      pageReaderFn: mockPageReader,
      provider: mockAiProvider
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      // 61. successful Research-One does not mutate ConversationSession
      const res = await fetch(`${url}/api/research-one`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Stateless test question?' })
      });
      assert.equal(res.status, 200);
      assert.equal(testSession.size, initialSessionSize);
      assert.equal(testSession.getMessages().length, 0);

      // 63-65. Failure cases do not mutate conversation
      const failRes = await fetch(`${url}/api/research-one`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: '   ' })
      });
      assert.equal(failRes.status, 400);
      assert.equal(testSession.size, initialSessionSize);

      // 66-67. Check runtime conversation file if exists: neither page text nor research answer persisted
      const convFilePath = resolve(process.cwd(), 'runtime/conversation.json');
      if (existsSync(convFilePath)) {
        const fileContent = readFileSync(convFilePath, 'utf8');
        assert.equal(fileContent.includes('SECRET WEBPAGE CONTENT THAT MUST NEVER PERSIST'), false);
        assert.equal(fileContent.includes('GROUNDED RESEARCH ANSWER THAT MUST NEVER PERSIST'), false);
      }
    } finally {
      await closeServer(server);
    }
  });

  // ==================================================
  // Section 41: Regression Tests
  // ==================================================
  await t.test('68-84. Section 41: Regressions — existing endpoints and services remain completely intact', async () => {
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
      // 68. /api/auto remains functional
      const autoRes = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'What is Power BI?' })
      });
      assert.equal(autoRes.status, 200);
      const autoData = await autoRes.json();
      assert.equal(autoData.route, 'ai');

      // 69. /api/ai remains functional
      const aiRes = await fetch(`${url}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Hello JARVIS' })
      });
      assert.equal(aiRes.status, 200);
      const aiData = await aiRes.json();
      assert.equal(aiData.success, true);

      // 70. /api/search remains functional
      const searchRes = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Latest news' })
      });
      assert.equal(searchRes.status, 200);
      const searchData = await searchRes.json();
      assert.equal(searchData.success, true);

      // 71. /api/read-page remains functional
      const readRes = await fetch(`${url}/api/read-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/test' })
      });
      assert.equal(readRes.status, 200);
      const readData = await readRes.json();
      assert.equal(readData.success, true);

      // 72. /api/page-qa remains functional
      const pageQaRes = await fetch(`${url}/api/page-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/test', question: 'What is this?' })
      });
      assert.equal(pageQaRes.status, 200);
      const pageQaData = await pageQaRes.json();
      assert.equal(pageQaData.success, true);
      assert.equal(pageQaData.grounded, true);

      // 73. /api/ai/stream remains functional
      const streamRes = await fetch(`${url}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Stream this' })
      });
      assert.equal(streamRes.status, 200);

      // Index UI contains new Grounded Web Research section and preserves all existing UI
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
