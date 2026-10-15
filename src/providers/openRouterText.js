/**
 * OpenRouter Production Text AI Provider Adapter for JARVIS4 (Brick 17 & PRE-040B).
 * Connects to OpenRouter OpenAI-compatible /chat/completions endpoint
 * with deterministic profile routing (FAST, REASONING), OpenRouter provider failover,
 * native model fallback, and telemetry capture.
 */

import { AIProvider } from './base.js';
import { config as defaultAppConfig } from '../config/index.js';
import {
  ROUTING_PROFILES,
  ROUTING_MODES,
  sanitizeError as sanitizeErrorUtil
} from './openRouterRouting.js';
import { OpenRouterRoutingGate } from './openRouterRouter.js';

export class OpenRouterTextProvider extends AIProvider {
  /**
   * @param {Object} [options]
   * @param {string} [options.apiKey]
   * @param {string} [options.baseUrl]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchFn]
   * @param {Object} [options.config]
   */
  constructor(options = {}) {
    super('openrouter-text');

    const defaultCfg = (options.config || defaultAppConfig).openRouter || {};

    this.config = options.config || defaultAppConfig;
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? defaultCfg.apiKey ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.OPENROUTER_TEXT_BASE_URL ?? defaultCfg.textBaseUrl ?? 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, '');
    this.model = options.model ?? process.env.OPENROUTER_FAST_MODEL ?? process.env.OPENROUTER_TEXT_MODEL ?? defaultCfg.fastModel ?? defaultCfg.textModel ?? 'deepseek/deepseek-v4-flash-0731';
    this.timeoutMs = Number(options.timeoutMs ?? process.env.OPENROUTER_FAST_TIMEOUT_MS ?? process.env.OPENROUTER_TEXT_TIMEOUT_MS ?? defaultCfg.fastTimeoutMs ?? defaultCfg.textTimeoutMs ?? 30000) || 30000;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.lastTelemetry = null;
  }

  /**
   * Validates configuration required to make external calls.
   * @returns {{ valid: boolean, error?: string }}
   */
  validateConfig() {
    if (!this.apiKey || typeof this.apiKey !== 'string' || this.apiKey.trim().length === 0) {
      return { valid: false, error: 'OpenRouter API key is required' };
    }
    if (!this.model || typeof this.model !== 'string' || this.model.trim().length === 0) {
      return { valid: false, error: 'OpenRouter text model is required' };
    }
    return { valid: true };
  }

  /**
   * Sanitizes error messages ensuring API key is never leaked.
   * @param {string} message
   * @returns {string}
   */
  sanitizeError(message) {
    return sanitizeErrorUtil(message, this.apiKey);
  }

  /**
   * Builds an effective configuration object for the routing gate.
   * @private
   */
  _buildGateConfig() {
    const baseOpenRouter = this.config.openRouter || {};
    return {
      ...this.config,
      openRouter: {
        ...baseOpenRouter,
        apiKey: this.apiKey,
        textBaseUrl: this.baseUrl,
        fastModel: this.model,
        fastTimeoutMs: this.timeoutMs
      }
    };
  }

  /**
   * Generates a text response for conversation messages from OpenRouter via routing gate.
   *
   * @param {Array<{ role: string, content: string }>} messages - Conversation message history
   * @param {Object} [options]
   * @param {'FAST'|'REASONING'} [options.profile='FAST'] - Routing profile
   * @param {string} [options.sessionId] - Optional opaque session ID
   * @param {number} [options.timeoutMs] - Override timeout in milliseconds
   * @returns {Promise<{
   *   success: boolean,
   *   text?: string,
   *   model?: string,
   *   actualModel?: string|null,
   *   provider?: string,
   *   error?: string,
   *   errorCode?: string,
   *   usage?: object|null,
   *   cost?: number|null,
   *   telemetry?: object,
   *   providerDurationMs?: number
   * }>}
   */
  async generateMessages(messages, options = {}) {
    // 1. Validate messages
    if (!Array.isArray(messages) || messages.length === 0) {
      return { success: false, error: 'Messages must be a non-empty array' };
    }

    const formattedMessages = [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object' || typeof msg.role !== 'string' || typeof msg.content !== 'string') {
        return { success: false, error: 'Each message must have a valid role and content string' };
      }
      const trimmedContent = msg.content.trim();
      if (trimmedContent.length === 0) {
        return { success: false, error: 'Message content cannot be empty' };
      }
      formattedMessages.push({
        role: msg.role.trim().toLowerCase(),
        content: trimmedContent
      });
    }

    // 2. Validate configuration
    const configCheck = this.validateConfig();
    if (!configCheck.valid) {
      return { success: false, error: configCheck.error };
    }

    // 3. Delegate to OpenRouterRoutingGate
    const gate = new OpenRouterRoutingGate({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      fetchFn: this.fetchFn,
      config: this._buildGateConfig()
    });

    const result = await gate.complete({
      profile: options.profile || ROUTING_PROFILES.FAST,
      messages: formattedMessages,
      sessionId: options.sessionId,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      maxTokens: options.maxTokens ?? options.max_tokens,
      temperature: options.temperature
    });

    this.lastTelemetry = result.telemetry;

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        errorCode: result.errorCode,
        telemetry: result.telemetry,
        providerDurationMs: result.providerDurationMs
      };
    }

    return {
      success: true,
      text: result.text,
      model: result.model,
      actualModel: result.actualModel,
      provider: result.provider || 'openrouter',
      usage: result.usage || null,
      cost: result.cost,
      telemetry: result.telemetry,
      providerDurationMs: result.providerDurationMs
    };
  }

  /**
   * Generates a text response from OpenRouter for a single prompt string.
   *
   * @param {string} prompt - Prompt to generate response for
   * @param {Object} [options]
   * @param {'FAST'|'REASONING'} [options.profile='FAST']
   * @param {string} [options.sessionId]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{ success: boolean, text?: string, model?: string, provider?: string, error?: string, usage?: object, providerDurationMs?: number }>}
   */
  async generate(prompt, options = {}) {
    if (typeof prompt !== 'string') {
      return { success: false, error: 'Prompt must be a string' };
    }

    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length === 0) {
      return { success: false, error: 'Prompt cannot be empty' };
    }

    return this.generateMessages([{ role: 'user', content: trimmedPrompt }], options);
  }

  /**
   * Streams a text response for conversation messages from OpenRouter via routing gate.
   *
   * @param {Array<{ role: string, content: string }>} messages - Conversation message history
   * @param {Object} [options]
   * @param {'FAST'|'REASONING'} [options.profile='FAST']
   * @param {string} [options.sessionId]
   * @param {number} [options.timeoutMs]
   * @returns {AsyncGenerator<string, void, unknown>}
   */
  async *streamMessages(messages, options = {}) {
    // 1. Validate messages
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('Messages must be a non-empty array');
    }

    const formattedMessages = [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object' || typeof msg.role !== 'string' || typeof msg.content !== 'string') {
        throw new Error('Each message must have a valid role and content string');
      }
      const trimmedContent = msg.content.trim();
      if (trimmedContent.length === 0) {
        throw new Error('Message content cannot be empty');
      }
      formattedMessages.push({
        role: msg.role.trim().toLowerCase(),
        content: trimmedContent
      });
    }

    // 2. Validate configuration
    const configCheck = this.validateConfig();
    if (!configCheck.valid) {
      throw new Error(configCheck.error);
    }

    // 3. Delegate to OpenRouterRoutingGate
    const gate = new OpenRouterRoutingGate({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      fetchFn: this.fetchFn,
      config: this._buildGateConfig()
    });

    yield* gate.stream({
      profile: options.profile || ROUTING_PROFILES.FAST,
      messages: formattedMessages,
      sessionId: options.sessionId,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      maxTokens: options.maxTokens ?? options.max_tokens,
      temperature: options.temperature
    });

    this.lastTelemetry = gate.getLastTelemetry();
  }

  /**
   * Streams a text response from OpenRouter for a prompt string.
   *
   * @param {string} prompt - Prompt to stream response for
   * @param {Object} [options]
   * @param {'FAST'|'REASONING'} [options.profile='FAST']
   * @param {string} [options.sessionId]
   * @param {number} [options.timeoutMs]
   * @returns {AsyncGenerator<string, void, unknown>}
   */
  async *stream(prompt, options = {}) {
    if (typeof prompt !== 'string') {
      throw new Error('Prompt must be a string');
    }

    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length === 0) {
      throw new Error('Prompt cannot be empty');
    }

    yield* this.streamMessages([{ role: 'user', content: trimmedPrompt }], options);
  }

  /**
   * Returns last captured telemetry record.
   * @returns {Object|null}
   */
  getLastTelemetry() {
    return this.lastTelemetry;
  }
}

export default OpenRouterTextProvider;
