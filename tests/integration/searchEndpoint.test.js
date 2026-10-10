import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/web/server.js';
import { ConversationSession } from '../../src/core/conversationSession.js';
import { ConversationStore } from '../../src/core/conversationStore.js';
import { OpenRouterSearchProvider } from '../../src/providers/openRouterSearch.js';
import { OpenRouterTextProvider } from '../../src/providers/openRouterText.js';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
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

test('Web Search Endpoint /api/search - Brick 19 Integration Tests', async (t) => {
  await t.test('rejects non-POST methods with 405 Method Not Allowed', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const getRes = await fetch(`${url}/api/search`, { method: 'GET' });
      assert.equal(getRes.status, 405);
      const getData = await getRes.json();
      assert.equal(getData.success, false);
      assert.equal(getData.error, 'Method Not Allowed');

      const putRes = await fetch(`${url}/api/search`, { method: 'PUT' });
      assert.equal(putRes.status, 405);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('rejects invalid JSON with 400 Bad Request', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json{'
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Invalid JSON body');
    } finally {
      await closeServer(server);
    }
  });

  await t.test('rejects missing or empty prompt with 400 Bad Request', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res1 = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(res1.status, 400);

      const res2 = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '   ' })
      });
      assert.equal(res2.status, 400);
      const data2 = await res2.json();
      assert.equal(data2.error, 'Prompt cannot be empty');
    } finally {
      await closeServer(server);
    }
  });

  await t.test('successful web search returns grounded response, sources, searchUsed, searchRequests, and timing', async () => {
    let searchCalledWith = null;

    const mockSearchProvider = {
      apiKey: 'mock-key',
      validateConfig: () => ({ valid: true }),
      search: async (prompt) => {
        searchCalledWith = prompt;
        return {
          success: true,
          response: 'Microsoft Fabric announced new Copilot integrations.',
          text: 'Microsoft Fabric announced new Copilot integrations.',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash-0731',
          searchUsed: true,
          searchRequests: 1,
          currentDate: '2026-10-10',
          freshnessSensitive: true,
          newestSourceDate: '2026-10-05',
          freshnessStatus: 'current',
          sources: [
            {
              title: 'Microsoft Fabric Announcements',
              url: 'https://blog.fabric.microsoft.com/announcements',
              publishedDate: '2026-10-05'
            }
          ],
          providerSearchDurationMs: 420
        };
      }
    };

    const server = createServer({ searchProvider: mockSearchProvider });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'What are the latest Microsoft Fabric announcements?' })
      });

      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(searchCalledWith, 'What are the latest Microsoft Fabric announcements?');
      assert.equal(data.success, true);
      assert.equal(data.provider, 'openrouter');
      assert.equal(data.model, 'deepseek/deepseek-v4-flash-0731');
      assert.equal(data.response, 'Microsoft Fabric announced new Copilot integrations.');
      assert.equal(data.searchUsed, true);
      assert.equal(data.searchRequests, 1);
      assert.equal(data.currentDate, '2026-10-10');
      assert.equal(data.freshnessSensitive, true);
      assert.equal(data.newestSourceDate, '2026-10-05');
      assert.equal(data.freshnessStatus, 'current');
      assert.deepEqual(data.sources, [
        {
          title: 'Microsoft Fabric Announcements',
          url: 'https://blog.fabric.microsoft.com/announcements',
          publishedDate: '2026-10-05'
        }
      ]);

      // Timing assertions
      assert.equal(typeof data.providerSearchDurationMs, 'number');
      assert.ok(data.providerSearchDurationMs >= 0);
      assert.equal(typeof data.serverSearchDurationMs, 'number');
      assert.ok(data.serverSearchDurationMs >= 0);
      assert.equal(data.timing.providerSearchDurationMs, 420);
      assert.equal(typeof data.timing.serverSearchDurationMs, 'number');
    } finally {
      await closeServer(server);
    }
  });

  await t.test('zero search requests produces searchUsed false', async () => {
    const mockSearchProvider = {
      apiKey: 'mock-key',
      validateConfig: () => ({ valid: true }),
      search: async () => {
        return {
          success: true,
          response: 'Direct answer without web search.',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash-0731',
          searchUsed: false,
          searchRequests: 0,
          searchEvidence: 'none',
          sources: [],
          providerSearchDurationMs: 150
        };
      }
    };

    const server = createServer({ searchProvider: mockSearchProvider });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Simple query' })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.searchUsed, false);
      assert.equal(data.searchRequests, 0);
      assert.equal(data.searchEvidence, 'none');
      assert.deepEqual(data.sources, []);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('missing usage metadata with genuine url_citation annotations produces searchUsed true, searchRequests null, and searchEvidence url_citation', async () => {
    const mockSearchProvider = {
      apiKey: 'mock-key',
      validateConfig: () => ({ valid: true }),
      search: async () => {
        return {
          success: true,
          response: 'Microsoft Fabric response based on web search.',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash-0731',
          searchUsed: true,
          searchRequests: null,
          searchEvidence: 'url_citation',
          sources: [
            {
              title: 'Fabric Blog',
              url: 'https://blog.fabric.microsoft.com'
            }
          ],
          providerSearchDurationMs: 300
        };
      }
    };

    const server = createServer({ searchProvider: mockSearchProvider });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Microsoft Fabric query' })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.searchUsed, true);
      assert.equal(data.searchRequests, null);
      assert.equal(data.searchEvidence, 'url_citation');
      assert.equal(data.sources.length, 1);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('handles provider failure with 500 error, redacts API keys, and does not leak sources', async () => {
    const secretKey = 'sk-or-v1-my-secret-search-token';
    const mockSearchProvider = {
      apiKey: secretKey,
      validateConfig: () => ({ valid: true }),
      search: async () => {
        return {
          success: false,
          error: `OpenRouter rate limit exceeded for key ${secretKey}`,
          searchUsed: false,
          searchRequests: null,
          searchEvidence: 'none',
          sources: [],
          providerSearchDurationMs: 50
        };
      }
    };

    const server = createServer({ searchProvider: mockSearchProvider });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Search query' })
      });

      assert.equal(res.status, 500);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(!data.error.includes(secretKey));
      assert.ok(data.error.includes('[REDACTED]'));
      assert.equal(data.searchUsed, false);
      assert.equal(data.searchRequests, null);
      assert.equal(data.searchEvidence, 'none');
      assert.deepEqual(data.sources, []);
      assert.equal(typeof data.serverSearchDurationMs, 'number');
      assert.equal(typeof data.providerSearchDurationMs, 'number');
    } finally {
      await closeServer(server);
    }
  });

  await t.test('search is completely STATELESS: never written to ConversationSession or ConversationStore', async () => {
    const tempStorePath = resolve(process.cwd(), 'runtime', `.test-search-store-${Date.now()}.json`);
    const session = new ConversationSession();
    const store = new ConversationStore({ filePath: tempStorePath });

    const mockSearchProvider = {
      apiKey: 'mock-key',
      validateConfig: () => ({ valid: true }),
      search: async () => ({
        success: true,
        response: 'Grounded search output.',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        searchUsed: true,
        searchRequests: 1,
        sources: [{ title: 'Doc', url: 'https://doc.com' }]
      })
    };

    const server = createServer({ session, store, searchProvider: mockSearchProvider });
    const { url } = await listenOnEphemeralPort(server);

    try {
      // 1. Initial state
      assert.equal(session.size, 0);
      assert.deepEqual(store.load(), []);

      // 2. Perform search
      const res = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'What is Fabric?' })
      });

      assert.equal(res.status, 200);

      // 3. Verify session and store remain completely untouched
      assert.equal(session.size, 0);
      assert.deepEqual(store.load(), []);
      assert.equal(existsSync(tempStorePath), false);
    } finally {
      await closeServer(server);
      if (existsSync(tempStorePath)) {
        unlinkSync(tempStorePath);
      }
    }
  });

  await t.test('request to OpenRouter includes openrouter:web_search tool with pinned exa parameters and narrow system instruction', async () => {
    let capturedBody = null;

    const realProviderWithMockFetch = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: 'Search reply',
              annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com', title: 'Example' } }]
            }
          }],
          usage: { server_tool_use: { web_search_requests: 1 } }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const server = createServer({ searchProvider: realProviderWithMockFetch });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Latest news' })
      });

      assert.equal(res.status, 200);
      assert.ok(capturedBody);
      assert.equal(capturedBody.model, 'deepseek/deepseek-v4-flash-0731');
      assert.equal(capturedBody.max_tool_calls, undefined, 'top-level max_tool_calls must not be sent');
      assert.equal(capturedBody.max_tokens, 1500);
      assert.deepEqual(capturedBody.tools, [
        {
          type: 'openrouter:web_search',
          parameters: {
            engine: 'exa',
            mode: 'fast',
            max_uses: 1,
            max_results: 3,
            max_total_results: 3,
            max_characters: 1200
          }
        }
      ]);
      assert.ok(capturedBody.messages[0].content.includes('Current date:'));
      assert.ok(capturedBody.messages[0].content.includes('You have access to live web search.'));
      assert.equal(capturedBody.messages[1].content, 'Latest news');
    } finally {
      await closeServer(server);
    }
  });

  await t.test('SEARCH_OUTPUT_TRUNCATED error preserves search evidence over /api/search', async () => {
    const mockSearchProvider = {
      apiKey: 'mock-key',
      validateConfig: () => ({ valid: true }),
      search: async () => ({
        success: false,
        error: 'SEARCH_OUTPUT_TRUNCATED',
        searchUsed: true,
        searchRequests: 1,
        searchEvidence: 'usage+url_citation',
        providerFinishReason: 'length',
        hasMessageContent: false,
        sources: [{ title: 'Fabric Announcement', url: 'https://blog.fabric.microsoft.com' }],
        providerSearchDurationMs: 500
      })
    };

    const server = createServer({ searchProvider: mockSearchProvider });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Latest news' })
      });

      assert.equal(res.status, 500);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'SEARCH_OUTPUT_TRUNCATED');
      assert.equal(data.searchUsed, true);
      assert.equal(data.searchRequests, 1);
      assert.equal(data.searchEvidence, 'usage+url_citation');
      assert.equal(data.providerFinishReason, 'length');
      assert.equal(data.hasMessageContent, false);
      assert.equal(data.sources.length, 1);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('INVARIANT: normal /api/ai does NOT include web-search tool or search freshness prompt', async () => {
    let capturedAiBody = null;

    const textProviderWithMockFetch = new OpenRouterTextProvider({
      apiKey: 'test-key',
      fetchFn: async (url, opts) => {
        capturedAiBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Normal AI response.' } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const server = createServer({ provider: textProviderWithMockFetch });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Normal query' })
      });

      assert.equal(res.status, 200);
      assert.ok(capturedAiBody);
      // Strictly verify no tools array or openrouter:web_search is sent
      assert.equal(capturedAiBody.tools, undefined);
      assert.equal(capturedAiBody.max_tool_calls, undefined);
      // Verify freshness instructions are not injected into normal AI
      assert.ok(!capturedAiBody.messages[0].content.includes('Current date:'));
      assert.ok(!capturedAiBody.messages[0].content.includes('You have access to live web search.'));
    } finally {
      await closeServer(server);
    }
  });

  await t.test('INVARIANT: normal /api/ai/stream does NOT include web-search tool or search limits', async () => {
    let capturedStreamBody = null;

    const textProviderWithMockFetch = new OpenRouterTextProvider({
      apiKey: 'test-key',
      fetchFn: async (url, opts) => {
        capturedStreamBody = JSON.parse(opts.body);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          }
        });
        return new Response(stream, { status: 200 });
      }
    });

    const server = createServer({ provider: textProviderWithMockFetch });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Normal streaming query' })
      });

      assert.equal(res.status, 200);
      // Consume body
      await res.text();
      assert.ok(capturedStreamBody);
      assert.equal(capturedStreamBody.tools, undefined);
      assert.equal(capturedStreamBody.max_tool_calls, undefined);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('UI contains Search Web control and search display elements', () => {
    const html = readFileSync(resolve(process.cwd(), 'src/web/index.html'), 'utf8');

    // Controls
    assert.ok(html.includes('id="search-web-btn"'), 'Search Web button must exist');
    assert.ok(html.includes('>Search Web<'), 'Search Web button text must exist');

    // Existing controls preserved
    assert.ok(html.includes('id="ask-ai-btn"'));
    assert.ok(html.includes('id="ask-ai-stream-btn"'));
    assert.ok(html.includes('id="clear-conv-btn"'));
    assert.ok(html.includes('id="start-mic-btn"'));
    assert.ok(html.includes('id="stop-mic-btn"'));
    assert.ok(html.includes('id="transcribe-btn"'));
    assert.ok(html.includes('id="ask-jarvis-btn"'));
    assert.ok(html.includes('id="speak-response-btn"'));
    assert.ok(html.includes('id="run-voice-turn-btn"'));

    // Search display elements
    assert.ok(html.includes('id="search-section"'));
    assert.ok(html.includes('id="search-status"'));
    assert.ok(html.includes('id="search-meta"'));
    assert.ok(html.includes('id="search-response"'));
    assert.ok(html.includes('id="search-sources"'));
  });

  await t.test('Architectural Boundary Assertions for Brick 19', () => {
    const serverCode = readFileSync(resolve(process.cwd(), 'src/web/server.js'), 'utf8');
    const searchCode = readFileSync(resolve(process.cwd(), 'src/providers/openRouterSearch.js'), 'utf8');
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));

    // No browser automation / Playwright
    assert.ok(!pkg.dependencies?.playwright);
    assert.ok(!pkg.devDependencies?.playwright);
    assert.ok(!serverCode.includes('playwright'));
    assert.ok(!searchCode.includes('playwright'));

    // No web-fetch tool
    assert.ok(!searchCode.includes('openrouter:web_fetch'));

    // No fallback search engine
    assert.ok(!searchCode.includes('engine: "auto"') && !searchCode.includes("engine: 'auto'"));
    assert.ok(!searchCode.includes('bing') && !searchCode.includes('duckduckgo') && !searchCode.includes('firecrawl'));

    // No automatic search routing
    assert.ok(!serverCode.includes('shouldSearch') && !serverCode.includes('routeSearch'));

    // Voice turn unchanged (does not route to search)
    const voiceTurnCode = readFileSync(resolve(process.cwd(), 'src/web/voiceTurn.js'), 'utf8');
    assert.ok(!voiceTurnCode.includes('/api/search'), 'VoiceTurn must not call /api/search in Brick 19');
  });
});
