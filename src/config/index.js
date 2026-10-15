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
    textBaseUrl: (overrides.OPENROUTER_TEXT_BASE_URL ?? process.env.OPENROUTER_TEXT_BASE_URL ?? 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, ''),
    textModel: overrides.OPENROUTER_TEXT_MODEL ?? process.env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4-flash-0731',
    textTimeoutMs: Number(overrides.OPENROUTER_TEXT_TIMEOUT_MS ?? process.env.OPENROUTER_TEXT_TIMEOUT_MS ?? 30000) || 30000,
    searchBaseUrl: (overrides.OPENROUTER_SEARCH_BASE_URL ?? process.env.OPENROUTER_SEARCH_BASE_URL ?? overrides.OPENROUTER_TEXT_BASE_URL ?? process.env.OPENROUTER_TEXT_BASE_URL ?? 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, ''),
    searchModel: overrides.OPENROUTER_SEARCH_MODEL ?? process.env.OPENROUTER_SEARCH_MODEL ?? 'deepseek/deepseek-v4-flash-0731',
    searchTimeoutMs: Number(overrides.OPENROUTER_SEARCH_TIMEOUT_MS ?? process.env.OPENROUTER_SEARCH_TIMEOUT_MS ?? 30000) || 30000,
    sttBaseUrl: (overrides.OPENROUTER_STT_BASE_URL ?? process.env.OPENROUTER_STT_BASE_URL ?? 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, ''),
    sttModel: overrides.OPENROUTER_STT_MODEL ?? process.env.OPENROUTER_STT_MODEL ?? 'openai/whisper-large-v3-turbo',
    timeoutMs: Number(overrides.OPENROUTER_STT_TIMEOUT_MS ?? process.env.OPENROUTER_STT_TIMEOUT_MS ?? 30000) || 30000,
    ttsBaseUrl: (overrides.OPENROUTER_TTS_BASE_URL ?? process.env.OPENROUTER_TTS_BASE_URL ?? 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, ''),
    ttsModel: overrides.OPENROUTER_TTS_MODEL ?? process.env.OPENROUTER_TTS_MODEL ?? 'elevenlabs/eleven-v4-turbo',
    ttsVoice: overrides.OPENROUTER_TTS_VOICE ?? process.env.OPENROUTER_TTS_VOICE ?? 'george',
    ttsTimeoutMs: Number(overrides.OPENROUTER_TTS_TIMEOUT_MS ?? process.env.OPENROUTER_TTS_TIMEOUT_MS ?? 30000) || 30000
  });

  const webRead = Object.freeze({
    timeoutMs: Math.max(1, Number(overrides.WEB_READ_TIMEOUT_MS ?? process.env.WEB_READ_TIMEOUT_MS ?? 12000)) || 12000,
    maxBytes: Math.max(1, Number(overrides.WEB_READ_MAX_BYTES ?? process.env.WEB_READ_MAX_BYTES ?? 1500000)) || 1500000,
    maxTextChars: Math.max(1, Number(overrides.WEB_READ_MAX_TEXT_CHARS ?? process.env.WEB_READ_MAX_TEXT_CHARS ?? 30000)) || 30000,
    maxRedirects: Math.max(0, Number(overrides.WEB_READ_MAX_REDIRECTS ?? process.env.WEB_READ_MAX_REDIRECTS ?? 3))
  });

  const pageQa = Object.freeze({
    maxQuestionChars: Math.max(1, Number(overrides.PAGE_QA_MAX_QUESTION_CHARS ?? process.env.PAGE_QA_MAX_QUESTION_CHARS ?? 4000)) || 4000,
    maxOutputTokens: Math.max(1, Number(overrides.PAGE_QA_MAX_OUTPUT_TOKENS ?? process.env.PAGE_QA_MAX_OUTPUT_TOKENS ?? 1000)) || 1000
  });

function clamp(val, min, max, defaultVal) {
  if (val === undefined || val === null || val === '') return defaultVal;
  const num = Number(val);
  if (Number.isNaN(num)) return defaultVal;
  return Math.min(Math.max(num, min), max);
}

  const browser = Object.freeze({
    channel: (overrides.BROWSER_CHANNEL ?? process.env.BROWSER_CHANNEL ?? 'msedge').trim(),
    headless: typeof overrides.BROWSER_HEADLESS === 'boolean'
      ? overrides.BROWSER_HEADLESS
      : (overrides.BROWSER_HEADLESS ?? process.env.BROWSER_HEADLESS ?? 'false').toString().trim().toLowerCase() === 'true',
    launchTimeoutMs: Math.max(1, Number(overrides.BROWSER_LAUNCH_TIMEOUT_MS ?? process.env.BROWSER_LAUNCH_TIMEOUT_MS ?? 15000)) || 15000,
    navigationTimeoutMs: Math.max(1, Number(overrides.BROWSER_NAVIGATION_TIMEOUT_MS ?? process.env.BROWSER_NAVIGATION_TIMEOUT_MS ?? 15000)) || 15000,
    inspectionMaxTextChars: Math.max(1, Number(overrides.BROWSER_INSPECTION_MAX_TEXT_CHARS ?? process.env.BROWSER_INSPECTION_MAX_TEXT_CHARS ?? 12000)) || 12000,
    inspectionMaxElements: Math.max(1, Number(overrides.BROWSER_INSPECTION_MAX_ELEMENTS ?? process.env.BROWSER_INSPECTION_MAX_ELEMENTS ?? 100)) || 100,
    inspectionMaxElementTextChars: Math.max(1, Number(overrides.BROWSER_INSPECTION_MAX_ELEMENT_TEXT_CHARS ?? process.env.BROWSER_INSPECTION_MAX_ELEMENT_TEXT_CHARS ?? 300)) || 300,
    actionTimeoutMs: Math.max(1, Number(overrides.BROWSER_ACTION_TIMEOUT_MS ?? process.env.BROWSER_ACTION_TIMEOUT_MS ?? 10000)) || 10000,
    maxPages: Math.max(1, Number(overrides.BROWSER_MAX_PAGES ?? process.env.BROWSER_MAX_PAGES ?? 8)) || 8,
    popupSettleMs: Math.max(1, Number(overrides.BROWSER_POPUP_SETTLE_MS ?? process.env.BROWSER_POPUP_SETTLE_MS ?? 500)) || 500,
    dynamicTimeoutMs: clamp(overrides.BROWSER_DYNAMIC_TIMEOUT_MS ?? process.env.BROWSER_DYNAMIC_TIMEOUT_MS, 100, 60000, 5000),
    domQuietMs: clamp(overrides.BROWSER_DOM_QUIET_MS ?? process.env.BROWSER_DOM_QUIET_MS, 50, 5000, 300),
    dynamicPollMs: clamp(overrides.BROWSER_DYNAMIC_POLL_MS ?? process.env.BROWSER_DYNAMIC_POLL_MS, 20, 1000, 100),
    maxDynamicWaits: clamp(overrides.BROWSER_MAX_DYNAMIC_WAITS ?? process.env.BROWSER_MAX_DYNAMIC_WAITS, 1, 20, 4),
    submitVerifyTimeoutMs: clamp(overrides.BROWSER_SUBMIT_VERIFY_TIMEOUT_MS ?? process.env.BROWSER_SUBMIT_VERIFY_TIMEOUT_MS, 100, 30000, 10000),
    submitConfirmationTtlMs: clamp(overrides.BROWSER_CONFIRMATION_TTL_MS ?? process.env.BROWSER_CONFIRMATION_TTL_MS, 1000, 300000, 60000),
    handoffTtlMs: clamp(overrides.BROWSER_HANDOFF_TTL_MS ?? process.env.BROWSER_HANDOFF_TTL_MS, 1000, 1800000, 300000),
    uploadMaxBytes: clamp(overrides.BROWSER_UPLOAD_MAX_BYTES ?? process.env.BROWSER_UPLOAD_MAX_BYTES, 1024, 500 * 1024 * 1024, 50 * 1024 * 1024),
    downloadMaxBytes: clamp(overrides.BROWSER_DOWNLOAD_MAX_BYTES ?? process.env.BROWSER_DOWNLOAD_MAX_BYTES, 1024, 500 * 1024 * 1024, 50 * 1024 * 1024),
    downloadTimeoutMs: clamp(overrides.BROWSER_DOWNLOAD_TIMEOUT_MS ?? process.env.BROWSER_DOWNLOAD_TIMEOUT_MS, 1000, 300000, 30000),
    extractMaxRecords: clamp(overrides.BROWSER_EXTRACT_MAX_RECORDS ?? process.env.BROWSER_EXTRACT_MAX_RECORDS, 10, 5000, 500),
    extractMaxTextChars: clamp(overrides.BROWSER_EXTRACT_MAX_TEXT_CHARS ?? process.env.BROWSER_EXTRACT_MAX_TEXT_CHARS, 1000, 2000000, 200000),
    extractMaxFieldChars: clamp(overrides.BROWSER_EXTRACT_MAX_FIELD_CHARS ?? process.env.BROWSER_EXTRACT_MAX_FIELD_CHARS, 100, 50000, 4000),
    extractMaxNestingDepth: clamp(overrides.BROWSER_EXTRACT_MAX_NESTING_DEPTH ?? process.env.BROWSER_EXTRACT_MAX_NESTING_DEPTH, 1, 20, 5),
    extractTimeoutMs: clamp(overrides.BROWSER_EXTRACT_TIMEOUT_MS ?? process.env.BROWSER_EXTRACT_TIMEOUT_MS, 500, 60000, 10000)
  });

  return Object.freeze({
    nodeEnv,
    logLevel,
    isProduction: nodeEnv === 'production',
    isTest: nodeEnv === 'test',
    cheaperInference,
    openRouter,
    webRead,
    pageQa,
    browser
  });
}

export const config = loadConfig();

export default config;

