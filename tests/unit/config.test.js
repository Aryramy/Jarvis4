import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/index.js';

describe('Configuration Utility', () => {
  const AI_ENV_VARS = [
    'CHEAPER_INFERENCE_API_KEY',
    'CHEAPER_INFERENCE_BASE_URL',
    'CHEAPER_INFERENCE_MODEL',
    'CHEAPER_INFERENCE_TIMEOUT_MS',
    'OPENROUTER_API_KEY',
    'OPENROUTER_TEXT_BASE_URL',
    'OPENROUTER_TEXT_MODEL',
    'OPENROUTER_TEXT_TIMEOUT_MS',
    'OPENROUTER_FAST_ROUTING_MODE',
    'OPENROUTER_FAST_MODEL',
    'OPENROUTER_FAST_FALLBACK_MODELS',
    'OPENROUTER_FAST_TIMEOUT_MS',
    'OPENROUTER_REASONING_ROUTING_MODE',
    'OPENROUTER_REASONING_MODEL',
    'OPENROUTER_REASONING_COST_TIER',
    'OPENROUTER_AUTO_COST_TIER',
    'OPENROUTER_REASONING_TIMEOUT_MS',
    'OPENROUTER_SEARCH_BASE_URL',
    'OPENROUTER_SEARCH_MODEL',
    'OPENROUTER_SEARCH_TIMEOUT_MS',
    'OPENROUTER_STT_BASE_URL',
    'OPENROUTER_STT_MODEL',
    'OPENROUTER_STT_TIMEOUT_MS',
    'OPENROUTER_TTS_BASE_URL',
    'OPENROUTER_TTS_MODEL',
    'OPENROUTER_TTS_VOICE',
    'OPENROUTER_TTS_TIMEOUT_MS',
    'WEB_READ_TIMEOUT_MS',
    'WEB_READ_MAX_BYTES',
    'WEB_READ_MAX_TEXT_CHARS',
    'WEB_READ_MAX_REDIRECTS',
    'PAGE_QA_MAX_QUESTION_CHARS',
    'PAGE_QA_MAX_OUTPUT_TOKENS',
    'BROWSER_CHANNEL',
    'BROWSER_HEADLESS',
    'BROWSER_LAUNCH_TIMEOUT_MS',
    'BROWSER_NAVIGATION_TIMEOUT_MS',
    'BROWSER_POPUP_SETTLE_MS',
    'BROWSER_DYNAMIC_TIMEOUT_MS',
    'BROWSER_DOM_QUIET_MS',
    'BROWSER_DYNAMIC_POLL_MS',
    'BROWSER_MAX_DYNAMIC_WAITS'
  ];

  let originalEnv = {};

  beforeEach(() => {
    originalEnv = {};
    for (const key of AI_ENV_VARS) {
      if (key in process.env) {
        originalEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    for (const key of AI_ENV_VARS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  test('should load default configuration when no environment is set', () => {
    const cfg = loadConfig({ NODE_ENV: 'development', LOG_LEVEL: 'info' });
    assert.equal(cfg.nodeEnv, 'development');
    assert.equal(cfg.logLevel, 'info');
    assert.equal(cfg.isProduction, false);
    assert.equal(cfg.isTest, false);
  });

  test('should recognize test environment', () => {
    const cfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'warn' });
    assert.equal(cfg.nodeEnv, 'test');
    assert.equal(cfg.logLevel, 'warn');
    assert.equal(cfg.isTest, true);
    assert.equal(cfg.isProduction, false);
  });

  test('should recognize production environment', () => {
    const cfg = loadConfig({ NODE_ENV: 'production', LOG_LEVEL: 'error' });
    assert.equal(cfg.nodeEnv, 'production');
    assert.equal(cfg.logLevel, 'error');
    assert.equal(cfg.isProduction, true);
    assert.equal(cfg.isTest, false);
  });

  test('should reject invalid NODE_ENV', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'invalid_env' }),
      /Invalid NODE_ENV/
    );
  });

  test('should reject invalid LOG_LEVEL', () => {
    assert.throws(
      () => loadConfig({ LOG_LEVEL: 'verbose_invalid' }),
      /Invalid LOG_LEVEL/
    );
  });

  test('should load cheaperInference config defaults when environment is empty', () => {
    const defaultCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(defaultCfg.cheaperInference.apiKey, '');
    assert.equal(defaultCfg.cheaperInference.baseUrl, 'https://api.cheaperinference.com/v1');
    assert.equal(defaultCfg.cheaperInference.model, '');
    assert.equal(defaultCfg.cheaperInference.timeoutMs, 30000);
  });

  test('should load cheaperInference config overrides passed directly', () => {
    const customCfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      CHEAPER_INFERENCE_API_KEY: 'test-api-key',
      CHEAPER_INFERENCE_BASE_URL: 'https://custom.provider.com/v1/',
      CHEAPER_INFERENCE_MODEL: 'test-custom-model',
      CHEAPER_INFERENCE_TIMEOUT_MS: '45000'
    });
    assert.equal(customCfg.cheaperInference.apiKey, 'test-api-key');
    assert.equal(customCfg.cheaperInference.baseUrl, 'https://custom.provider.com/v1');
    assert.equal(customCfg.cheaperInference.model, 'test-custom-model');
    assert.equal(customCfg.cheaperInference.timeoutMs, 45000);
  });

  test('should load cheaperInference config from environment variables when overrides not provided', () => {
    process.env.CHEAPER_INFERENCE_API_KEY = 'test-env-key';
    process.env.CHEAPER_INFERENCE_BASE_URL = 'https://env.provider.com/v1/';
    process.env.CHEAPER_INFERENCE_MODEL = 'test-env-model';
    process.env.CHEAPER_INFERENCE_TIMEOUT_MS = '15000';

    const envCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(envCfg.cheaperInference.apiKey, 'test-env-key');
    assert.equal(envCfg.cheaperInference.baseUrl, 'https://env.provider.com/v1');
    assert.equal(envCfg.cheaperInference.model, 'test-env-model');
    assert.equal(envCfg.cheaperInference.timeoutMs, 15000);
  });

  test('should load openRouter STT config defaults when environment is empty', () => {
    const defaultCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(defaultCfg.openRouter.apiKey, '');
    assert.equal(defaultCfg.openRouter.sttBaseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(defaultCfg.openRouter.sttModel, 'openai/whisper-large-v3-turbo');
    assert.equal(defaultCfg.openRouter.timeoutMs, 30000);
  });

  test('should load openRouter STT config overrides passed directly', () => {
    const customCfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      OPENROUTER_API_KEY: 'sk-or-test-key',
      OPENROUTER_STT_BASE_URL: 'https://custom.openrouter.ai/v1/',
      OPENROUTER_STT_MODEL: 'custom-whisper-model',
      OPENROUTER_STT_TIMEOUT_MS: '60000'
    });
    assert.equal(customCfg.openRouter.apiKey, 'sk-or-test-key');
    assert.equal(customCfg.openRouter.sttBaseUrl, 'https://custom.openrouter.ai/v1');
    assert.equal(customCfg.openRouter.sttModel, 'custom-whisper-model');
    assert.equal(customCfg.openRouter.timeoutMs, 60000);
  });

  test('should load openRouter STT config from environment variables when overrides not provided', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-env-key';
    process.env.OPENROUTER_STT_BASE_URL = 'https://env.openrouter.ai/v1/';
    process.env.OPENROUTER_STT_MODEL = 'env-whisper-model';
    process.env.OPENROUTER_STT_TIMEOUT_MS = '20000';

    const envCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(envCfg.openRouter.apiKey, 'sk-or-env-key');
    assert.equal(envCfg.openRouter.sttBaseUrl, 'https://env.openrouter.ai/v1');
    assert.equal(envCfg.openRouter.sttModel, 'env-whisper-model');
    assert.equal(envCfg.openRouter.timeoutMs, 20000);
  });

  test('should load openRouter TTS config defaults when environment is empty', () => {
    const defaultCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(defaultCfg.openRouter.ttsBaseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(defaultCfg.openRouter.ttsModel, 'elevenlabs/eleven-v4-turbo');
    assert.equal(defaultCfg.openRouter.ttsVoice, 'george');
    assert.equal(defaultCfg.openRouter.ttsTimeoutMs, 30000);
  });

  test('should load openRouter TTS config overrides passed directly', () => {
    const customCfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      OPENROUTER_TTS_BASE_URL: 'https://custom.openrouter.ai/v1/',
      OPENROUTER_TTS_MODEL: 'custom-tts-model',
      OPENROUTER_TTS_VOICE: 'custom-voice',
      OPENROUTER_TTS_TIMEOUT_MS: '45000'
    });
    assert.equal(customCfg.openRouter.ttsBaseUrl, 'https://custom.openrouter.ai/v1');
    assert.equal(customCfg.openRouter.ttsModel, 'custom-tts-model');
    assert.equal(customCfg.openRouter.ttsVoice, 'custom-voice');
    assert.equal(customCfg.openRouter.ttsTimeoutMs, 45000);
  });

  test('should load openRouter TTS config from environment variables when overrides not provided', () => {
    process.env.OPENROUTER_TTS_BASE_URL = 'https://env.openrouter.ai/v1/';
    process.env.OPENROUTER_TTS_MODEL = 'env-tts-model';
    process.env.OPENROUTER_TTS_VOICE = 'env-voice';
    process.env.OPENROUTER_TTS_TIMEOUT_MS = '25000';

    const envCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(envCfg.openRouter.ttsBaseUrl, 'https://env.openrouter.ai/v1');
    assert.equal(envCfg.openRouter.ttsModel, 'env-tts-model');
    assert.equal(envCfg.openRouter.ttsVoice, 'env-voice');
    assert.equal(envCfg.openRouter.ttsTimeoutMs, 25000);
  });

  test('should load openRouter Text config defaults when environment is empty', () => {
    const defaultCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(defaultCfg.openRouter.textBaseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(defaultCfg.openRouter.textModel, 'deepseek/deepseek-v4-flash-0731');
    assert.equal(defaultCfg.openRouter.textTimeoutMs, 30000);
  });

  test('should load openRouter Text config overrides passed directly', () => {
    const customCfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      OPENROUTER_TEXT_BASE_URL: 'https://custom-text.openrouter.ai/v1/',
      OPENROUTER_TEXT_MODEL: 'custom-text-model',
      OPENROUTER_TEXT_TIMEOUT_MS: '45000'
    });
    assert.equal(customCfg.openRouter.textBaseUrl, 'https://custom-text.openrouter.ai/v1');
    assert.equal(customCfg.openRouter.textModel, 'custom-text-model');
    assert.equal(customCfg.openRouter.textTimeoutMs, 45000);
  });

  test('should load openRouter Text config from environment variables when overrides not provided', () => {
    process.env.OPENROUTER_TEXT_BASE_URL = 'https://env-text.openrouter.ai/v1/';
    process.env.OPENROUTER_TEXT_MODEL = 'env-text-model';
    process.env.OPENROUTER_TEXT_TIMEOUT_MS = '20000';

    const envCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(envCfg.openRouter.textBaseUrl, 'https://env-text.openrouter.ai/v1');
    assert.equal(envCfg.openRouter.textModel, 'env-text-model');
    assert.equal(envCfg.openRouter.textTimeoutMs, 20000);
  });

  test('should load openRouter routing profile defaults (PRE-040B)', () => {
    const defaultCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(defaultCfg.openRouter.fastRoutingMode, 'pinned');
    assert.equal(defaultCfg.openRouter.fastModel, 'deepseek/deepseek-v4-flash-0731');
    assert.deepEqual(defaultCfg.openRouter.fastFallbackModels, []);
    assert.equal(defaultCfg.openRouter.fastTimeoutMs, 30000);
    assert.equal(defaultCfg.openRouter.reasoningRoutingMode, 'auto');
    assert.equal(defaultCfg.openRouter.reasoningModel, 'openrouter/auto');
    assert.equal(defaultCfg.openRouter.reasoningCostTier, 'medium');
    assert.equal(defaultCfg.openRouter.autoCostTier, 'medium');
    assert.equal(defaultCfg.openRouter.reasoningTimeoutMs, 60000);
  });

  test('should load openRouter routing profile overrides directly (PRE-040B)', () => {
    const customCfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      OPENROUTER_FAST_ROUTING_MODE: 'pinned_fallback',
      OPENROUTER_FAST_MODEL: 'custom/fast-model',
      OPENROUTER_FAST_FALLBACK_MODELS: 'custom/fallback-1, custom/fallback-2, custom/fallback-3',
      OPENROUTER_FAST_TIMEOUT_MS: '15000',
      OPENROUTER_REASONING_ROUTING_MODE: 'auto',
      OPENROUTER_REASONING_MODEL: 'openrouter/auto',
      OPENROUTER_REASONING_COST_TIER: 'low',
      OPENROUTER_REASONING_TIMEOUT_MS: '45000'
    });
    assert.equal(customCfg.openRouter.fastRoutingMode, 'pinned');
    assert.equal(customCfg.openRouter.fastModel, 'custom/fast-model');
    assert.deepEqual(customCfg.openRouter.fastFallbackModels, ['custom/fallback-1', 'custom/fallback-2']);
    assert.equal(customCfg.openRouter.fastTimeoutMs, 15000);
    assert.equal(customCfg.openRouter.reasoningRoutingMode, 'auto');
    assert.equal(customCfg.openRouter.reasoningModel, 'openrouter/auto');
    assert.equal(customCfg.openRouter.reasoningCostTier, 'low');
    assert.equal(customCfg.openRouter.reasoningTimeoutMs, 45000);
  });

  test('should load webRead config defaults when environment is empty', () => {
    const defaultCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(defaultCfg.webRead.timeoutMs, 12000);
    assert.equal(defaultCfg.webRead.maxBytes, 1500000);
    assert.equal(defaultCfg.webRead.maxTextChars, 30000);
    assert.equal(defaultCfg.webRead.maxRedirects, 3);
  });

  test('should load webRead config overrides passed directly', () => {
    const customCfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      WEB_READ_TIMEOUT_MS: '5000',
      WEB_READ_MAX_BYTES: '200000',
      WEB_READ_MAX_TEXT_CHARS: '1000',
      WEB_READ_MAX_REDIRECTS: '1'
    });
    assert.equal(customCfg.webRead.timeoutMs, 5000);
    assert.equal(customCfg.webRead.maxBytes, 200000);
    assert.equal(customCfg.webRead.maxTextChars, 1000);
    assert.equal(customCfg.webRead.maxRedirects, 1);
  });

  test('should load pageQa config defaults when environment is empty', () => {
    const defaultCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(defaultCfg.pageQa.maxQuestionChars, 4000);
    assert.equal(defaultCfg.pageQa.maxOutputTokens, 1000);
  });

  test('should load pageQa config overrides passed directly', () => {
    const customCfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      PAGE_QA_MAX_QUESTION_CHARS: '2000',
      PAGE_QA_MAX_OUTPUT_TOKENS: '500'
    });
    assert.equal(customCfg.pageQa.maxQuestionChars, 2000);
    assert.equal(customCfg.pageQa.maxOutputTokens, 500);
  });

  test('should load browser config defaults when environment is empty', () => {
    const defaultCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(defaultCfg.browser.channel, 'msedge');
    assert.equal(defaultCfg.browser.headless, false);
    assert.equal(defaultCfg.browser.launchTimeoutMs, 15000);
    assert.equal(defaultCfg.browser.navigationTimeoutMs, 15000);
    assert.equal(defaultCfg.browser.inspectionMaxTextChars, 12000);
    assert.equal(defaultCfg.browser.inspectionMaxElements, 100);
    assert.equal(defaultCfg.browser.inspectionMaxElementTextChars, 300);
    assert.equal(defaultCfg.browser.dynamicTimeoutMs, 5000);
    assert.equal(defaultCfg.browser.domQuietMs, 300);
    assert.equal(defaultCfg.browser.dynamicPollMs, 100);
    assert.equal(defaultCfg.browser.maxDynamicWaits, 4);
  });

  test('should load browser config overrides passed directly', () => {
    const customCfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      BROWSER_CHANNEL: 'chrome',
      BROWSER_HEADLESS: 'true',
      BROWSER_LAUNCH_TIMEOUT_MS: '20000',
      BROWSER_NAVIGATION_TIMEOUT_MS: '25000',
      BROWSER_INSPECTION_MAX_TEXT_CHARS: '8000',
      BROWSER_INSPECTION_MAX_ELEMENTS: '50',
      BROWSER_INSPECTION_MAX_ELEMENT_TEXT_CHARS: '150',
      BROWSER_POPUP_SETTLE_MS: '650'
    });
    assert.equal(customCfg.browser.channel, 'chrome');
    assert.equal(customCfg.browser.headless, true);
    assert.equal(customCfg.browser.launchTimeoutMs, 20000);
    assert.equal(customCfg.browser.navigationTimeoutMs, 25000);
    assert.equal(customCfg.browser.inspectionMaxTextChars, 8000);
    assert.equal(customCfg.browser.inspectionMaxElements, 50);
    assert.equal(customCfg.browser.inspectionMaxElementTextChars, 150);
    assert.equal(customCfg.browser.popupSettleMs, 650);
  });

  test('should load browser config from environment variables when overrides not provided', () => {
    process.env.BROWSER_CHANNEL = 'msedge';
    process.env.BROWSER_HEADLESS = 'false';
    process.env.BROWSER_LAUNCH_TIMEOUT_MS = '10000';
    process.env.BROWSER_NAVIGATION_TIMEOUT_MS = '12000';
    process.env.BROWSER_INSPECTION_MAX_TEXT_CHARS = '15000';
    process.env.BROWSER_INSPECTION_MAX_ELEMENTS = '200';
    process.env.BROWSER_INSPECTION_MAX_ELEMENT_TEXT_CHARS = '400';
    process.env.BROWSER_POPUP_SETTLE_MS = '700';

    const envCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(envCfg.browser.channel, 'msedge');
    assert.equal(envCfg.browser.headless, false);
    assert.equal(envCfg.browser.launchTimeoutMs, 10000);
    assert.equal(envCfg.browser.navigationTimeoutMs, 12000);
    assert.equal(envCfg.browser.inspectionMaxTextChars, 15000);
    assert.equal(envCfg.browser.inspectionMaxElements, 200);
    assert.equal(envCfg.browser.inspectionMaxElementTextChars, 400);
    assert.equal(envCfg.browser.popupSettleMs, 700);
  });

  test('should handle invalid and bound inspection config values safely', () => {
    const clampedCfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      BROWSER_INSPECTION_MAX_TEXT_CHARS: '-5',
      BROWSER_INSPECTION_MAX_ELEMENTS: '0',
      BROWSER_INSPECTION_MAX_ELEMENT_TEXT_CHARS: 'invalid',
      BROWSER_POPUP_SETTLE_MS: '-10'
    });
    assert.equal(clampedCfg.browser.inspectionMaxTextChars, 1);
    assert.equal(clampedCfg.browser.inspectionMaxElements, 1);
    assert.equal(clampedCfg.browser.inspectionMaxElementTextChars, 300);
    assert.equal(clampedCfg.browser.popupSettleMs, 1);
  });

  test('should default popupSettleMs to 500ms when not specified', () => {
    const defaultCfg = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    assert.equal(defaultCfg.browser.popupSettleMs, 500);
  });

  test('should load dynamic wait config overrides and clamp unsafe values (Brick 32)', () => {
    const customCfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      BROWSER_DYNAMIC_TIMEOUT_MS: '8000',
      BROWSER_DOM_QUIET_MS: '450',
      BROWSER_DYNAMIC_POLL_MS: '200',
      BROWSER_MAX_DYNAMIC_WAITS: '8'
    });
    assert.equal(customCfg.browser.dynamicTimeoutMs, 8000);
    assert.equal(customCfg.browser.domQuietMs, 450);
    assert.equal(customCfg.browser.dynamicPollMs, 200);
    assert.equal(customCfg.browser.maxDynamicWaits, 8);

    const clampedUnder = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      BROWSER_DYNAMIC_TIMEOUT_MS: '10', // min 100
      BROWSER_DOM_QUIET_MS: '5',        // min 50
      BROWSER_DYNAMIC_POLL_MS: '1',     // min 20
      BROWSER_MAX_DYNAMIC_WAITS: '0'    // min 1
    });
    assert.equal(clampedUnder.browser.dynamicTimeoutMs, 100);
    assert.equal(clampedUnder.browser.domQuietMs, 50);
    assert.equal(clampedUnder.browser.dynamicPollMs, 20);
    assert.equal(clampedUnder.browser.maxDynamicWaits, 1);

    const clampedOver = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      BROWSER_DYNAMIC_TIMEOUT_MS: '999999', // max 60000
      BROWSER_DOM_QUIET_MS: '99999',       // max 5000
      BROWSER_DYNAMIC_POLL_MS: '5000',      // max 1000
      BROWSER_MAX_DYNAMIC_WAITS: '100'      // max 20
    });
    assert.equal(clampedOver.browser.dynamicTimeoutMs, 60000);
    assert.equal(clampedOver.browser.domQuietMs, 5000);
    assert.equal(clampedOver.browser.dynamicPollMs, 1000);
    assert.equal(clampedOver.browser.maxDynamicWaits, 20);

    const invalidCfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      BROWSER_DYNAMIC_TIMEOUT_MS: 'not_a_number',
      BROWSER_DOM_QUIET_MS: 'invalid',
      BROWSER_DYNAMIC_POLL_MS: 'abc',
      BROWSER_MAX_DYNAMIC_WAITS: 'xyz'
    });
    assert.equal(invalidCfg.browser.dynamicTimeoutMs, 5000);
    assert.equal(invalidCfg.browser.domQuietMs, 300);
    assert.equal(invalidCfg.browser.dynamicPollMs, 100);
    assert.equal(invalidCfg.browser.maxDynamicWaits, 4);
  });
});


