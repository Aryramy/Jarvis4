/**
 * Base Speech-to-Text Provider Contract for JARVIS4 (Brick 10).
 * Defines the standard interface that all STT provider adapters must implement.
 */

export class SpeechToTextProvider {
  /**
   * @param {string} [name='base-stt'] - Provider name
   */
  constructor(name = 'base-stt') {
    this.name = name;
  }

  /**
   * Transcribes audio data to text.
   *
   * @param {Buffer|Uint8Array|Blob} audioBytes - Audio data bytes
   * @param {Object} [metadata] - Optional audio metadata (mimeType, filename)
   * @param {string} [metadata.mimeType] - MIME type of the audio (e.g. 'audio/webm')
   * @param {string} [metadata.filename] - Audio filename
   * @param {Object} [options] - Additional provider-specific options
   * @returns {Promise<{ success: boolean, text?: string, durationMs?: number, model?: string, error?: string, language?: string }>}
   */
  async transcribe(audioBytes, metadata = {}, options = {}) {
    throw new Error(`transcribe() must be implemented by subclass ${this.constructor.name}`);
  }
}

export default SpeechToTextProvider;
