/**
 * Configuration module for JARVIS4.
 * Safely loads and validates configuration.
 */

const VALID_ENVIRONMENTS = ['development', 'test', 'production'];
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Loads and validates current configuration.
 * @param {Object} [overrides={}] - Optional manual overrides for testing
 * @returns {Readonly<{
 *   nodeEnv: string,
 *   logLevel: string,
 *   isProduction: boolean,
 *   isTest: boolean,
 *   cheaperInference: Readonly<{ apiKey: string, baseUrl: string, model: string, timeoutMs: number }>
 * }>}
 */
export function loadConfig(overrides = {}) {
  const nodeEnv = (overrides.NODE_ENV || process.env.NODE_ENV || 'development').toLowerCase().trim();
  const logLevel = (overrides.LOG_LEVEL || process.env.LOG_LEVEL || 'info').toLowerCase().trim();

  if (!VALID_ENVIRONMENTS.includes(nodeEnv)) {
    throw new Error(`Invalid NODE_ENV: "${nodeEnv}". Allowed values: ${VALID_ENVIRONMENTS.join(', ')}`);
  }

  if (!VALID_LOG_LEVELS.includes(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL: "${logLevel}". Allowed values: ${VALID_LOG_LEVELS.join(', ')}`);
  }

  const cheaperInference = Object.freeze({
    apiKey: overrides.CHEAPER_INFERENCE_API_KEY ?? process.env.CHEAPER_INFERENCE_API_KEY ?? '',
    baseUrl: (overrides.CHEAPER_INFERENCE_BASE_URL ?? process.env.CHEAPER_INFERENCE_BASE_URL ?? 'https://api.cheaperinference.com/v1').trim().replace(/\/+$/, ''),
    model: overrides.CHEAPER_INFERENCE_MODEL ?? process.env.CHEAPER_INFERENCE_MODEL ?? '',
    timeoutMs: Number(overrides.CHEAPER_INFERENCE_TIMEOUT_MS ?? process.env.CHEAPER_INFERENCE_TIMEOUT_MS ?? 30000) || 30000
  });

  const openRouter = Object.freeze({
    apiKey: overrides.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '',
    sttBaseUrl: (overrides.OPENROUTER_STT_BASE_URL ?? process.env.OPENROUTER_STT_BASE_URL ?? 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, ''),
    sttModel: overrides.OPENROUTER_STT_MODEL ?? process.env.OPENROUTER_STT_MODEL ?? 'openai/whisper-large-v3-turbo',
    timeoutMs: Number(overrides.OPENROUTER_STT_TIMEOUT_MS ?? process.env.OPENROUTER_STT_TIMEOUT_MS ?? 30000) || 30000,
    ttsBaseUrl: (overrides.OPENROUTER_TTS_BASE_URL ?? process.env.OPENROUTER_TTS_BASE_URL ?? 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, ''),
    ttsModel: overrides.OPENROUTER_TTS_MODEL ?? process.env.OPENROUTER_TTS_MODEL ?? 'elevenlabs/eleven-v4-turbo',
    ttsVoice: overrides.OPENROUTER_TTS_VOICE ?? process.env.OPENROUTER_TTS_VOICE ?? 'george',
    ttsTimeoutMs: Number(overrides.OPENROUTER_TTS_TIMEOUT_MS ?? process.env.OPENROUTER_TTS_TIMEOUT_MS ?? 30000) || 30000
  });

  return Object.freeze({
    nodeEnv,
    logLevel,
    isProduction: nodeEnv === 'production',
    isTest: nodeEnv === 'test',
    cheaperInference,
    openRouter
  });
}

export const config = loadConfig();

export default config;
