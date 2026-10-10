/**
 * Base Search Provider Contract for JARVIS4 (Brick 19).
 * Defines the standard interface that all web search provider adapters must implement.
 */

export class SearchProvider {
  /**
   * @param {string} [name='base-search'] - Provider name
   */
  constructor(name = 'base-search') {
    this.name = name;
  }

  /**
   * Performs web search and generates a grounded response.
   *
   * @param {string} prompt - Query / prompt for search
   * @param {Object} [options] - Additional provider-specific options
   * @returns {Promise<{
   *   success: boolean,
   *   text?: string,
   *   response?: string,
   *   provider?: string,
   *   model?: string,
   *   searchUsed: boolean,
   *   searchRequests: number|null,
   *   searchEvidence?: string,
   *   currentDate?: string,
   *   freshnessSensitive?: boolean,
   *   newestSourceDate?: string|null,
   *   freshnessStatus?: string,
   *   providerFinishReason?: string|null,
   *   hasMessage?: boolean,
   *   hasMessageContent?: boolean,
   *   contentType?: string,
   *   hasToolCalls?: boolean,
   *   hasReasoning?: boolean,
   *   annotationCount?: number,
   *   sources: Array<{ title: string, url: string, content?: string, publishedDate?: string|null }>,
   *   providerSearchDurationMs?: number,
   *   providerDurationMs?: number,
   *   error?: string
   * }>}
   */
  async search(prompt, options = {}) {
    throw new Error(`search() must be implemented by subclass ${this.constructor.name}`);
  }
}

export default SearchProvider;
