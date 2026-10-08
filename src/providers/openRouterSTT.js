/**
 * OpenRouter Multilingual Speech-to-Text Provider Adapter for JARVIS4 (Brick 10).
 * Connects browser audio recordings to OpenRouter /audio/transcriptions using openai/whisper-large-v3-turbo.
 */

import { SpeechToTextProvider } from './speechToTextBase.js';
import { config } from '../config/index.js';

export class OpenRouterSpeechToTextProvider extends SpeechToTextProvider {
  /**
   * @param {Object} [options]
   * @param {string} [options.apiKey]
   * @param {string} [options.baseUrl]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchFn]
   */
  constructor(options = {}) {
    super('openrouter-stt');

    const defaultCfg = config.openRouter || {};

    this.apiKey = options.apiKey ?? defaultCfg.apiKey ?? '';
    this.baseUrl = (options.baseUrl ?? defaultCfg.sttBaseUrl ?? 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, '');
    this.model = options.model ?? defaultCfg.sttModel ?? 'openai/whisper-large-v3-turbo';
    this.timeoutMs = Number(options.timeoutMs ?? defaultCfg.timeoutMs ?? 30000) || 30000;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  /**
   * Validates configuration required to make external STT calls.
   * @returns {{ valid: boolean, error?: string }}
   */
  validateConfig() {
    if (!this.apiKey || typeof this.apiKey !== 'string' || this.apiKey.trim().length === 0) {
      return { valid: false, error: 'OpenRouter API key is required' };
    }
    if (!this.model || typeof this.model !== 'string' || this.model.trim().length === 0) {
      return { valid: false, error: 'OpenRouter STT model is required' };
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
   * Transcribes audio data to text using OpenRouter /audio/transcriptions.
   *
   * @param {Buffer|Uint8Array|Blob|ArrayBuffer} audioBytes - Raw audio data
   * @param {Object} [metadata] - Audio metadata
   * @param {string} [metadata.mimeType] - Audio MIME type (e.g. 'audio/webm')
   * @param {string} [metadata.filename] - Audio filename
   * @param {Object} [options] - Additional call options
   * @param {number} [options.timeoutMs] - Override timeout in milliseconds
   * @returns {Promise<{ success: boolean, text?: string, durationMs?: number, model?: string, error?: string, language?: string }>}
   */
  async transcribe(audioBytes, metadata = {}, options = {}) {
    const startTime = Date.now();

    // 1. Validate audio exists
    if (audioBytes === undefined || audioBytes === null) {
      return {
        success: false,
        error: 'Audio data is required',
        durationMs: 0
      };
    }

    // 2. Reject zero-byte audio
    let byteLength = 0;
    if (typeof Blob !== 'undefined' && audioBytes instanceof Blob) {
      byteLength = audioBytes.size;
    } else if (Buffer.isBuffer(audioBytes) || audioBytes instanceof Uint8Array) {
      byteLength = audioBytes.byteLength ?? audioBytes.length;
    } else if (audioBytes instanceof ArrayBuffer) {
      byteLength = audioBytes.byteLength;
    } else {
      return {
        success: false,
        error: 'Audio data must be a Buffer, Uint8Array, or Blob',
        durationMs: 0
      };
    }

    if (byteLength === 0) {
      return {
        success: false,
        error: 'Audio data cannot be empty (0 bytes)',
        durationMs: 0
      };
    }

    // 3. Validate acceptable MIME/file metadata
    let mimeType = metadata.mimeType;
    if (!mimeType && typeof Blob !== 'undefined' && audioBytes instanceof Blob && audioBytes.type) {
      mimeType = audioBytes.type;
    }
    if (!mimeType) {
      mimeType = 'audio/webm';
    }

    if (typeof mimeType !== 'string' || !mimeType.toLowerCase().startsWith('audio/')) {
      return {
        success: false,
        error: `Invalid audio MIME type: "${mimeType}". Must be an audio MIME type.`,
        durationMs: 0
      };
    }

    const cleanMime = mimeType.split(';')[0].trim().toLowerCase();
    let filename = metadata.filename;
    if (!filename) {
      const extMap = {
        'audio/webm': 'recording.webm',
        'audio/ogg': 'recording.ogg',
        'audio/mp4': 'recording.mp4',
        'audio/wav': 'recording.wav',
        'audio/wave': 'recording.wav',
        'audio/x-wav': 'recording.wav',
        'audio/mpeg': 'recording.mp3',
        'audio/mp3': 'recording.mp3',
        'audio/aac': 'recording.aac',
        'audio/m4a': 'recording.m4a',
        'audio/x-m4a': 'recording.m4a',
        'audio/flac': 'recording.flac'
      };
      filename = extMap[cleanMime] || 'recording.webm';
    }

    // 4. Validate configuration
    const configCheck = this.validateConfig();
    if (!configCheck.valid) {
      return {
        success: false,
        error: configCheck.error,
        durationMs: 0
      };
    }

    // 5. Construct multipart/form-data
    const formData = new FormData();
    const audioBlob = (typeof Blob !== 'undefined' && audioBytes instanceof Blob)
      ? audioBytes
      : new Blob([audioBytes], { type: mimeType });

    formData.append('file', audioBlob, filename);
    formData.append('model', this.model);
    // CRITICAL: Language parameter is strictly omitted by default to allow automatic multilingual detection

    // 6. Setup timeout and controller
    const endpoint = `${this.baseUrl}/audio/transcriptions`;
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
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: formData,
        signal: controller.signal
      });

      const durationMs = Math.max(0, Date.now() - startTime);

      // 7. Handle HTTP errors
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

      // 8. Parse returned transcript JSON
      let data;
      try {
        data = await response.json();
      } catch (err) {
        return {
          success: false,
          error: `Malformed response from provider: failed to parse JSON (${err.message})`,
          durationMs
        };
      }

      if (!data || typeof data !== 'object') {
        return {
          success: false,
          error: 'Malformed response from provider: expected JSON object',
          durationMs
        };
      }

      if (typeof data.text !== 'string') {
        return {
          success: false,
          error: 'Malformed response from provider: missing text property',
          durationMs
        };
      }

      const result = {
        success: true,
        text: data.text,
        durationMs,
        model: this.model
      };

      if (typeof data.language === 'string' && data.language.trim().length > 0) {
        result.language = data.language.trim();
      }

      return result;
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

export default OpenRouterSpeechToTextProvider;
