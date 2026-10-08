/**
 * OpenRouter Multilingual Text-to-Speech Provider Adapter for JARVIS4 (Brick 12).
 * Converts JARVIS text responses to multilingual speech audio bytes via OpenRouter /audio/speech.
 * Uses elevenlabs/eleven-v4-turbo with voice "george" and response_format "mp3".
 * The input text itself determines what language is spoken; no language parameter is sent.
 */

import { TextToSpeechProvider } from './textToSpeechBase.js';
import { config } from '../config/index.js';

export const DEFAULT_MAX_TEXT_LENGTH = 5000;

export class OpenRouterTextToSpeechProvider extends TextToSpeechProvider {
  /**
   * @param {Object} [options]
   * @param {string} [options.apiKey]
   * @param {string} [options.baseUrl]
   * @param {string} [options.model]
   * @param {string} [options.voice]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxTextLength]
   * @param {typeof fetch} [options.fetchFn]
   */
  constructor(options = {}) {
    super('openrouter-tts');

    const defaultCfg = config.openRouter || {};

    this.apiKey = options.apiKey ?? defaultCfg.apiKey ?? '';
    this.baseUrl = (options.baseUrl ?? defaultCfg.ttsBaseUrl ?? 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, '');
    this.model = options.model ?? defaultCfg.ttsModel ?? 'elevenlabs/eleven-v4-turbo';
    this.voice = options.voice ?? defaultCfg.ttsVoice ?? 'george';
    this.timeoutMs = Number(options.timeoutMs ?? defaultCfg.ttsTimeoutMs ?? 30000) || 30000;
    this.maxTextLength = Number(options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH) || DEFAULT_MAX_TEXT_LENGTH;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  /**
   * Validates configuration required to make external TTS calls.
   * @returns {{ valid: boolean, error?: string }}
   */
  validateConfig() {
    if (!this.apiKey || typeof this.apiKey !== 'string' || this.apiKey.trim().length === 0) {
      return { valid: false, error: 'OpenRouter API key is required' };
    }
    if (!this.model || typeof this.model !== 'string' || this.model.trim().length === 0) {
      return { valid: false, error: 'OpenRouter TTS model is required' };
    }
    if (!this.voice || typeof this.voice !== 'string' || this.voice.trim().length === 0) {
      return { valid: false, error: 'OpenRouter TTS voice is required' };
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
    const keyToRedact = this.apiKey || process.env.OPENROUTER_API_KEY;
    if (keyToRedact) {
      safe = safe.replaceAll(keyToRedact, '[REDACTED]');
    }
    return safe;
  }

  /**
   * Synthesizes text to speech audio bytes using OpenRouter /audio/speech.
   *
   * @param {string} text - Text to synthesize
   * @param {Object} [options] - Additional provider-specific options
   * @param {number} [options.timeoutMs] - Override timeout in milliseconds
   * @returns {Promise<{
   *   success: boolean,
   *   audioBytes?: Buffer,
   *   mimeType?: string,
   *   durationMs?: number,
   *   model?: string,
   *   voice?: string,
   *   error?: string
   * }>}
   */
  async synthesize(text, options = {}) {
    const startTime = Date.now();

    // 1. Reject missing text
    if (text === undefined || text === null) {
      return {
        success: false,
        error: 'Text input is required',
        durationMs: 0
      };
    }

    // 2. Reject non-string text
    if (typeof text !== 'string') {
      return {
        success: false,
        error: 'Text input must be a string',
        durationMs: 0
      };
    }

    // 3. Reject empty or whitespace-only text
    if (text.trim().length === 0) {
      return {
        success: false,
        error: 'Text input cannot be empty or whitespace-only',
        durationMs: 0
      };
    }

    // 4. Enforce reasonable maximum input length
    if (text.length > this.maxTextLength) {
      return {
        success: false,
        error: `Text input exceeds maximum allowed length of ${this.maxTextLength} characters`,
        durationMs: 0
      };
    }

    // 5. Validate configuration
    const configCheck = this.validateConfig();
    if (!configCheck.valid) {
      return {
        success: false,
        error: configCheck.error,
        durationMs: 0
      };
    }

    // 6. Construct JSON payload
    // CRITICAL: Language parameter is strictly omitted; input text itself determines language.
    const requestPayload = {
      model: this.model,
      input: text,
      voice: this.voice,
      response_format: 'mp3'
    };

    // 7. Setup timeout and controller
    const endpoint = `${this.baseUrl}/audio/speech`;
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
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal
      });

      const durationMs = Math.max(0, Date.now() - startTime);

      // 8. Handle HTTP errors
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
        return {
          success: false,
          error: `Provider HTTP ${response.status}: ${safeError || response.statusText}`,
          durationMs
        };
      }

      // 9. Read binary audio response
      let arrayBuffer;
      try {
        arrayBuffer = await response.arrayBuffer();
      } catch (err) {
        return {
          success: false,
          error: `Malformed response from provider: failed to read binary audio (${err.message})`,
          durationMs
        };
      }

      const audioBuffer = Buffer.from(arrayBuffer);

      // 10. Reject empty audio responses
      if (!audioBuffer || audioBuffer.length === 0) {
        return {
          success: false,
          error: 'Provider returned empty audio response (0 bytes)',
          durationMs
        };
      }

      const responseContentType = (typeof response.headers?.get === 'function' && response.headers.get('content-type')) || 'audio/mpeg';
      const cleanMime = responseContentType.split(';')[0].trim().toLowerCase() || 'audio/mpeg';

      return {
        success: true,
        audioBytes: audioBuffer,
        mimeType: cleanMime,
        durationMs,
        model: this.model,
        voice: this.voice
      };
    } catch (err) {
      const durationMs = Math.max(0, Date.now() - startTime);
      if (err.name === 'AbortError' || controller.signal.aborted) {
        return {
          success: false,
          error: `Request timed out after ${timeout}ms`,
          durationMs
        };
      }
      return {
        success: false,
        error: `Network error: ${this.sanitizeError(err.message)}`,
        durationMs
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}

export default OpenRouterTextToSpeechProvider;
