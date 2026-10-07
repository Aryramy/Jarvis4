import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, existsSync, unlinkSync, readFileSync, readdirSync } from 'node:fs';
import { ConversationStore } from '../../src/core/conversationStore.js';
import { ConversationSession } from '../../src/core/conversationSession.js';

describe('ConversationStore - Brick 8', () => {
  let tempFilePath;
  let store;
  let capturedLogs = [];

  const mockLogger = {
    warn: (msg) => capturedLogs.push({ level: 'warn', msg }),
    info: (msg) => capturedLogs.push({ level: 'info', msg }),
    error: (msg) => capturedLogs.push({ level: 'error', msg }),
    debug: (msg) => capturedLogs.push({ level: 'debug', msg })
  };

  beforeEach(() => {
    capturedLogs = [];
    tempFilePath = join(tmpdir(), `test-conv-store-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    store = new ConversationStore({ filePath: tempFilePath, logger: mockLogger });
  });

  afterEach(() => {
    if (existsSync(tempFilePath)) {
      try { unlinkSync(tempFilePath); } catch {}
    }
  });

  test('ConversationStore loads empty state when file does not exist', () => {
    assert.equal(existsSync(tempFilePath), false);
    const messages = store.load();
    assert.deepEqual(messages, []);
    assert.equal(capturedLogs.length, 0);
  });

  test('ConversationStore saves valid messages and loads them back', () => {
    const originalMessages = [
      { role: 'user', content: 'Remember this: code is NOVA-842.' },
      { role: 'assistant', content: 'Understood, code noted.' }
    ];

    const saved = store.save(originalMessages);
    assert.equal(saved, true);
    assert.equal(existsSync(tempFilePath), true);

    const loaded = store.load();
    assert.deepEqual(loaded, originalMessages);
  });

  test('role and content order is strictly preserved', () => {
    const turns = [
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'Response 1' },
      { role: 'user', content: 'Turn 2' },
      { role: 'assistant', content: 'Response 2' },
      { role: 'user', content: 'Turn 3' }
    ];

    store.save(turns);
    const loaded = store.load();
    assert.equal(loaded.length, 5);
    for (let i = 0; i < turns.length; i++) {
      assert.equal(loaded[i].role, turns[i].role);
      assert.equal(loaded[i].content, turns[i].content);
    }
  });

  test('clear removes persisted state and subsequent load returns empty array', () => {
    store.save([{ role: 'user', content: 'Temporary text' }]);
    assert.equal(existsSync(tempFilePath), true);

    const cleared = store.clear();
    assert.equal(cleared, true);
    assert.equal(existsSync(tempFilePath), false);

    const loaded = store.load();
    assert.deepEqual(loaded, []);
  });

  test('malformed JSON is handled safely without crashing', () => {
    writeFileSync(tempFilePath, '{ this is not valid JSON ::: ', 'utf8');

    const loaded = store.load();
    assert.deepEqual(loaded, []);
    assert.ok(capturedLogs.some(l => l.level === 'warn' && l.msg.includes('malformed JSON')));
  });

  test('invalid stored structure (missing version, bad messages) is rejected safely', () => {
    // 1. Root not an object
    writeFileSync(tempFilePath, JSON.stringify([1, 2, 3]), 'utf8');
    assert.deepEqual(store.load(), []);
    assert.ok(capturedLogs.some(l => l.level === 'warn' && l.msg.includes('root is not a valid JSON object')));

    capturedLogs = [];
    // 2. Missing version
    writeFileSync(tempFilePath, JSON.stringify({ messages: [] }), 'utf8');
    assert.deepEqual(store.load(), []);
    assert.ok(capturedLogs.some(l => l.level === 'warn' && l.msg.includes('version')));

    capturedLogs = [];
    // 3. Messages not an array
    writeFileSync(tempFilePath, JSON.stringify({ version: 1, messages: 'not-an-array' }), 'utf8');
    assert.deepEqual(store.load(), []);
    assert.ok(capturedLogs.some(l => l.level === 'warn' && l.msg.includes('messages property is not an array')));

    capturedLogs = [];
    // 4. Invalid role in message item
    writeFileSync(tempFilePath, JSON.stringify({
      version: 1,
      messages: [{ role: 'hacker', content: 'payload' }]
    }), 'utf8');
    assert.deepEqual(store.load(), []);
    assert.ok(capturedLogs.some(l => l.level === 'warn' && l.msg.includes('invalid role')));
  });

  test('save rejects non-array or invalid messages', () => {
    assert.throws(() => store.save('invalid'), /Messages to save must be an array/);
    assert.throws(() => store.save([{ role: 'unknown', content: 'test' }]), /Invalid message role/);
    assert.throws(() => store.save([{ role: 'user', content: '' }]), /content cannot be empty/);
  });

  test('atomic save writes versioned JSON and leaves no temporary files behind', () => {
    store.save([{ role: 'user', content: 'Atomic test' }]);

    const raw = readFileSync(tempFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.messages.length, 1);

    // Verify temp files starting with tempFilePath are cleaned up
    const dir = tmpdir();
    const files = readdirSync(dir);
    const orphanTemps = files.filter(f => f.startsWith(`test-conv-store-`) && f.includes('.tmp.'));
    assert.equal(orphanTemps.length, 0);
  });

  test('secrets and API keys are not injected or stored', () => {
    const sample = [{ role: 'user', content: 'Normal question' }, { role: 'assistant', content: 'Normal answer' }];
    store.save(sample);

    const fileContent = readFileSync(tempFilePath, 'utf8');
    assert.equal(fileContent.includes('apiKey'), false);
    assert.equal(fileContent.includes('Authorization'), false);
    assert.equal(fileContent.includes('CHEAPER_INFERENCE'), false);
  });

  test('history limit remains enforced when restoring into ConversationSession', () => {
    const session = new ConversationSession({ maxMessages: 3 });

    const messages = [
      { role: 'user', content: 'Message 1' },
      { role: 'assistant', content: 'Response 1' },
      { role: 'user', content: 'Message 2' },
      { role: 'assistant', content: 'Response 2' },
      { role: 'user', content: 'Message 3' }
    ];

    store.save(messages);
    const loaded = store.load();
    assert.equal(loaded.length, 5);

    // Load into session constrained to maxMessages: 3
    session.load(loaded);
    assert.equal(session.size, 3);
    assert.deepEqual(session.getMessages(), [
      { role: 'user', content: 'Message 2' },
      { role: 'assistant', content: 'Response 2' },
      { role: 'user', content: 'Message 3' }
    ]);
  });
});
