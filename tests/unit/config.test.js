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
    'OPENROUTER_STT_BASE_URL',
    'OPENROUTER_STT_MODEL',
    'OPENROUTER_STT_TIMEOUT_MS',
    'OPENROUTER_TTS_BASE_URL',
    'OPENROUTER_TTS_MODEL',
    'OPENROUTER_TTS_VOICE',
    'OPENROUTER_TTS_TIMEOUT_MS'
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
});
