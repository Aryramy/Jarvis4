import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/web/server.js';
import { ConversationSession } from '../../src/core/conversationSession.js';
import { ConversationStore } from '../../src/core/conversationStore.js';
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

test('Automatic Decision Route /api/auto - Brick 20 Integration Tests', async (t) => {
  // 26, 27, 28, 32, 33, 34: AI-routed request
  await t.test('valid AI-routed request returns route="ai", invokes normal AI path once, and never invokes search', async () => {
    let aiCallCount = 0;
    let searchCallCount = 0;
    let receivedInput = null;

    const mockAiProvider = {
      apiKey: 'mock-ai-key',
      validateConfig: () => ({ valid: true }),
      generateMessages: async (messages) => {
        aiCallCount++;
        receivedInput = messages[messages.length - 1].content;
        return {
          success: true,
          text: 'Power BI is a data visualization platform.',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash-0731',
          providerDurationMs: 120
        };
      }
    };

    const mockSearchProvider = {
      apiKey: 'mock-search-key',
      validateConfig: () => ({ valid: true }),
      search: async () => {
        searchCallCount++;
        throw new Error('Search provider should not be called');
      }
    };

    const server = createServer({
      provider: mockAiProvider,
      searchProvider: mockSearchProvider
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'What is Power BI?' })
      });

      assert.equal(res.status, 200);
      const data = await res.json();

      // 26. route = "ai"
      assert.equal(data.success, true);
      assert.equal(data.route, 'ai');

      // 27. AI path invoked exactly once
      assert.equal(aiCallCount, 1);
      assert.equal(receivedInput, 'What is Power BI?');

      // 28. search provider NOT invoked
      assert.equal(searchCallCount, 0);

      // 32. routeReason returned
      assert.ok(typeof data.routeReason === 'string');
      assert.equal(data.routeReason, 'default:no-live-signal');

      // 33. routeDecisionMs returned
      assert.ok(typeof data.routeDecisionMs === 'number');
      assert.ok(data.routeDecisionMs >= 0);

      // 34. existing AI diagnostics preserved
      assert.equal(data.response, 'Power BI is a data visualization platform.');
      assert.equal(data.provider, 'openrouter');
      assert.equal(data.model, 'deepseek/deepseek-v4-flash-0731');
      assert.ok(data.timing);
      assert.equal(data.timing.providerDurationMs, 120);
      assert.ok(typeof data.timing.serverAiDurationMs === 'number');
      assert.ok(typeof data.timing.routeDecisionMs === 'number');
    } finally {
      await closeServer(server);
    }
  });

  // 29, 30, 31, 35, 36, 37, 38, 39, 40: Search-routed request
  await t.test('valid search-routed request returns route="search", invokes search path once, and never invokes normal AI', async () => {
    let aiCallCount = 0;
    let searchCallCount = 0;
    let receivedPrompt = null;

    const mockAiProvider = {
      apiKey: 'mock-ai-key',
      validateConfig: () => ({ valid: true }),
      generateMessages: async () => {
        aiCallCount++;
        throw new Error('AI provider should not be called');
      }
    };

    const mockSearchProvider = {
      apiKey: 'mock-search-key',
      validateConfig: () => ({ valid: true }),
      search: async (prompt) => {
        searchCallCount++;
        receivedPrompt = prompt;
        return {
          success: true,
          response: 'Microsoft Fabric announced new October updates.',
          text: 'Microsoft Fabric announced new October updates.',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash-0731',
          searchUsed: true,
          searchRequests: null, // 39. null/unavailable behavior
          searchEvidence: 'url_citation', // 38. evidence
          currentDate: '2026-10-11', // 40. freshness
          freshnessSensitive: true,
          newestSourceDate: '2026-10-06',
          freshnessStatus: 'current',
          sources: [ // 36. sources
            {
              title: 'Fabric Blog',
              url: 'https://fabric.microsoft.com/blog',
              publishedDate: '2026-10-06'
            }
          ],
          providerSearchDurationMs: 450
        };
      }
    };

    const server = createServer({
      provider: mockAiProvider,
      searchProvider: mockSearchProvider
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'What are the latest Microsoft Fabric announcements?' })
      });

      assert.equal(res.status, 200);
      const data = await res.json();

      // 29. route = "search"
      assert.equal(data.success, true);
      assert.equal(data.route, 'search');

      // 30. search invoked exactly once
      assert.equal(searchCallCount, 1);
      assert.equal(receivedPrompt, 'What are the latest Microsoft Fabric announcements?');

      // 31. AI provider NOT invoked
      assert.equal(aiCallCount, 0);

      // 32. routeReason returned
      assert.ok(typeof data.routeReason === 'string');
      assert.match(data.routeReason, /latest/);

      // 33. routeDecisionMs returned
      assert.ok(typeof data.routeDecisionMs === 'number');
      assert.ok(data.routeDecisionMs >= 0);

      // 35. search diagnostics preserved
      assert.equal(data.response, 'Microsoft Fabric announced new October updates.');
      assert.equal(data.provider, 'openrouter');
      assert.equal(data.model, 'deepseek/deepseek-v4-flash-0731');

      // 36. sources preserved
      assert.equal(data.sources.length, 1);
      assert.equal(data.sources[0].url, 'https://fabric.microsoft.com/blog');

      // 37. searchUsed preserved
      assert.equal(data.searchUsed, true);

      // 38. searchEvidence preserved
      assert.equal(data.searchEvidence, 'url_citation');

      // 39. searchRequests null preserved
      assert.equal(data.searchRequests, null);

      // 40. freshness diagnostics preserved
      assert.equal(data.currentDate, '2026-10-11');
      assert.equal(data.freshnessSensitive, true);
      assert.equal(data.newestSourceDate, '2026-10-06');
      assert.equal(data.freshnessStatus, 'current');

      assert.ok(data.timing);
      assert.equal(data.timing.providerSearchDurationMs, 450);
      assert.ok(typeof data.timing.routeDecisionMs === 'number');
    } finally {
      await closeServer(server);
    }
  });

  // 41, 42: Search error propagates safely and does NOT fall back to AI
  await t.test('search error propagates safely with 500 error and does NOT fall back to AI', async () => {
    let aiCallCount = 0;

    const mockAiProvider = {
      apiKey: 'mock-ai-key',
      validateConfig: () => ({ valid: true }),
      generateMessages: async () => {
        aiCallCount++;
        return { success: true, text: 'Should never run' };
      }
    };

    const mockSearchProvider = {
      apiKey: 'mock-search-key',
      validateConfig: () => ({ valid: true }),
      search: async () => {
        return {
          success: false,
          error: 'SEARCH_TOOL_LOOP_INCOMPLETE: tool call was not resolved',
          searchUsed: true,
          searchRequests: 1,
          searchEvidence: 'usage',
          sources: []
        };
      }
    };

    const server = createServer({
      provider: mockAiProvider,
      searchProvider: mockSearchProvider
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'What is happening right now?' })
      });

      assert.equal(res.status, 500);
      const data = await res.json();

      assert.equal(data.success, false);
      assert.equal(data.route, 'search');
      assert.match(data.error, /SEARCH_TOOL_LOOP_INCOMPLETE/);

      // 42. AI was NOT called
      assert.equal(aiCallCount, 0);

      // Evidence preserved
      assert.equal(data.searchUsed, true);
      assert.equal(data.searchRequests, 1);
      assert.equal(data.searchEvidence, 'usage');
    } finally {
      await closeServer(server);
    }
  });

  // 43: AI failure does NOT automatically invoke search
  await t.test('AI failure does NOT automatically invoke search', async () => {
    let searchCallCount = 0;

    const mockAiProvider = {
      apiKey: 'mock-ai-key',
      validateConfig: () => ({ valid: true }),
      generateMessages: async () => {
        return {
          success: false,
          error: 'OpenRouter rate limit exceeded'
        };
      }
    };

    const mockSearchProvider = {
      apiKey: 'mock-search-key',
      validateConfig: () => ({ valid: true }),
      search: async () => {
        searchCallCount++;
        return { success: true, text: 'Search fallback should not happen' };
      }
    };

    const server = createServer({
      provider: mockAiProvider,
      searchProvider: mockSearchProvider
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Explain star schema.' })
      });

      assert.equal(res.status, 500);
      const data = await res.json();

      assert.equal(data.success, false);
      assert.equal(data.route, 'ai');
      assert.match(data.error, /rate limit/);

      // 43. Search was NOT called
      assert.equal(searchCallCount, 0);
    } finally {
      await closeServer(server);
    }
  });

  // 44, 45: Input validation error handling
  await t.test('invalid/missing text returns controlled 400 validation error', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      // Missing text
      const res1 = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(res1.status, 400);
      const data1 = await res1.json();
      assert.equal(data1.success, false);
      assert.equal(data1.error, 'Input must be a string');

      // Non-string text
      const res2 = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 12345 })
      });
      assert.equal(res2.status, 400);

      // Empty string
      const res3 = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '' })
      });
      assert.equal(res3.status, 400);
      const data3 = await res3.json();
      assert.equal(data3.error, 'Input cannot be empty');

      // Whitespace only
      const res4 = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '   \t\n  ' })
      });
      assert.equal(res4.status, 400);

      // Non-POST method
      const res5 = await fetch(`${url}/api/auto`, { method: 'GET' });
      assert.equal(res5.status, 405);

      // Invalid JSON
      const res6 = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json{'
      });
      assert.equal(res6.status, 400);
    } finally {
      await closeServer(server);
    }
  });

  // 46, 47, 48: /api/ai, /api/search, /api/ai/stream behavior remains unchanged
  await t.test('/api/ai, /api/search, and /api/ai/stream behave unaffected', async () => {
    const mockAiProvider = {
      apiKey: 'mock-ai-key',
      validateConfig: () => ({ valid: true }),
      generateMessages: async () => ({
        success: true,
        text: 'Direct AI response.',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731'
      }),
      streamMessages: async function* () {
        yield 'Stream delta.';
      }
    };

    const mockSearchProvider = {
      apiKey: 'mock-search-key',
      validateConfig: () => ({ valid: true }),
      search: async () => ({
        success: true,
        response: 'Direct search response.',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        searchUsed: true,
        sources: []
      })
    };

    const server = createServer({
      provider: mockAiProvider,
      searchProvider: mockSearchProvider
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      // 46. /api/ai
      const aiRes = await fetch(`${url}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Direct AI test' })
      });
      assert.equal(aiRes.status, 200);
      const aiData = await aiRes.json();
      assert.equal(aiData.success, true);
      assert.equal(aiData.response, 'Direct AI response.');

      // 47. /api/search
      const searchRes = await fetch(`${url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Direct search test' })
      });
      assert.equal(searchRes.status, 200);
      const searchData = await searchRes.json();
      assert.equal(searchData.success, true);
      assert.equal(searchData.response, 'Direct search response.');

      // 48. /api/ai/stream
      const streamRes = await fetch(`${url}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Direct stream test' })
      });
      assert.equal(streamRes.status, 200);
      const streamText = await streamRes.text();
      assert.ok(streamText.includes('Stream delta.'));
      assert.ok(streamText.includes('"type":"done"'));
    } finally {
      await closeServer(server);
    }
  });

  // 49, 50: Search remains stateless and normal AI conversation behavior remains unchanged
  await t.test('search remains stateless, while normal AI maintains conversation memory in session and store', async () => {
    const testStorePath = resolve(process.cwd(), 'runtime/test-auto-conv.json');
    if (existsSync(testStorePath)) unlinkSync(testStorePath);

    const store = new ConversationStore({ filePath: testStorePath });
    const session = new ConversationSession({ maxMessages: 10 });

    let lastMessagesSeen = [];
    const mockAiProvider = {
      apiKey: 'mock-ai-key',
      validateConfig: () => ({ valid: true }),
      generateMessages: async (messages) => {
        lastMessagesSeen = [...messages];
        return {
          success: true,
          text: `Answer for turn ${messages.length}`,
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash-0731'
        };
      }
    };

    const mockSearchProvider = {
      apiKey: 'mock-search-key',
      validateConfig: () => ({ valid: true }),
      search: async () => ({
        success: true,
        response: 'Search answer.',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        searchUsed: true,
        sources: []
      })
    };

    const server = createServer({
      provider: mockAiProvider,
      searchProvider: mockSearchProvider,
      session,
      store
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      // Turn 1 (AI): "My favorite color is teal."
      const t1 = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'My favorite color is teal.' })
      });
      assert.equal(t1.status, 200);
      assert.equal((await t1.json()).route, 'ai');
      assert.equal(session.size, 2);

      // Turn 2 (Search): "What is the weather in Doha?" (should NOT be added to session or store)
      const t2 = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'What is the weather in Doha?' })
      });
      assert.equal(t2.status, 200);
      assert.equal((await t2.json()).route, 'search');

      // 49. Search remains stateless
      assert.equal(session.size, 2); // Still only turn 1!
      const diskStored = store.load();
      assert.equal(diskStored.length, 2);

      // Turn 3 (AI): "What color did I say earlier?"
      const t3 = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'What color did I say earlier?' })
      });
      assert.equal(t3.status, 200);
      assert.equal((await t3.json()).route, 'ai');

      // 50. Normal AI conversation behavior preserved
      assert.equal(session.size, 4);
      assert.equal(lastMessagesSeen.length, 3);
      assert.equal(lastMessagesSeen[0].content, 'My favorite color is teal.');
      assert.equal(lastMessagesSeen[2].content, 'What color did I say earlier?');
    } finally {
      await closeServer(server);
      if (existsSync(testStorePath)) unlinkSync(testStorePath);
    }
  });

  // 51 to 57: UI Contract and Structure Checks
  await t.test('UI contains Ask JARVIS using /api/auto, Search Web using /api/search, and route indicator', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/`);
      assert.equal(res.status, 200);
      const html = await res.text();

      // 51. Ask JARVIS button & /api/auto in client script
      assert.ok(html.includes('id="ask-ai-btn"'));
      assert.match(html, /<button type="button" id="ask-ai-btn">Ask JARVIS<\/button>/);
      assert.ok(html.includes("fetch('/api/auto'"));

      // 52. Search Web still uses /api/search
      assert.ok(html.includes('id="search-web-btn"'));
      assert.ok(html.includes("fetch('/api/search'"));

      // 53. streaming control still uses /api/ai/stream
      assert.ok(html.includes('id="ask-ai-stream-btn"'));
      assert.ok(html.includes("fetch('/api/ai/stream'"));

      // 54. automatic search result can render source list
      assert.ok(html.includes('id="search-sources"'));
      assert.ok(html.includes('data.route === \'search\''));

      // 55, 56. route indicator element
      assert.ok(html.includes('id="route-indicator"'));
      assert.ok(html.includes('Route: Normal AI'));
      assert.ok(html.includes('Route: Web Search'));

      // 57. Clear conversation resets route indicator
      assert.ok(html.includes('id="clear-conv-btn"'));
      assert.ok(html.includes("routeIndicator.style.display = 'none'"));
    } finally {
      await closeServer(server);
    }
  });

  // 58: Multilingual Freshness Consistency: Urdu & Arabic freshness queries in /api/auto return freshnessSensitive: true
  await t.test('POST /api/auto with Urdu & Arabic freshness queries routes to search and returns freshnessSensitive: true', async () => {
    let capturedSearchPrompt = null;
    let aiCallCount = 0;

    const mockAiProvider = {
      apiKey: 'mock-ai-key',
      validateConfig: () => ({ valid: true }),
      generateMessages: async () => {
        aiCallCount++;
        return {
          success: true,
          text: 'AI answer for ordinary question',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash-0731',
          providerDurationMs: 120
        };
      }
    };

    const mockSearchProvider = {
      apiKey: 'mock-search-key',
      validateConfig: () => ({ valid: true }),
      search: async (prompt) => {
        capturedSearchPrompt = prompt;
        return {
          success: true,
          response: 'Search answer for freshness question',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash-0731',
          sources: [
            { title: 'Source 1', url: 'https://example.com/1', snippet: '...', publishedDate: '2026-10-10' }
          ],
          searchUsed: true,
          searchRequests: null,
          searchEvidence: 'url_citation',
          currentDate: '2026-10-11',
          freshnessSensitive: true,
          newestSourceDate: '2026-10-10',
          freshnessStatus: 'current',
          timing: { providerSearchDurationMs: 400 }
        };
      }
    };

    const server = createServer({
      provider: mockAiProvider,
      searchProvider: mockSearchProvider
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      // 1. Urdu freshness prompt
      const urduRes = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'آج Microsoft Fabric کی تازہ ترین خبریں کیا ہیں؟' })
      });
      assert.equal(urduRes.status, 200);
      const urduData = await urduRes.json();
      assert.equal(urduData.success, true);
      assert.equal(urduData.route, 'search');
      assert.equal(urduData.routeReason, 'multilingual:urdu:تازہ ترین');
      assert.equal(urduData.searchUsed, true);
      assert.equal(urduData.freshnessSensitive, true);
      assert.equal(capturedSearchPrompt, 'آج Microsoft Fabric کی تازہ ترین خبریں کیا ہیں؟');

      // 2. Arabic freshness prompt
      const arabicRes = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'ما هي أحدث أخبار Microsoft Fabric اليوم؟' })
      });
      assert.equal(arabicRes.status, 200);
      const arabicData = await arabicRes.json();
      assert.equal(arabicData.success, true);
      assert.equal(arabicData.route, 'search');
      assert.equal(arabicData.routeReason, 'multilingual:arabic:أحدث');
      assert.equal(arabicData.searchUsed, true);
      assert.equal(arabicData.freshnessSensitive, true);

      // 3. Urdu ordinary prompt routes to AI
      const urduOrdRes = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Power BI کیا ہے؟' })
      });
      assert.equal(urduOrdRes.status, 200);
      const urduOrdData = await urduOrdRes.json();
      assert.equal(urduOrdData.success, true);
      assert.equal(urduOrdData.route, 'ai');
      assert.equal(urduOrdData.routeReason, 'default:no-live-signal');

      // 4. Arabic ordinary prompt routes to AI
      const arabicOrdRes = await fetch(`${url}/api/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'ما هو Power BI؟' })
      });
      assert.equal(arabicOrdRes.status, 200);
      const arabicOrdData = await arabicOrdRes.json();
      assert.equal(arabicOrdData.success, true);
      assert.equal(arabicOrdData.route, 'ai');
      assert.equal(arabicOrdData.routeReason, 'default:no-live-signal');
    } finally {
      await closeServer(server);
    }
  });
});
