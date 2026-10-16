/**
 * OpenRouter Routing, Fallback & Telemetry Logic for JARVIS4 (PRE-040B).
 * Provider layer routing policies, deterministic request building, error sanitization, and telemetry.
 */

export const ROUTING_PROFILES = Object.freeze({
  FAST: 'FAST',
  REASONING: 'REASONING'
});

export const ROUTING_MODES = Object.freeze({
  PINNED_FALLBACK: 'PINNED_FALLBACK',
  AUTO: 'AUTO'
});

export const ALLOWED_COST_TIERS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

export const DEFAULT_PRIMARY_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const AUTO_ROUTER_MODEL = 'openrouter/auto';
export const MAX_FALLBACK_MODELS = 2;
export const MAX_TOTAL_MODELS = 3;

export const OPENROUTER_ERROR_CODES = Object.freeze({
  TIMEOUT: 'OPENROUTER_TIMEOUT',
  RATE_LIMITED: 'OPENROUTER_RATE_LIMITED',
  AUTH_FAILED: 'OPENROUTER_AUTH_FAILED',
  BAD_REQUEST: 'OPENROUTER_BAD_REQUEST',
  UPSTREAM_UNAVAILABLE: 'OPENROUTER_UPSTREAM_UNAVAILABLE',
  NETWORK_ERROR: 'OPENROUTER_NETWORK_ERROR',
  ROUTING_FAILED: 'OPENROUTER_ROUTING_FAILED'
});

/**
 * Normalizes profile name.
 * @param {string} [profile]
 * @returns {'FAST' | 'REASONING'}
 */
export function normalizeProfile(profile) {
  if (!profile) return ROUTING_PROFILES.FAST;
  const upper = String(profile).trim().toUpperCase();
  if (upper === 'FAST') return ROUTING_PROFILES.FAST;
  if (upper === 'REASONING') return ROUTING_PROFILES.REASONING;
  throw new Error(`Unsupported routing profile: "${profile}". Allowed profiles: FAST, REASONING`);
}

/**
 * Normalizes routing mode string.
 * @param {string} [mode]
 * @returns {'PINNED_FALLBACK' | 'AUTO'}
 */
export function normalizeRoutingMode(mode) {
  if (!mode) return ROUTING_MODES.PINNED_FALLBACK;
  const upper = String(mode).trim().toUpperCase();
  if (upper === 'PINNED' || upper === 'PINNED_FALLBACK') return ROUTING_MODES.PINNED_FALLBACK;
  if (upper === 'AUTO') return ROUTING_MODES.AUTO;
  throw new Error(`Unsupported routing mode: "${mode}". Allowed modes: PINNED_FALLBACK, AUTO`);
}

/**
 * Validates cost tier.
 * @param {string} [tier]
 * @returns {'low' | 'medium' | 'high' | 'xhigh' | 'max'}
 */
export function validateCostTier(tier) {
  if (!tier) return 'medium';
  const norm = String(tier).trim().toLowerCase();
  if (!ALLOWED_COST_TIERS.includes(norm)) {
    throw new Error(`Invalid cost tier: "${tier}". Allowed values: ${ALLOWED_COST_TIERS.join(', ')}`);
  }
  return norm;
}

/**
 * Parses and normalizes fallback model identifiers.
 * - Deduplicates while preserving order
 * - Strips entries matching primaryModel
 * - Bounded by maxCount (default 2)
 *
 * @param {string|string[]} [input]
 * @param {string} [primaryModel]
 * @param {number} [maxCount=2]
 * @returns {string[]}
 */
export function normalizeFallbackModels(input, primaryModel, maxCount = MAX_FALLBACK_MODELS) {
  let list = [];
  if (Array.isArray(input)) {
    list = input;
  } else if (typeof input === 'string') {
    list = input.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const normalized = [];
  const primaryClean = typeof primaryModel === 'string' ? primaryModel.trim() : '';

  for (const item of list) {
    if (typeof item === 'string') {
      const clean = item.trim();
      if (clean.length > 0 && clean !== primaryClean && !normalized.includes(clean)) {
        normalized.push(clean);
        if (normalized.length >= maxCount) break;
      }
    }
  }

  return Object.freeze(normalized);
}

/**
 * Validates opaque session ID ensuring it never contains PII, secrets, or file paths.
 * @param {any} sessionId
 * @returns {{ valid: boolean, value?: string|null, error?: string }}
 */
export function validateSessionId(sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === '') {
    return { valid: true, value: null };
  }

  if (typeof sessionId !== 'string') {
    return { valid: false, error: 'Session ID must be a string' };
  }

  const trimmed = sessionId.trim();
  if (trimmed.length === 0) {
    return { valid: true, value: null };
  }

  if (trimmed.length > 128) {
    return { valid: false, error: 'Session ID exceeds maximum length of 128 characters' };
  }

  // Reject email addresses, URLs, credentials, tokens, or filesystem paths
  if (trimmed.includes('@')) {
    return { valid: false, error: 'Session ID must not contain email addresses' };
  }
  if (/https?:\/\//i.test(trimmed)) {
    return { valid: false, error: 'Session ID must not contain URLs' };
  }
  if (/^[a-zA-Z]:[\\/]/i.test(trimmed) || trimmed.includes('\\') || trimmed.includes('/')) {
    return { valid: false, error: 'Session ID must not contain filesystem paths' };
  }
  if (/(sk-[a-zA-Z0-9_-]+|bearer|password|cookie|auth_token|secret)/i.test(trimmed)) {
    return { valid: false, error: 'Session ID must not contain sensitive tokens or secret names' };
  }

  // Allow only safe opaque identifiers (alphanumeric, dash, underscore, colon, period)
  if (!/^[a-zA-Z0-9_\-:.]+$/.test(trimmed)) {
    return { valid: false, error: 'Session ID must contain only alphanumeric characters, dashes, underscores, colons, or periods' };
  }

  return { valid: true, value: trimmed };
}

/**
 * Sanitizes an error message ensuring API keys, auth headers, and local paths are removed.
 * @param {string} message
 * @param {string} [apiKey]
 * @returns {string}
 */
export function sanitizeError(message, apiKey) {
  if (!message || typeof message !== 'string') return '';
  let safe = message;

  if (apiKey && typeof apiKey === 'string') {
    safe = safe.replaceAll(apiKey, '[REDACTED]');
  }
  if (process.env.OPENROUTER_API_KEY) {
    safe = safe.replaceAll(process.env.OPENROUTER_API_KEY, '[REDACTED]');
  }

  // Redact potential OpenRouter key format
  safe = safe.replace(/sk-or-v1-[a-f0-9]{64}/gi, '[REDACTED]');
  safe = safe.replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer [REDACTED]');
  safe = safe.replace(/Authorization:\s*[^\s\r\n,]+/gi, 'Authorization: [REDACTED]');

  // Redact Windows absolute filesystem paths
  safe = safe.replace(/[a-zA-Z]:\\[^:\n\r\t"]+/g, '[PATH_REDACTED]');

  return safe;
}

/**
 * Classifies an error into controlled OpenRouter error codes and sanitized message.
 *
 * @param {Error|any} err
 * @param {number} [status]
 * @param {string} [apiKey]
 * @returns {{ code: string, message: string, statusCode: number|null }}
 */
export function classifyProviderError(err, status = null, apiKey = '') {
  const errMsg = err?.message || String(err || '');
  const cleanMsg = sanitizeError(errMsg, apiKey);

  if (status === 408 || err?.name === 'AbortError' || /timed?\s*out/i.test(errMsg)) {
    return {
      code: OPENROUTER_ERROR_CODES.TIMEOUT,
      message: cleanMsg || 'Request timed out',
      statusCode: status || 408
    };
  }

  if (status === 429 || /rate\s*limit/i.test(errMsg)) {
    return {
      code: OPENROUTER_ERROR_CODES.RATE_LIMITED,
      message: cleanMsg || 'OpenRouter rate limit exceeded',
      statusCode: 429
    };
  }

  if (status === 401 || status === 403 || /unauthorized|auth|forbidden/i.test(errMsg)) {
    return {
      code: OPENROUTER_ERROR_CODES.AUTH_FAILED,
      message: cleanMsg || 'OpenRouter authentication failed',
      statusCode: status || 401
    };
  }

  if (status === 400 || status === 422 || /bad\s*request|invalid/i.test(errMsg)) {
    return {
      code: OPENROUTER_ERROR_CODES.BAD_REQUEST,
      message: cleanMsg || 'OpenRouter bad request',
      statusCode: status || 400
    };
  }

  if (status === 502 || status === 503 || status === 504 || /upstream|service unavailable|gateway/i.test(errMsg)) {
    return {
      code: OPENROUTER_ERROR_CODES.UPSTREAM_UNAVAILABLE,
      message: cleanMsg || 'OpenRouter upstream service unavailable',
      statusCode: status || 503
    };
  }

  if (/network|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND/i.test(errMsg)) {
    return {
      code: OPENROUTER_ERROR_CODES.NETWORK_ERROR,
      message: cleanMsg || 'Network connectivity error reaching OpenRouter',
      statusCode: status || null
    };
  }

  return {
    code: OPENROUTER_ERROR_CODES.ROUTING_FAILED,
    message: cleanMsg || 'OpenRouter request failed',
    statusCode: status || null
  };
}

/**
 * Builds a deterministic OpenRouter request payload according to profile policy.
 *
 * CRITICAL SECURITY INVARIANT:
 * Model output or caller cannot supply model, models, cost_tier, provider, or allow_fallbacks.
 * Any such overrides are blocked/ignored. Application configuration alone is authoritative.
 *
 * @param {Object} params
 * @param {'FAST'|'REASONING'} [params.profile='FAST'] - Application-selected profile
 * @param {Array<{ role: string, content: string }>} params.messages - Conversation turns
 * @param {string} [params.sessionId] - Optional opaque session identifier
 * @param {Object} [params.config] - Application configuration
 * @param {boolean} [params.stream=false] - Whether streaming is requested
 * @returns {{
 *   profile: string,
 *   routingMode: string,
 *   endpoint: string,
 *   headers: Record<string, string>,
 *   body: Object,
 *   timeoutMs: number,
 *   requestedModel: string,
 *   requestedModels: string[],
 *   sessionId: string|null,
 *   costTier: string|null
 * }}
 */
export function buildRoutingRequest(params = {}) {
  // 1. Resolve and validate profile (caller overrides are strictly ignored)
  const profile = normalizeProfile(params.profile);

  // 2. Format and validate messages
  const rawMessages = params.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new Error('Messages must be a non-empty array');
  }

  const formattedMessages = [];
  for (const msg of rawMessages) {
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

  // 3. Validate session ID
  const sessionCheck = validateSessionId(params.sessionId);
  if (!sessionCheck.valid) {
    throw new Error(sessionCheck.error);
  }
  const safeSessionId = sessionCheck.value;

  // 4. Resolve application configuration (ignoring caller's model/cost overrides)
  const cfg = params.config || {};
  const openRouterCfg = cfg.openRouter || {};

  const apiKey = (params.apiKey || openRouterCfg.apiKey || process.env.OPENROUTER_API_KEY || '').trim();
  const baseUrl = (params.baseUrl || openRouterCfg.textBaseUrl || 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, '');

  let routingMode;
  let requestedModel;
  let requestedModels;
  let timeoutMs;
  let costTier = null;
  let requestBody;

  if (profile === ROUTING_PROFILES.FAST) {
    // FAST Profile -> PINNED_FALLBACK mode
    routingMode = ROUTING_MODES.PINNED_FALLBACK;
    const primaryModel = (openRouterCfg.fastModel || openRouterCfg.textModel || DEFAULT_PRIMARY_MODEL).trim();
    requestedModel = primaryModel;

    const fallbacks = normalizeFallbackModels(
      openRouterCfg.fastFallbackModels,
      primaryModel,
      MAX_FALLBACK_MODELS
    );

    requestedModels = Object.freeze([primaryModel, ...fallbacks]);
    timeoutMs = openRouterCfg.fastTimeoutMs || openRouterCfg.textTimeoutMs || 30000;

    requestBody = {
      messages: formattedMessages
    };

    if (fallbacks.length > 0) {
      requestBody.models = [primaryModel, ...fallbacks];
    } else {
      requestBody.model = primaryModel;
    }

    if (params.stream) {
      requestBody.stream = true;
    }
  } else {
    // REASONING Profile -> AUTO mode
    routingMode = ROUTING_MODES.AUTO;
    requestedModel = AUTO_ROUTER_MODEL;
    requestedModels = Object.freeze([AUTO_ROUTER_MODEL]);
    costTier = validateCostTier(openRouterCfg.reasoningCostTier || openRouterCfg.autoCostTier || 'medium');
    timeoutMs = openRouterCfg.reasoningTimeoutMs || 60000;

    requestBody = {
      model: AUTO_ROUTER_MODEL,
      messages: formattedMessages,
      plugins: [
        {
          id: 'auto-router',
          cost_tier: costTier
        }
      ]
    };

    if (safeSessionId) {
      requestBody.session_id = safeSessionId;
    }

    if (params.stream) {
      requestBody.stream = true;
    }

    // Critical invariant: never wrap AUTO mode in another fallback chain or models array
  }

  const maxTokens = typeof params.maxTokens === 'number'
    ? params.maxTokens
    : (typeof params.max_tokens === 'number' ? params.max_tokens : null);
  if (typeof maxTokens === 'number' && maxTokens > 0) {
    requestBody.max_tokens = maxTokens;
  }

  if (typeof params.temperature === 'number') {
    requestBody.temperature = params.temperature;
  }

  if (params.reasoning && typeof params.reasoning === 'object') {
    requestBody.reasoning = params.reasoning;
  }

  return {
    profile,
    routingMode,
    endpoint: `${baseUrl}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: requestBody,
    timeoutMs,
    requestedModel,
    requestedModels,
    sessionId: safeSessionId,
    costTier
  };
}

/**
 * Builds a sanitized telemetry object for logging and audit.
 * Strictly free of API keys, authorization tokens, raw messages, passwords, and private file paths.
 *
 * @param {Object} params
 * @param {Object} params.routingRequest - Built routing request
 * @param {Object} [params.responseData] - Provider response JSON
 * @param {number} params.durationMs - Measured provider duration in ms
 * @param {boolean} [params.success=true] - Whether request succeeded
 * @param {Object} [params.error] - Classified error if failed
 * @param {Object} [params.streamInfo] - Optional streaming metrics
 * @returns {Object}
 */
export function buildTelemetry({
  routingRequest,
  responseData = null,
  durationMs = 0,
  success = true,
  error = null,
  streamInfo = null
}) {
  const actualModel = responseData?.model || streamInfo?.model || null;
  const rawProvider = responseData?.provider || responseData?.choices?.[0]?.provider || streamInfo?.provider || null;
  const provider = typeof rawProvider === 'string' && rawProvider.trim().length > 0 ? rawProvider.trim() : null;

  let fallbackUsed = false;
  let autoSelectedModel = null;

  if (routingRequest.routingMode === ROUTING_MODES.PINNED_FALLBACK) {
    if (actualModel && routingRequest.requestedModel && actualModel !== routingRequest.requestedModel) {
      fallbackUsed = true;
    }
  } else if (routingRequest.routingMode === ROUTING_MODES.AUTO) {
    // Auto Router selecting a model is normal task-based routing, NOT a fallback
    fallbackUsed = false;
    autoSelectedModel = actualModel;
  }

  // Token accounting
  const promptTokens = Number.isInteger(responseData?.usage?.prompt_tokens)
    ? responseData.usage.prompt_tokens
    : (Number.isInteger(streamInfo?.usage?.prompt_tokens) ? streamInfo.usage.prompt_tokens : null);

  const completionTokens = Number.isInteger(responseData?.usage?.completion_tokens)
    ? responseData.usage.completion_tokens
    : (Number.isInteger(streamInfo?.usage?.completion_tokens) ? streamInfo.usage.completion_tokens : null);

  const totalTokens = Number.isInteger(responseData?.usage?.total_tokens)
    ? responseData.usage.total_tokens
    : (Number.isInteger(streamInfo?.usage?.total_tokens) ? streamInfo.usage.total_tokens : null);

  // Cost accounting: use actual returned cost when available; otherwise null (do not invent $0)
  let cost = null;
  if (typeof responseData?.usage?.cost === 'number' && Number.isFinite(responseData.usage.cost)) {
    cost = responseData.usage.cost;
  } else if (typeof streamInfo?.usage?.cost === 'number' && Number.isFinite(streamInfo.usage.cost)) {
    cost = streamInfo.usage.cost;
  }

  const telemetry = {
    routingProfile: routingRequest.profile,
    routingMode: routingRequest.routingMode,
    requestedModel: routingRequest.requestedModel,
    requestedModels: routingRequest.requestedModels,
    actualModel,
    provider,
    fallbackUsed,
    autoSelectedModel,
    latencyMs: Math.max(0, Math.round(durationMs)),
    promptTokens,
    completionTokens,
    totalTokens,
    cost,
    timeoutMs: routingRequest.timeoutMs,
    success: Boolean(success),
    errorCode: error?.code || null
  };

  if (streamInfo) {
    if (typeof streamInfo.timeToFirstTokenMs === 'number') {
      telemetry.timeToFirstTokenMs = Math.max(0, Math.round(streamInfo.timeToFirstTokenMs));
    }
    if (typeof streamInfo.totalDurationMs === 'number') {
      telemetry.totalStreamDurationMs = Math.max(0, Math.round(streamInfo.totalDurationMs));
    }
  }

  return Object.freeze(telemetry);
}
