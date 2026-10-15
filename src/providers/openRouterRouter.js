/**
 * OpenRouter Routing Gate for JARVIS4 (PRE-040B).
 * Bounded routing execution gate enforcing application-controlled profile routing,
 * OpenRouter provider failover, native model fallback, and sanitized telemetry.
 */

import { config as defaultAppConfig } from '../config/index.js';
import {
  ROUTING_PROFILES,
  ROUTING_MODES,
  buildRoutingRequest,
  buildTelemetry,
  classifyProviderError,
  sanitizeError
} from './openRouterRouting.js';

export class OpenRouterRoutingGate {
  /**
   * @param {Object} [options]
   * @param {string} [options.apiKey]
   * @param {string} [options.baseUrl]
   * @param {Object} [options.config]
   * @param {typeof fetch} [options.fetchFn]
   */
  constructor(options = {}) {
    this.config = options.config || defaultAppConfig;
    const openRouterCfg = this.config.openRouter || {};

    this.apiKey = (options.apiKey ?? process.env.OPENROUTER_API_KEY ?? openRouterCfg.apiKey ?? '').trim();
    this.baseUrl = (options.baseUrl ?? process.env.OPENROUTER_TEXT_BASE_URL ?? openRouterCfg.textBaseUrl ?? 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, '');
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.lastTelemetry = null;
  }

  /**
   * Validates configuration required to dispatch requests.
   * @returns {{ valid: boolean, error?: string }}
   */
  validateConfig() {
    if (!this.apiKey || typeof this.apiKey !== 'string' || this.apiKey.trim().length === 0) {
      return { valid: false, error: 'OpenRouter API key is required' };
    }
    return { valid: true };
  }

  /**
   * Executes a complete request through the OpenRouter Routing Gate.
   *
   * @param {Object} params
   * @param {'FAST'|'REASONING'} [params.profile='FAST'] - Selected routing profile
   * @param {Array<{ role: string, content: string }>} params.messages - Conversation messages
   * @param {string} [params.sessionId] - Optional safe opaque session ID
   * @param {number} [params.timeoutMs] - Optional timeout clamp
   * @returns {Promise<{
   *   success: boolean,
   *   text?: string,
   *   model?: string,
   *   actualModel?: string|null,
   *   provider?: string|null,
   *   usage?: object|null,
   *   cost?: number|null,
   *   telemetry: object,
   *   providerDurationMs: number,
   *   error?: string,
   *   errorCode?: string
   * }>}
   */
  async complete(params = {}) {
    const configCheck = this.validateConfig();
    if (!configCheck.valid) {
      const errorObj = {
        code: 'OPENROUTER_AUTH_FAILED',
        message: configCheck.error
      };
      const dummyReq = {
        profile: params.profile || ROUTING_PROFILES.FAST,
        routingMode: ROUTING_MODES.PINNED_FALLBACK,
        requestedModel: 'unknown',
        requestedModels: ['unknown'],
        timeoutMs: 0
      };
      const telemetry = buildTelemetry({
        routingRequest: dummyReq,
        durationMs: 0,
        success: false,
        error: errorObj
      });
      return {
        success: false,
        error: configCheck.error,
        errorCode: errorObj.code,
        telemetry,
        providerDurationMs: 0
      };
    }

    let routingRequest;
    try {
      routingRequest = buildRoutingRequest({
        ...params,
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        config: this.config,
        stream: false
      });
    } catch (err) {
      const classified = classifyProviderError(err, null, this.apiKey);
      const dummyReq = {
        profile: params.profile || ROUTING_PROFILES.FAST,
        routingMode: ROUTING_MODES.PINNED_FALLBACK,
        requestedModel: 'unknown',
        requestedModels: ['unknown'],
        timeoutMs: 0
      };
      const telemetry = buildTelemetry({
        routingRequest: dummyReq,
        durationMs: 0,
        success: false,
        error: classified
      });
      return {
        success: false,
        error: classified.message,
        errorCode: classified.code,
        telemetry,
        providerDurationMs: 0
      };
    }

    const timeout = params.timeoutMs ?? routingRequest.timeoutMs;
    const controller = new AbortController();
    let timeoutId = null;

    if (timeout > 0 && typeof setTimeout === 'function') {
      timeoutId = setTimeout(() => {
        controller.abort(new Error(`Request timed out after ${timeout}ms`));
      }, timeout);
    }

    const reqStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    const getElapsedMs = () => {
      const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
      return Math.max(0, Math.round(now - reqStartTime));
    };

    try {
      const response = await this.fetchFn(routingRequest.endpoint, {
        method: 'POST',
        headers: routingRequest.headers,
        body: JSON.stringify(routingRequest.body),
        signal: controller.signal
      });

      const elapsedMs = getElapsedMs();

      if (!response.ok) {
        let rawError = '';
        try {
          const errJson = await response.json();
          rawError = errJson.error?.message || errJson.message || JSON.stringify(errJson);
        } catch {
          try {
            rawError = await response.text();
          } catch {
            rawError = response.statusText || 'Unknown error';
          }
        }
        const classified = classifyProviderError(new Error(rawError), response.status, this.apiKey);
        const telemetry = buildTelemetry({
          routingRequest,
          durationMs: elapsedMs,
          success: false,
          error: classified
        });
        this.lastTelemetry = telemetry;
        return {
          success: false,
          error: `Provider HTTP ${response.status}: ${classified.message}`,
          errorCode: classified.code,
          telemetry,
          providerDurationMs: elapsedMs
        };
      }

      let data;
      try {
        data = await response.json();
      } catch (err) {
        const classified = classifyProviderError(err, response.status, this.apiKey);
        const telemetry = buildTelemetry({
          routingRequest,
          durationMs: elapsedMs,
          success: false,
          error: classified
        });
        this.lastTelemetry = telemetry;
        return {
          success: false,
          error: `Malformed response from provider: failed to parse JSON (${classified.message})`,
          errorCode: classified.code,
          telemetry,
          providerDurationMs: elapsedMs
        };
      }

      if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
        const errorObj = {
          code: 'OPENROUTER_BAD_REQUEST',
          message: 'Malformed response from provider: missing choices array'
        };
        const telemetry = buildTelemetry({
          routingRequest,
          responseData: data,
          durationMs: elapsedMs,
          success: false,
          error: errorObj
        });
        this.lastTelemetry = telemetry;
        return {
          success: false,
          error: errorObj.message,
          errorCode: errorObj.code,
          telemetry,
          providerDurationMs: elapsedMs
        };
      }

      const firstChoice = data.choices[0];
      const assistantMessage = firstChoice?.message?.content;

      if (typeof assistantMessage !== 'string') {
        const errorObj = {
          code: 'OPENROUTER_BAD_REQUEST',
          message: 'Malformed response from provider: missing message content'
        };
        const telemetry = buildTelemetry({
          routingRequest,
          responseData: data,
          durationMs: elapsedMs,
          success: false,
          error: errorObj
        });
        this.lastTelemetry = telemetry;
        return {
          success: false,
          error: errorObj.message,
          errorCode: errorObj.code,
          telemetry,
          providerDurationMs: elapsedMs
        };
      }

      const telemetry = buildTelemetry({
        routingRequest,
        responseData: data,
        durationMs: elapsedMs,
        success: true
      });
      this.lastTelemetry = telemetry;

      return {
        success: true,
        text: assistantMessage,
        model: data.model || routingRequest.requestedModel,
        actualModel: data.model || null,
        provider: telemetry.provider,
        usage: data.usage || null,
        cost: telemetry.cost,
        telemetry,
        providerDurationMs: elapsedMs
      };
    } catch (err) {
      const elapsedMs = getElapsedMs();
      const classified = classifyProviderError(err, null, this.apiKey);
      const telemetry = buildTelemetry({
        routingRequest,
        durationMs: elapsedMs,
        success: false,
        error: classified
      });
      this.lastTelemetry = telemetry;

      if (err.name === 'AbortError' || controller.signal.aborted) {
        return {
          success: false,
          error: `Request timed out after ${timeout}ms`,
          errorCode: classified.code,
          telemetry,
          providerDurationMs: elapsedMs
        };
      }

      return {
        success: false,
        error: `Network error: ${classified.message}`,
        errorCode: classified.code,
        telemetry,
        providerDurationMs: elapsedMs
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Streams a text response through the OpenRouter Routing Gate.
   * Yields string deltas for clean caller consumption while capturing usage and telemetry.
   *
   * @param {Object} params
   * @param {'FAST'|'REASONING'} [params.profile='FAST']
   * @param {Array<{ role: string, content: string }>} params.messages
   * @param {string} [params.sessionId]
   * @param {number} [params.timeoutMs]
   * @returns {AsyncGenerator<string, void, unknown>}
   */
  async *stream(params = {}) {
    const configCheck = this.validateConfig();
    if (!configCheck.valid) {
      throw new Error(`Configuration error: ${configCheck.error}`);
    }

    const routingRequest = buildRoutingRequest({
      ...params,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      config: this.config,
      stream: true
    });

    const timeout = params.timeoutMs ?? routingRequest.timeoutMs;
    const controller = new AbortController();
    let timeoutId = null;

    if (timeout > 0 && typeof setTimeout === 'function') {
      timeoutId = setTimeout(() => {
        controller.abort(new Error(`Request timed out after ${timeout}ms`));
      }, timeout);
    }

    const streamStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();

    let firstTokenTime = null;
    let completed = false;
    let finalUsage = null;
    let servingModel = null;
    let servingProvider = null;

    try {
      const response = await this.fetchFn(routingRequest.endpoint, {
        method: 'POST',
        headers: routingRequest.headers,
        body: JSON.stringify(routingRequest.body),
        signal: controller.signal
      });

      if (!response.ok) {
        let rawError = '';
        try {
          const errJson = await response.json();
          rawError = errJson.error?.message || errJson.message || JSON.stringify(errJson);
        } catch {
          try {
            rawError = await response.text();
          } catch {
            rawError = response.statusText || 'Unknown error';
          }
        }
        const classified = classifyProviderError(new Error(rawError), response.status, this.apiKey);
        const telemetry = buildTelemetry({
          routingRequest,
          durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - streamStartTime,
          success: false,
          error: classified
        });
        this.lastTelemetry = telemetry;
        throw new Error(`Provider HTTP ${response.status}: ${classified.message}`);
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
            continue;
          }

          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') {
              completed = true;
              break;
            }

            let parsed;
            try {
              parsed = JSON.parse(dataStr);
            } catch {
              continue;
            }

            if (parsed.model) {
              servingModel = parsed.model;
            }
            if (parsed.provider) {
              servingProvider = parsed.provider;
            }
            if (parsed.usage) {
              finalUsage = parsed.usage;
            }

            const content = parsed.choices?.[0]?.delta?.content;
            if (typeof content === 'string' && content.length > 0) {
              if (firstTokenTime === null) {
                firstTokenTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
              }
              yield content;
            }
          }
        }
      }

      completed = true;

      const totalDurationMs = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - streamStartTime);
      const timeToFirstTokenMs = firstTokenTime ? (firstTokenTime - streamStartTime) : null;

      const streamInfo = {
        timeToFirstTokenMs,
        totalDurationMs,
        usage: finalUsage,
        model: servingModel,
        provider: servingProvider
      };

      const telemetry = buildTelemetry({
        routingRequest,
        durationMs: totalDurationMs,
        success: true,
        streamInfo
      });
      this.lastTelemetry = telemetry;
    } catch (err) {
      const totalDurationMs = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - streamStartTime);
      const classified = classifyProviderError(err, null, this.apiKey);
      const telemetry = buildTelemetry({
        routingRequest,
        durationMs: totalDurationMs,
        success: false,
        error: classified
      });
      this.lastTelemetry = telemetry;

      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new Error(`Request timed out after ${timeout}ms`);
      }
      if (err.message && err.message.startsWith('Provider HTTP')) {
        throw err;
      }
      const safeError = sanitizeError(err.message, this.apiKey);
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

  /**
   * Retrieves the last captured telemetry record.
   * @returns {Object|null}
   */
  getLastTelemetry() {
    return this.lastTelemetry;
  }
}

export default OpenRouterRoutingGate;
