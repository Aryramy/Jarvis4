import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationSession } from '../../src/core/conversationSession.js';

describe('ConversationSession - Brick 6', () => {
  test('ConversationSession begins empty', () => {
    const session = new ConversationSession();
    assert.equal(session.size, 0);
    assert.deepEqual(session.getMessages(), []);
  });

  test('user message can be added', () => {
    const session = new ConversationSession();
    const msg = session.addUserMessage('My name is Ary.');
    assert.deepEqual(msg, { role: 'user', content: 'My name is Ary.' });
    assert.equal(session.size, 1);
    assert.deepEqual(session.getMessages(), [
      { role: 'user', content: 'My name is Ary.' }
    ]);
  });

  test('assistant message can be added', () => {
    const session = new ConversationSession();
    const msg = session.addAssistantMessage('Nice to meet you, Ary.');
    assert.deepEqual(msg, { role: 'assistant', content: 'Nice to meet you, Ary.' });
    assert.equal(session.size, 1);
    assert.deepEqual(session.getMessages(), [
      { role: 'assistant', content: 'Nice to meet you, Ary.' }
    ]);
  });

  test('messages preserve correct order', () => {
    const session = new ConversationSession();
    session.addUserMessage('First turn');
    session.addAssistantMessage('First response');
    session.addUserMessage('Second turn');
    session.addAssistantMessage('Second response');

    assert.equal(session.size, 4);
    assert.deepEqual(session.getMessages(), [
      { role: 'user', content: 'First turn' },
      { role: 'assistant', content: 'First response' },
      { role: 'user', content: 'Second turn' },
      { role: 'assistant', content: 'Second response' }
    ]);
  });

  test('clear removes all messages', () => {
    const session = new ConversationSession();
    session.addUserMessage('Hello');
    session.addAssistantMessage('Hi there');
    assert.equal(session.size, 2);

    session.clear();
    assert.equal(session.size, 0);
    assert.deepEqual(session.getMessages(), []);
  });

  test('maximum history limit is enforced', () => {
    const session = new ConversationSession({ maxMessages: 3 });
    session.addUserMessage('Message 1');
    session.addAssistantMessage('Message 2');
    session.addUserMessage('Message 3');
    assert.equal(session.size, 3);

    // Adding 4th message should discard the oldest (Message 1)
    session.addAssistantMessage('Message 4');
    assert.equal(session.size, 3);
    assert.deepEqual(session.getMessages(), [
      { role: 'assistant', content: 'Message 2' },
      { role: 'user', content: 'Message 3' },
      { role: 'assistant', content: 'Message 4' }
    ]);

    // Adding 5th message should discard Message 2
    session.addUserMessage('Message 5');
    assert.equal(session.size, 3);
    assert.deepEqual(session.getMessages(), [
      { role: 'user', content: 'Message 3' },
      { role: 'assistant', content: 'Message 4' },
      { role: 'user', content: 'Message 5' }
    ]);
  });

  test('invalid roles are rejected', () => {
    const session = new ConversationSession();
    const invalidRoles = ['admin', 'bot', 'human', '', null, 123, undefined, {}];

    for (const role of invalidRoles) {
      assert.throws(() => {
        session.addMessage(role, 'valid content');
      }, /Invalid role/);
    }

    assert.equal(session.size, 0);
  });

  test('invalid/empty content is rejected', () => {
    const session = new ConversationSession();

    // Empty string
    assert.throws(() => {
      session.addUserMessage('');
    }, /cannot be empty/);

    // Whitespace only
    assert.throws(() => {
      session.addUserMessage('    \n\t  ');
    }, /cannot be empty/);

    // Non-string
    assert.throws(() => {
      session.addUserMessage(12345);
    }, /must be a string/);

    assert.throws(() => {
      session.addUserMessage(null);
    }, /must be a string/);

    assert.throws(() => {
      session.addAssistantMessage('');
    }, /cannot be empty/);

    assert.throws(() => {
      session.addAssistantMessage('   ');
    }, /cannot be empty/);

    assert.throws(() => {
      session.addAssistantMessage(undefined);
    }, /must be a string/);

    assert.equal(session.size, 0);
  });

  test('pop rolls back the last message properly', () => {
    const session = new ConversationSession();
    session.addUserMessage('Message to keep');
    session.addUserMessage('Failed message');
    assert.equal(session.size, 2);

    const popped = session.pop();
    assert.deepEqual(popped, { role: 'user', content: 'Failed message' });
    assert.equal(session.size, 1);
    assert.deepEqual(session.getMessages(), [
      { role: 'user', content: 'Message to keep' }
    ]);
  });

  test('getMessages returns a shallow copy and isolates internal state', () => {
    const session = new ConversationSession();
    session.addUserMessage('Original');
    const msgs = session.getMessages();

    // Mutate returned array
    msgs.push({ role: 'user', content: 'Injected' });
    msgs[0].content = 'Mutated content';

    // Internal state should be untouched
    const internalMsgs = session.getMessages();
    assert.equal(internalMsgs.length, 1);
    assert.equal(internalMsgs[0].content, 'Original');
  });

  test('default maxMessages is 20 when option omitted or invalid', () => {
    const defaultSession = new ConversationSession();
    assert.equal(defaultSession.maxMessages, 20);

    const invalidSession = new ConversationSession({ maxMessages: -5 });
    assert.equal(invalidSession.maxMessages, 20);
  });
});
