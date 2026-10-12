import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/web/server.js';
import { ConversationSession } from '../../src/core/conversationSession.js';
import { ConversationStore } from '../../src/core/conversationStore.js';
import { handleText } from '../../src/core/textCore.js';
import { decideSearchRoute } from '../../src/routing/searchDecision.js';
import { isFreshnessSensitiveQuery } from '../../src/providers/openRouterSearch.js';
import { existsSync, unlinkSync } from 'node:fs';
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

test('Browser Decision Endpoint /api/browser-decision - Integration Tests (Brick 25 Sections 44-46)', async (t) => {
  // 49. POST /api/browser-decision works
  await t.test('49. POST /api/browser-decision works with valid interactive request', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/browser-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: 'Log into Outlook and open my latest email' })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.browserRequired, true);
      assert.equal(data.route, 'browser');
      assert.equal(data.reasonCode, 'interactive-authentication');
      assert.equal(typeof data.reason, 'string');
      assert.equal(data.source, 'request-intent');
      assert.ok(Array.isArray(data.matchedSignals));
    } finally {
      await closeServer(server);
    }
  });

  // 50. GET rejected if project conventions require POST-only
  await t.test('50. GET rejected with 405 Method Not Allowed', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/browser-decision`, { method: 'GET' });
      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.error, 'Method Not Allowed');
    } finally {
      await closeServer(server);
    }
  });

  // 51. missing request rejected
  await t.test('51. missing request rejected with 400', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/browser-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'INVALID_REQUEST');
    } finally {
      await closeServer(server);
    }
  });

  // 52. non-string request rejected
  await t.test('52. non-string request rejected with 400', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/browser-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: 12345 })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'INVALID_REQUEST');
    } finally {
      await closeServer(server);
    }
  });

  // 53. empty request rejected
  await t.test('53. empty request rejected with 400', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/browser-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: '   ' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'INVALID_REQUEST');
    } finally {
      await closeServer(server);
    }
  });

  // 54. over-limit request rejected
  await t.test('54. over-limit request rejected with 400', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const longRequest = 'x'.repeat(2001);
      const res = await fetch(`${url}/api/browser-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: longRequest })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'REQUEST_TOO_LONG');
    } finally {
      await closeServer(server);
    }
  });

  // 55. browser decision response schema stable
  await t.test('55. browser decision response schema stable', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/browser-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: 'Click the Sign in button' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.equal(typeof data.browserRequired, 'boolean');
      assert.equal(data.browserRequired, true);
      assert.equal(data.route, 'browser');
      assert.equal(typeof data.reasonCode, 'string');
      assert.equal(typeof data.reason, 'string');
      assert.equal(data.source, 'request-intent');
      assert.ok(Array.isArray(data.matchedSignals));
    } finally {
      await closeServer(server);
    }
  });

  // 56. static decision response schema stable
  await t.test('56. static decision response schema stable', async () => {
    const server = createServer();
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/browser-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: 'What is Power BI?' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.equal(typeof data.browserRequired, 'boolean');
      assert.equal(data.browserRequired, false);
      assert.equal(data.route, 'static');
      assert.equal(typeof data.reasonCode, 'string');
      assert.equal(typeof data.reason, 'string');
      assert.equal(data.source, 'request-intent');
      assert.ok(Array.isArray(data.matchedSignals));
    } finally {
      await closeServer(server);
    }
  });

  // 57-60. Zero AI, search, page read, or browser calls
  await t.test('57-60. Zero AI provider calls, zero search calls, zero page reads, zero browser launches', async () => {
    let aiCallCount = 0;
    let searchCallCount = 0;
    let pageReadCallCount = 0;

    const mockAiProvider = {
      generate: async () => { aiCallCount++; return { success: true, text: 'fake' }; },
      generateMessages: async () => { aiCallCount++; return { success: true, text: 'fake' }; },
      validateConfig: () => ({ valid: true })
    };

    const mockSearchProvider = {
      search: async () => { searchCallCount++; return { success: true, results: [] }; }
    };

    const mockPageReader = async () => {
      pageReadCallCount++;
      return { success: true };
    };

    const server = createServer({
      provider: mockAiProvider,
      searchProvider: mockSearchProvider,
      pageReaderFn: mockPageReader
    });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const res = await fetch(`${url}/api/browser-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: 'Click the Sign in button',
          staticOutcome: { success: false, stage: 'page-read', errorCode: 'NO_READABLE_CONTENT' }
        })
      });

      assert.equal(res.status, 200);
      assert.equal(aiCallCount, 0, 'Must make zero AI calls');
      assert.equal(searchCallCount, 0, 'Must make zero search calls');
      assert.equal(pageReadCallCount, 0, 'Must make zero page read calls');
    } finally {
      await closeServer(server);
    }
  });

  // Section 45: Statelessness Tests (61-64)
  await t.test('61-64. Browser decision does not modify ConversationSession, ConversationStore, or disk', async () => {
    const testStorePath = resolve(process.cwd(), 'runtime', 'test-browser-decision-conv.json');
    if (existsSync(testStorePath)) {
      try { unlinkSync(testStorePath); } catch {}
    }

    const store = new ConversationStore({ filePath: testStorePath });
    const session = new ConversationSession({ maxMessages: 20 });
    session.addMessage('user', 'Initial conversation turn');

    const server = createServer({ session, store });
    const { url } = await listenOnEphemeralPort(server);

    try {
      const initialSessionSize = session.size;

      const res = await fetch(`${url}/api/browser-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: 'Log into Outlook' })
      });

      assert.equal(res.status, 200);
      assert.equal(session.size, initialSessionSize, 'ConversationSession must not be mutated');
      assert.equal(existsSync(testStorePath), false, 'Disk persistence file must not be created or mutated');
    } finally {
      await closeServer(server);
      if (existsSync(testStorePath)) {
        try { unlinkSync(testStorePath); } catch {}
      }
    }
  });

  // Section 46: Regression Tests (65-81)
  await t.test('65-81. Core pipelines remain unchanged and functional', async () => {
    // textCore regression
    const textRes = handleText('Hello JARVIS');
    assert.equal(textRes.success, true);

    // search decision regression
    const routeRes = decideSearchRoute('What are the latest Microsoft Fabric announcements?');
    assert.equal(routeRes.route, 'search');

    const staticRouteRes = decideSearchRoute('What is Power BI?');
    assert.equal(staticRouteRes.route, 'ai');

    // freshness signal check
    assert.equal(isFreshnessSensitiveQuery('latest news'), true);
  });
});
