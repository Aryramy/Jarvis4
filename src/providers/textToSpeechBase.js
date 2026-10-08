/**
 * Base Text-to-Speech Provider Contract for JARVIS4 (Brick 12).
 * Defines the standard interface that all TTS provider adapters must implement.
 */

export class TextToSpeechProvider {
  /**
   * @param {string} [name='base-tts'] - Provider name
   */
  constructor(name = 'base-tts') {
    this.name = name;
  }

  /**
   * Synthesizes text to speech audio bytes.
   *
   * @param {string} text - Text to synthesize
   * @param {Object} [options] - Additional provider-specific options
   * @returns {Promise<{
   *   success: boolean,
   *   audioBytes?: Buffer|Uint8Array,
   *   mimeType?: string,
   *   durationMs?: number,
   *   model?: string,
   *   voice?: string,
   *   error?: string
   * }>}
   */
  async synthesize(text, options = {}) {
    throw new Error(`synthesize() must be implemented by subclass ${this.constructor.name}`);
  }
}

export default TextToSpeechProvider;
