/**
 * Cheaper Inference / OmniRoute Provider Adapter for JARVIS4 (Brick 3).
 * Connects to OpenAI-compatible hosted API endpoints.
 */

import { AIProvider } from './base.js';
import { config } from '../config/index.js';

export class CheaperInferenceProvider extends AIProvider {
  /**
   * @param {Object} [options]
   * @param {string} [options.apiKey]
   * @param {string} [options.baseUrl]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchFn]
   */
  constructor(options = {}) {
    super('cheaper-inference');

    const defaultCfg = config.cheaperInference || {};

    this.apiKey = options.apiKey ?? defaultCfg.apiKey ?? '';
    this.baseUrl = (options.baseUrl ?? defaultCfg.baseUrl ?? 'https://api.cheaperinference.com/v1').trim().replace(/\/+$/, '');
    this.model = options.model ?? defaultCfg.model ?? '';
    this.timeoutMs = Number(options.timeoutMs ?? defaultCfg.timeoutMs ?? 30000) || 30000;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  /**
   * Validates configuration required to make external calls.
   * @returns {{ valid: boolean, error?: string }}
   */
  validateConfig() {
    if (!this.apiKey || typeof this.apiKey !== 'string' || this.apiKey.trim().length === 0) {
      return { valid: false, error: 'Cheaper Inference API key is required' };
    }
    if (!this.model || typeof this.model !== 'string' || this.model.trim().length === 0) {
      return { valid: false, error: 'Cheaper Inference model is required' };
    }
    return { valid: true };
  }

  /**
   * Generates a text response from the hosted Cheaper Inference provider.
   *
   * @param {string} prompt - Prompt to generate response for
   * @param {Object} [options]
   * @param {number} [options.timeoutMs] - Override timeout in milliseconds
   * @returns {Promise<{ success: boolean, text?: string, model?: string, error?: string, usage?: object }>}
   */
  async generate(prompt, options = {}) {
    // 1. Validate prompt
    if (typeof prompt !== 'string') {
      return { success: false, error: 'Prompt must be a string' };
    }

    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length === 0) {
      return { success: false, error: 'Prompt cannot be empty' };
    }

    // 2. Validate configuration
    const configCheck = this.validateConfig();
    if (!configCheck.valid) {
      return { success: false, error: configCheck.error };
    }

    // 3. Prepare HTTP request
    const endpoint = `${this.baseUrl}/chat/completions`;
    const timeout = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timeoutId = null;

    if (timeout > 0 && typeof setTimeout === 'function') {
      timeoutId = setTimeout(() => {
        controller.abort(new Error(`Request timed out after ${timeout}ms`));
      }, timeout);
    }

    try {
      const response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'user', content: trimmedPrompt }
          ]
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        let errorDetail = '';
        try {
          const errorJson = await response.json();
          errorDetail = errorJson.error?.message || errorJson.message || JSON.stringify(errorJson);
        } catch {
          try {
            errorDetail = await response.text();
          } catch {
            errorDetail = response.statusText || 'Unknown error';
          }
        }
        // Sanitize: ensure API key is never leaked
        const safeError = errorDetail.replaceAll(this.apiKey, '[REDACTED]');
        return {
          success: false,
          error: `Provider HTTP ${response.status}: ${safeError || response.statusText}`
        };
      }

      let data;
      try {
        data = await response.json();
      } catch (err) {
        return {
          success: false,
          error: `Malformed response from provider: failed to parse JSON (${err.message})`
        };
      }

      if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
        return {
          success: false,
          error: 'Malformed response from provider: missing choices array'
        };
      }

      const firstChoice = data.choices[0];
      const assistantMessage = firstChoice?.message?.content;

      if (typeof assistantMessage !== 'string') {
        return {
          success: false,
          error: 'Malformed response from provider: missing message content'
        };
      }

      return {
        success: true,
        text: assistantMessage,
        model: data.model || this.model,
        usage: data.usage || null
      };
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        return {
          success: false,
          error: `Request timed out after ${timeout}ms`
        };
      }
      return {
        success: false,
        error: `Network error: ${err.message}`
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}

export default CheaperInferenceProvider;
