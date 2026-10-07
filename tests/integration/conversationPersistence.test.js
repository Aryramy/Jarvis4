import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { startServer } from '../../src/web/server.js';
import { ConversationStore } from '../../src/core/conversationStore.js';

describe('Web Server Conversation Persistence - Brick 8', () => {
  let tempFilePath;
  let testStore;

  beforeEach(() => {
    tempFilePath = join(tmpdir(), `test-srv-persist-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    testStore = new ConversationStore({ filePath: tempFilePath });
  });

  afterEach(() => {
    if (existsSync(tempFilePath)) {
      try { unlinkSync(tempFilePath); } catch {}
    }
  });

  test('successful normal AI turn is persisted to disk', async () => {
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async generateMessages(messages) {
        return { success: true, text: `Echo: ${messages[messages.length - 1].content}` };
      }
    };

    const server = await startServer(0, '127.0.0.1', { provider: mockProvider, store: testStore });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const res = await fetch(`${baseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'My code is NOVA-842.' })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);

      // Verify file is persisted
      const persisted = testStore.load();
      assert.equal(persisted.length, 2);
      assert.deepEqual(persisted, [
        { role: 'user', content: 'My code is NOVA-842.' },
        { role: 'assistant', content: 'Echo: My code is NOVA-842.' }
      ]);
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  test('successful streaming AI turn is persisted only after completion', async () => {
    let capturedDuringStream;
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async *streamMessages(messages) {
        // While streaming, check if store has already saved the incomplete assistant turn
        capturedDuringStream = testStore.load();
        yield 'Streamed ';
        yield 'response.';
      }
    };

    const server = await startServer(0, '127.0.0.1', { provider: mockProvider, store: testStore });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const res = await fetch(`${baseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Stream turn test' })
      });

      assert.equal(res.status, 200);
      await res.text(); // Consume stream until complete

      // During stream, the assistant response was not yet stored
      assert.deepEqual(capturedDuringStream, []);

      // After clean completion, store has both user and full assistant turns
      const persisted = testStore.load();
      assert.equal(persisted.length, 2);
      assert.deepEqual(persisted, [
        { role: 'user', content: 'Stream turn test' },
        { role: 'assistant', content: 'Streamed response.' }
      ]);
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  test('provider failure does not overwrite last valid persisted state', async () => {
    // 1. Seed valid persisted state
    testStore.save([
      { role: 'user', content: 'Initial valid user turn' },
      { role: 'assistant', content: 'Initial valid assistant turn' }
    ]);

    const failingProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async generateMessages() {
        return { success: false, error: 'Provider simulated 500' };
      }
    };

    const server = await startServer(0, '127.0.0.1', { provider: failingProvider, store: testStore });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const res = await fetch(`${baseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Failing turn' })
      });

      assert.equal(res.status, 500);

      // Verify the persisted state on disk was NOT corrupted or overwritten
      const persisted = testStore.load();
      assert.equal(persisted.length, 2);
      assert.equal(persisted[0].content, 'Initial valid user turn');
      assert.equal(persisted[1].content, 'Initial valid assistant turn');
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  test('streaming failure does not persist partial assistant output', async () => {
    testStore.save([
      { role: 'user', content: 'Initial turn' },
      { role: 'assistant', content: 'Initial reply' }
    ]);

    const failingStreamProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async *streamMessages() {
        yield 'Partial chunk ';
        throw new Error('Mid-stream failure');
      }
    };

    const server = await startServer(0, '127.0.0.1', { provider: failingStreamProvider, store: testStore });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const res = await fetch(`${baseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Failing stream prompt' })
      });

      await res.text();

      // Persisted state must still contain only the original 2 messages
      const persisted = testStore.load();
      assert.equal(persisted.length, 2);
      assert.equal(persisted[0].content, 'Initial turn');
      assert.equal(persisted[1].content, 'Initial reply');
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  test('client abort does not persist incomplete assistant output', async () => {
    testStore.save([
      { role: 'user', content: 'Safe prior turn' },
      { role: 'assistant', content: 'Safe prior answer' }
    ]);

    let releaseStream;
    const streamGate = new Promise(resolve => {
      releaseStream = resolve;
    });

    const slowProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async *streamMessages() {
        yield 'Chunk 1 ';
        await streamGate;
        yield 'Chunk 2';
      }
    };

    const server = await startServer(0, '127.0.0.1', { provider: slowProvider, store: testStore });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Aborted streaming prompt' }),
        signal: controller.signal
      });

      const reader = res.body.getReader();
      await reader.read(); // Read first chunk

      // Abort connection
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 80));
      releaseStream();

      // Ensure persistence did not record the aborted turn
      const persisted = testStore.load();
      assert.equal(persisted.length, 2);
      assert.equal(persisted[0].content, 'Safe prior turn');
      assert.equal(persisted[1].content, 'Safe prior answer');
    } finally {
      releaseStream();
      await new Promise(r => server.close(r));
    }
  });

  test('server startup restores previous valid conversation and works with normal Ask AI', async () => {
    // Simulate saved state before server starts
    testStore.save([
      { role: 'user', content: 'Remember this: test code is NOVA-842.' },
      { role: 'assistant', content: 'Noted: NOVA-842.' }
    ]);

    let capturedMessages = null;
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async generateMessages(messages) {
        capturedMessages = messages;
        return { success: true, text: 'Your test code is NOVA-842.' };
      }
    };

    // Start server simulating restart
    const server = await startServer(0, '127.0.0.1', { provider: mockProvider, store: testStore });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const res = await fetch(`${baseUrl}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'What is my test code?' })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.response, 'Your test code is NOVA-842.');

      // Check captured messages sent to provider included restored history + new turn
      assert.equal(capturedMessages.length, 3);
      assert.equal(capturedMessages[0].content, 'Remember this: test code is NOVA-842.');
      assert.equal(capturedMessages[1].content, 'Noted: NOVA-842.');
      assert.equal(capturedMessages[2].content, 'What is my test code?');
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  test('server startup restores previous valid conversation and works with Ask AI — Stream', async () => {
    testStore.save([
      { role: 'user', content: 'My code is DELTA-99.' },
      { role: 'assistant', content: 'Acknowledged.' }
    ]);

    let capturedMessages = null;
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async *streamMessages(messages) {
        capturedMessages = messages;
        yield 'Restored: DELTA-99.';
      }
    };

    const server = await startServer(0, '127.0.0.1', { provider: mockProvider, store: testStore });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const res = await fetch(`${baseUrl}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Repeat my code' })
      });

      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('DELTA-99'));

      assert.equal(capturedMessages.length, 3);
      assert.equal(capturedMessages[0].content, 'My code is DELTA-99.');
      assert.equal(capturedMessages[1].content, 'Acknowledged.');
      assert.equal(capturedMessages[2].content, 'Repeat my code');
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  test('normal AI → stop server → restart → stream Ask AI shares restored context', async () => {
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async generateMessages(messages) {
        return { success: true, text: 'Understood your secret planet.' };
      },
      async *streamMessages(messages) {
        const secret = messages.find(m => m.content.includes('VELORA-99')) ? 'VELORA-99' : 'UNKNOWN';
        yield `Planet is ${secret}`;
      }
    };

    // Server Instance 1: Normal Ask AI
    const server1 = await startServer(0, '127.0.0.1', { provider: mockProvider, store: testStore });
    const baseUrl1 = `http://127.0.0.1:${server1.address().port}`;

    try {
      const res1 = await fetch(`${baseUrl1}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'My secret planet is VELORA-99.' })
      });
      assert.equal(res1.status, 200);
    } finally {
      await new Promise(r => server1.close(r));
    }

    // Server Instance 2: Simulating restart, Ask AI — Stream
    const server2 = await startServer(0, '127.0.0.1', { provider: mockProvider, store: testStore });
    const baseUrl2 = `http://127.0.0.1:${server2.address().port}`;

    try {
      const res2 = await fetch(`${baseUrl2}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'What is my secret planet?' })
      });
      assert.equal(res2.status, 200);
      const text = await res2.text();
      assert.ok(text.includes('VELORA-99'));
    } finally {
      await new Promise(r => server2.close(r));
    }
  });

  test('stream Ask AI → stop server → restart → normal Ask AI shares restored context', async () => {
    let capturedOnRestart = null;
    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async *streamMessages(messages) {
        yield 'Falcon registered.';
      },
      async generateMessages(messages) {
        capturedOnRestart = messages;
        return { success: true, text: 'Your bird is FALCON-77.' };
      }
    };

    // Server Instance 1: Streaming
    const server1 = await startServer(0, '127.0.0.1', { provider: mockProvider, store: testStore });
    const baseUrl1 = `http://127.0.0.1:${server1.address().port}`;

    try {
      const res1 = await fetch(`${baseUrl1}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'My test bird is FALCON-77.' })
      });
      assert.equal(res1.status, 200);
      await res1.text();
    } finally {
      await new Promise(r => server1.close(r));
    }

    // Server Instance 2: Restart, Normal AI
    const server2 = await startServer(0, '127.0.0.1', { provider: mockProvider, store: testStore });
    const baseUrl2 = `http://127.0.0.1:${server2.address().port}`;

    try {
      const res2 = await fetch(`${baseUrl2}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'What is my bird?' })
      });
      assert.equal(res2.status, 200);
      assert.ok(capturedOnRestart.some(m => m.content.includes('FALCON-77')));
    } finally {
      await new Promise(r => server2.close(r));
    }
  });

  test('Clear Conversation clears disk + memory, and restart does not restore old context', async () => {
    testStore.save([
      { role: 'user', content: 'Secret number is 771122.' },
      { role: 'assistant', content: 'Stored.' }
    ]);

    const mockProvider = {
      apiKey: 'test-key',
      validateConfig() { return { valid: true }; },
      async generateMessages(messages) {
        return { success: true, text: `Count: ${messages.length}` };
      }
    };

    // Server Instance 1: Clear conversation
    const server1 = await startServer(0, '127.0.0.1', { provider: mockProvider, store: testStore });
    const baseUrl1 = `http://127.0.0.1:${server1.address().port}`;

    try {
      const clearRes = await fetch(`${baseUrl1}/api/conversation/clear`, {
        method: 'POST'
      });
      assert.equal(clearRes.status, 200);
      const clearData = await clearRes.json();
      assert.equal(clearData.success, true);

      // Verify file is gone on disk
      assert.equal(existsSync(tempFilePath), false);
    } finally {
      await new Promise(r => server1.close(r));
    }

    // Server Instance 2: Restart after clear
    let capturedMessages = null;
    mockProvider.generateMessages = async (messages) => {
      capturedMessages = messages;
      return { success: true, text: 'No prior memory.' };
    };

    const server2 = await startServer(0, '127.0.0.1', { provider: mockProvider, store: testStore });
    const baseUrl2 = `http://127.0.0.1:${server2.address().port}`;

    try {
      const res2 = await fetch(`${baseUrl2}/api/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'What was my number?' })
      });
      assert.equal(res2.status, 200);

      // Only the current turn should be present (prior state forgotten)
      assert.equal(capturedMessages.length, 1);
      assert.equal(capturedMessages[0].content, 'What was my number?');
    } finally {
      await new Promise(r => server2.close(r));
    }
  });
});
