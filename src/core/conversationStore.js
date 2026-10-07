/**
 * ConversationStore for JARVIS4 (Brick 8).
 * Manages minimal local JSON file persistence for conversation messages across server restarts.
 *
 * NOTE: This is local development persistence only. Not an encrypted database or cloud sync.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  existsSync,
  mkdirSync
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { logger as defaultLogger } from '../utils/logger.js';

const ALLOWED_ROLES = new Set(['user', 'assistant', 'system']);
const STORE_VERSION = 1;

export class ConversationStore {
  /**
   * @param {Object} [options]
   * @param {string} [options.filePath] - Absolute or relative path to persistence JSON file
   * @param {Object} [options.logger] - Logger instance
   */
  constructor(options = {}) {
    this.filePath = options.filePath
      ? resolve(options.filePath)
      : resolve(process.env.CONVERSATION_STORE_PATH || resolve(process.cwd(), 'runtime', 'conversation.json'));
    this.logger = options.logger || defaultLogger;
  }

  /**
   * Loads persisted conversation messages from disk.
   * If the file does not exist, returns empty array.
   * If the file is malformed or corrupted, logs a warning and returns empty array safely without crashing.
   *
   * @returns {Array<{ role: string, content: string }>}
   */
  load() {
    if (!existsSync(this.filePath)) {
      return [];
    }

    let rawContent;
    try {
      rawContent = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      this.logger.warn(`Failed to read conversation file: ${err.message}`);
      return [];
    }

    if (!rawContent || !rawContent.trim()) {
      return [];
    }

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      this.logger.warn('Corrupted conversation persistence file: malformed JSON content');
      return [];
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.logger.warn('Corrupted conversation persistence file: root is not a valid JSON object');
      return [];
    }

    if (typeof parsed.version !== 'number' || parsed.version < 1) {
      this.logger.warn('Corrupted conversation persistence file: missing or invalid version property');
      return [];
    }

    if (!Array.isArray(parsed.messages)) {
      this.logger.warn('Corrupted conversation persistence file: messages property is not an array');
      return [];
    }

    const validMessages = [];
    for (const item of parsed.messages) {
      if (!item || typeof item !== 'object') {
        this.logger.warn('Corrupted conversation persistence file: message item is not an object');
        return [];
      }

      const role = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
      const content = typeof item.content === 'string' ? item.content.trim() : '';

      if (!ALLOWED_ROLES.has(role) || content.length === 0) {
        this.logger.warn('Corrupted conversation persistence file: message item has invalid role or empty content');
        return [];
      }

      validMessages.push({ role, content });
    }

    return validMessages;
  }

  /**
   * Atomically saves messages to the persistence JSON file.
   *
   * @param {Array<{ role: string, content: string }>} messages
   * @returns {boolean}
   */
  save(messages) {
    if (!Array.isArray(messages)) {
      throw new Error('Messages to save must be an array');
    }

    const sanitizedMessages = messages.map(m => {
      if (!m || typeof m !== 'object') {
        throw new Error('Invalid message item in array');
      }
      const role = typeof m.role === 'string' ? m.role.trim().toLowerCase() : '';
      const content = typeof m.content === 'string' ? m.content.trim() : '';

      if (!ALLOWED_ROLES.has(role)) {
        throw new Error(`Invalid message role: ${m.role}`);
      }
      if (content.length === 0) {
        throw new Error('Message content cannot be empty');
      }

      return { role, content };
    });

    const data = {
      version: STORE_VERSION,
      messages: sanitizedMessages
    };

    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${this.filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');

    try {
      renameSync(tempPath, this.filePath);
    } catch {
      // Fallback for Windows file locks or cross-volume operations
      try {
        copyFileSync(tempPath, this.filePath);
        unlinkSync(tempPath);
      } catch (fallbackErr) {
        if (existsSync(tempPath)) {
          try { unlinkSync(tempPath); } catch {}
        }
        throw fallbackErr;
      }
    }

    return true;
  }

  /**
   * Clears persisted conversation state by removing the storage file.
   *
   * @returns {boolean}
   */
  clear() {
    if (existsSync(this.filePath)) {
      try {
        unlinkSync(this.filePath);
      } catch (err) {
        this.logger.warn(`Failed to remove conversation persistence file: ${err.message}`);
        return false;
      }
    }
    return true;
  }
}

export default ConversationStore;
