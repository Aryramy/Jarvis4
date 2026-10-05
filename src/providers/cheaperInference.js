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
   * Sanitizes error messages ensuring API key is never leaked.
   * @param {string} message
   * @returns {string}
   */
  sanitizeError(message) {
    if (!message || typeof message !== 'string') return '';
    let safe = message;
    const keyToRedact = this.apiKey || process.env.CHEAPER_INFERENCE_API_KEY;
    if (keyToRedact) {
      safe = safe.replaceAll(keyToRedact, '[REDACTED]');
    }
    return safe;
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
        const safeError = this.sanitizeError(errorDetail || response.statusText);
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
        error: `Network error: ${this.sanitizeError(err.message)}`
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Streams a text response from the hosted Cheaper Inference provider as an async generator of text deltas.
   *
   * @param {string} prompt - Prompt to stream response for
   * @param {Object} [options]
   * @param {number} [options.timeoutMs] - Override timeout in milliseconds
   * @returns {AsyncGenerator<string, void, unknown>}
   */
  async *stream(prompt, options = {}) {
    // 1. Validate prompt
    if (typeof prompt !== 'string') {
      throw new Error('Prompt must be a string');
    }

    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length === 0) {
      throw new Error('Prompt cannot be empty');
    }

    // 2. Validate configuration
    const configCheck = this.validateConfig();
    if (!configCheck.valid) {
      throw new Error(configCheck.error);
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

    let completed = false;

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
          ],
          stream: true
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
        const safeError = this.sanitizeError(errorDetail || response.statusText);
        throw new Error(`Provider HTTP ${response.status}: ${safeError}`);
      }

      if (!response.body) {
        throw new Error('Malformed response from provider: missing response body');
      }

      let streamSource = response.body;
      if (typeof response.body.getReader === 'function' && !response.body[Symbol.asyncIterator]) {
        streamSource = (async function* () {
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              yield value;
            }
          } finally {
            reader.releaseLock();
          }
        })();
      }

      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      for await (const rawChunk of streamSource) {
        const text = typeof rawChunk === 'string' ? rawChunk : decoder.decode(rawChunk, { stream: true });
        buffer += text;

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) {
            // Keep-alive or comment
            continue;
          }

          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') {
              completed = true;
              return;
            }

            let parsed;
            try {
              parsed = JSON.parse(dataStr);
            } catch {
              // Ignore malformed event JSON safely
              continue;
            }

            const content = parsed.choices?.[0]?.delta?.content;
            if (typeof content === 'string' && content.length > 0) {
              yield content;
            }
          }
        }
      }

      // Process any trailing buffered line
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') {
            completed = true;
            return;
          }
          try {
            const parsed = JSON.parse(dataStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (typeof content === 'string' && content.length > 0) {
              yield content;
            }
          } catch {
            // Ignore malformed event JSON safely
          }
        }
      }

      completed = true;
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new Error(`Request timed out after ${timeout}ms`);
      }
      if (err.message && err.message.startsWith('Provider HTTP')) {
        throw err;
      }
      const safeError = this.sanitizeError(err.message);
      throw new Error(`Network error: ${safeError}`);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (!completed && !controller.signal.aborted) {
        controller.abort();
      }
    }
  }
}

export default CheaperInferenceProvider;
