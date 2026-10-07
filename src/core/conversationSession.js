/**
 * ConversationSession for JARVIS4 (Brick 6).
 * Manages temporary in-memory conversation context for the running session.
 *
 * NOTE: This is SHORT-TERM in-memory context only. It is not persisted.
 */

const ALLOWED_ROLES = new Set(['user', 'assistant', 'system']);
const DEFAULT_MAX_MESSAGES = 20;

export class ConversationSession {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxMessages=20] - Maximum messages to retain in memory
   */
  constructor(options = {}) {
    const max = Number(options.maxMessages);
    this.maxMessages = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_MESSAGES;
    this.messages = [];
  }

  /**
   * Adds a message with specified role and content.
   *
   * @param {string} role - Message role ('user', 'assistant', 'system')
   * @param {string} content - Message content
   * @returns {{ role: string, content: string }}
   */
  addMessage(role, content) {
    if (typeof role !== 'string' || !ALLOWED_ROLES.has(role.trim().toLowerCase())) {
      throw new Error(`Invalid role: ${role}. Allowed roles: ${Array.from(ALLOWED_ROLES).join(', ')}`);
    }

    if (typeof content !== 'string') {
      throw new Error('Message content must be a string');
    }

    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      throw new Error('Message content cannot be empty');
    }

    const msg = {
      role: role.trim().toLowerCase(),
      content: trimmedContent
    };

    this.messages.push(msg);

    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }

    return msg;
  }

  /**
   * Adds a user message.
   *
   * @param {string} content
   * @returns {{ role: string, content: string }}
   */
  addUserMessage(content) {
    return this.addMessage('user', content);
  }

  /**
   * Adds an assistant message.
   *
   * @param {string} content
   * @returns {{ role: string, content: string }}
   */
  addAssistantMessage(content) {
    return this.addMessage('assistant', content);
  }

  /**
   * Returns a copy of current conversation messages.
   *
   * @returns {Array<{ role: string, content: string }>}
   */
  getMessages() {
    return this.messages.map(m => ({ ...m }));
  }

  /**
   * Clears all messages in this session.
   */
  clear() {
    this.messages = [];
  }

  /**
   * Removes and returns the last message (used for error rollback).
   *
   * @returns {{ role: string, content: string } | undefined}
   */
  pop() {
    return this.messages.pop();
  }

  /**
   * Loads and restores messages into this session.
   * Enforces role validation, content sanitization, and maximum history bound (FIFO).
   *
   * @param {Array<{ role: string, content: string }>} messages
   * @returns {number} The resulting message count
   */
  load(messages) {
    if (!Array.isArray(messages)) {
      throw new Error('Messages must be an array');
    }

    this.clear();
    for (const msg of messages) {
      if (msg && typeof msg === 'object') {
        this.addMessage(msg.role, msg.content);
      }
    }

    return this.messages.length;
  }

  /**
   * Returns current count of messages.
   * @returns {number}
   */
  get size() {
    return this.messages.length;
  }
}

export default ConversationSession;
