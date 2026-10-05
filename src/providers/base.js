/**
 * Base AI Provider Contract for JARVIS4.
 * Defines the standard interface that all AI provider adapters must implement.
 */

export class AIProvider {
  /**
   * @param {string} [name='base'] - Provider name
   */
  constructor(name = 'base') {
    this.name = name;
  }

  /**
   * Generates a text response for the given prompt.
   *
   * @param {string} prompt - Text prompt
   * @param {Object} [options] - Additional provider options
   * @returns {Promise<{ success: boolean, text?: string, model?: string, error?: string, usage?: object }>}
   */
  async generate(prompt, options = {}) {
    throw new Error(`generate() must be implemented by subclass ${this.constructor.name}`);
  }

  /**
   * Streams a text response for the given prompt as an async generator of text deltas.
   *
   * @param {string} prompt - Text prompt
   * @param {Object} [options] - Additional provider options
   * @returns {AsyncGenerator<string, void, unknown>}
   */
  async *stream(prompt, options = {}) {
    throw new Error(`stream() must be implemented by subclass ${this.constructor.name}`);
  }
}

export default AIProvider;
