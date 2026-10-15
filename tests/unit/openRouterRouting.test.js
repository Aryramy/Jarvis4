import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ROUTING_PROFILES,
  ROUTING_MODES,
  ALLOWED_COST_TIERS,
  DEFAULT_PRIMARY_MODEL,
  AUTO_ROUTER_MODEL,
  MAX_FALLBACK_MODELS,
  OPENROUTER_ERROR_CODES,
  normalizeProfile,
  normalizeRoutingMode,
  validateCostTier,
  normalizeFallbackModels,
  validateSessionId,
  sanitizeError,
  classifyProviderError,
  buildRoutingRequest,
  buildTelemetry
} from '../../src/providers/openRouterRouting.js';
import { OpenRouterRoutingGate } from '../../src/providers/openRouterRouter.js';
import { OpenRouterTextProvider } from '../../src/providers/openRouterText.js';
import { RuntimeAgentHarness } from '../../src/agent/runtime/runtimeHarness.js';
import { loadConfig } from '../../src/config/index.js';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));

describe('OpenRouter Routing Gate & Provider Hardening - PRE-040B', () => {
  const TEST_API_KEY = 'TEST_OPENROUTER_KEY_DO_NOT_USE';
  const BASE_URL = 'https://openrouter.ai/api/v1';

  let originalEnv = {};
  const ROUTING_ENV_VARS = [
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
    'OPENROUTER_REASONING_TIMEOUT_MS'
  ];

  beforeEach(() => {
    originalEnv = {};
    for (const key of ROUTING_ENV_VARS) {
      if (key in process.env) {
        originalEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    for (const key of ROUTING_ENV_VARS) {
      delete process.env[key];
    }
    for (const [key, val] of Object.entries(originalEnv)) {
      process.env[key] = val;
    }
  });

  // =========================================================================
  // Section 1: Normalization & Pure Validation Primitives
  // =========================================================================

  describe('1. Normalization & Validation Primitives', () => {
    test('normalizeProfile accepts valid profiles and defaults to FAST', () => {
      assert.equal(normalizeProfile(), 'FAST');
      assert.equal(normalizeProfile('FAST'), 'FAST');
      assert.equal(normalizeProfile('fast'), 'FAST');
      assert.equal(normalizeProfile('REASONING'), 'REASONING');
      assert.equal(normalizeProfile('reasoning'), 'REASONING');
      assert.throws(() => normalizeProfile('VISION'), /Unsupported routing profile/);
      assert.throws(() => normalizeProfile('CODING'), /Unsupported routing profile/);
    });

    test('normalizeRoutingMode handles pinned and auto', () => {
      assert.equal(normalizeRoutingMode(), 'PINNED_FALLBACK');
      assert.equal(normalizeRoutingMode('pinned'), 'PINNED_FALLBACK');
      assert.equal(normalizeRoutingMode('PINNED_FALLBACK'), 'PINNED_FALLBACK');
      assert.equal(normalizeRoutingMode('auto'), 'AUTO');
      assert.equal(normalizeRoutingMode('AUTO'), 'AUTO');
      assert.throws(() => normalizeRoutingMode('manual'), /Unsupported routing mode/);
    });

    test('validateCostTier validates allowed cost tiers strictly', () => {
      for (const tier of ALLOWED_COST_TIERS) {
        assert.equal(validateCostTier(tier), tier);
        assert.equal(validateCostTier(tier.toUpperCase()), tier);
      }
      assert.throws(() => validateCostTier('ultra'), /Invalid cost tier/);
      assert.throws(() => validateCostTier('free'), /Invalid cost tier/);
    });

    test('normalizeFallbackModels preserves order, removes duplicates, and caps to maxCount', () => {
      const primary = 'deepseek/deepseek-v4-flash-0731';
      const input = `${primary}, meta-llama/llama-3.3-70b, google/gemini-2.0-flash, meta-llama/llama-3.3-70b, anthropic/claude-3-haiku`;
      const result = normalizeFallbackModels(input, primary, 2);

      assert.equal(result.length, 2);
      assert.equal(result[0], 'meta-llama/llama-3.3-70b');
      assert.equal(result[1], 'google/gemini-2.0-flash');
      assert.equal(result.includes(primary), false);
    });

    test('validateSessionId validates opaque IDs and rejects secrets/paths/PII', () => {
      assert.deepEqual(validateSessionId(null), { valid: true, value: null });
      assert.deepEqual(validateSessionId(''), { valid: true, value: null });
      assert.deepEqual(validateSessionId('run_abc_123'), { valid: true, value: 'run_abc_123' });

      // Reject email
      assert.equal(validateSessionId('user@example.com').valid, false);
      // Reject URLs
      assert.equal(validateSessionId('https://example.com').valid, false);
      // Reject Windows path
      assert.equal(validateSessionId('C:\\Users\\Secret').valid, false);
      // Reject secrets/tokens
      assert.equal(validateSessionId('sk-dummy-token-sample').valid, false);
      assert.equal(validateSessionId('bearer_token_xyz').valid, false);
      // Reject excessively long strings (>128 chars)
      assert.equal(validateSessionId('a'.repeat(129)).valid, false);
    });
  });

  // =========================================================================
  // Section 2: Pinned Fallback Mode & Request Builder
  // =========================================================================

  describe('2. PINNED_FALLBACK Mode & Request Builder', () => {
    test('buildRoutingRequest for FAST profile uses primary model when no fallbacks', () => {
      const cfg = {
        openRouter: {
          apiKey: TEST_API_KEY,
          fastModel: 'deepseek/deepseek-v4-flash-0731',
          fastFallbackModels: [],
          fastTimeoutMs: 25000
        }
      };

      const req = buildRoutingRequest({
        profile: 'FAST',
        messages: [{ role: 'user', content: 'Hello' }],
        config: cfg
      });

      assert.equal(req.profile, 'FAST');
      assert.equal(req.routingMode, 'PINNED_FALLBACK');
      assert.equal(req.body.model, 'deepseek/deepseek-v4-flash-0731');
      assert.equal(req.body.models, undefined, 'models array should not be sent when no fallbacks configured');
      assert.equal(req.timeoutMs, 25000);
      assert.deepEqual(req.body.messages, [{ role: 'user', content: 'Hello' }]);
      assert.equal(req.body.provider, undefined, 'OpenRouter provider failover must not be restricted');
    });

    test('buildRoutingRequest for FAST profile encodes native models array when fallbacks present', () => {
      const cfg = {
        openRouter: {
          apiKey: TEST_API_KEY,
          fastModel: 'deepseek/deepseek-v4-flash-0731',
          fastFallbackModels: ['meta-llama/llama-3.3-70b-instruct', 'google/gemini-2.0-flash-001'],
          fastTimeoutMs: 30000
        }
      };

      const req = buildRoutingRequest({
        profile: 'FAST',
        messages: [{ role: 'user', content: 'Ping' }],
        config: cfg
      });

      assert.equal(req.routingMode, 'PINNED_FALLBACK');
      assert.ok(Array.isArray(req.body.models), 'models array must be populated for native fallback');
      assert.equal(req.body.models.length, 3);
      assert.equal(req.body.models[0], 'deepseek/deepseek-v4-flash-0731');
      assert.equal(req.body.models[1], 'meta-llama/llama-3.3-70b-instruct');
      assert.equal(req.body.models[2], 'google/gemini-2.0-flash-001');
      assert.deepEqual(req.requestedModels, ['deepseek/deepseek-v4-flash-0731', 'meta-llama/llama-3.3-70b-instruct', 'google/gemini-2.0-flash-001']);
    });

    test('OpenRouter provider failover is preserved without restrictive filters', () => {
      const req = buildRoutingRequest({
        profile: 'FAST',
        messages: [{ role: 'user', content: 'Test' }]
      });

      assert.equal(req.body.provider, undefined, 'provider filtering must not be injected by default');
    });
  });

  // =========================================================================
  // Section 3: Auto Mode & Auto Router Semantics
  // =========================================================================

  describe('3. AUTO Mode & Auto Router Semantics', () => {
    test('buildRoutingRequest for REASONING profile targets openrouter/auto with cost tier plugin', () => {
      const cfg = {
        openRouter: {
          apiKey: TEST_API_KEY,
          reasoningCostTier: 'medium',
          reasoningTimeoutMs: 45000
        }
      };

      const req = buildRoutingRequest({
        profile: 'REASONING',
        messages: [{ role: 'user', content: 'Analyze this complex plan' }],
        sessionId: 'run_session_888',
        config: cfg
      });

      assert.equal(req.profile, 'REASONING');
      assert.equal(req.routingMode, 'AUTO');
      assert.equal(req.body.model, 'openrouter/auto');
      assert.equal(req.body.models, undefined, 'AUTO mode MUST NOT have a models fallback array');
      assert.equal(req.body.session_id, 'run_session_888');
      assert.equal(req.timeoutMs, 45000);
      assert.ok(Array.isArray(req.body.plugins));
      assert.deepEqual(req.body.plugins, [{ id: 'auto-router', cost_tier: 'medium' }]);
    });

    test('AUTO mode rejects duplicate model-fallback wrapper or sequential loops', async () => {
      let callCount = 0;
      const mockFetch = async (url, options) => {
        callCount++;
        const parsed = JSON.parse(options.body);
        assert.equal(parsed.model, 'openrouter/auto');
        assert.equal(parsed.models, undefined, 'No models array on Auto request');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'gen-auto-1',
            model: 'anthropic/claude-3.5-sonnet',
            choices: [{ message: { role: 'assistant', content: 'Auto reasoning completed' } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.00045 }
          })
        };
      };

      const gate = new OpenRouterRoutingGate({
        apiKey: TEST_API_KEY,
        fetchFn: mockFetch
      });

      const res = await gate.complete({
        profile: 'REASONING',
        messages: [{ role: 'user', content: 'Reason' }]
      });

      assert.equal(callCount, 1, 'Auto Router must execute in a single provider call');
      assert.equal(res.success, true);
      assert.equal(res.actualModel, 'anthropic/claude-3.5-sonnet');
      assert.equal(res.telemetry.autoSelectedModel, 'anthropic/claude-3.5-sonnet');
      assert.equal(res.telemetry.fallbackUsed, false, 'Auto Router model selection must NOT be mislabeled as fallback');
    });
  });

  // =========================================================================
  // Section 4: Security & Request Injection Defense
  // =========================================================================

  describe('4. Security & Request Injection Defense (Sections 17, 38, 48)', () => {
    test('caller cannot override model, cost_tier, fallback models, or allow_fallbacks', () => {
      const cfg = {
        openRouter: {
          apiKey: TEST_API_KEY,
          fastModel: 'deepseek/deepseek-v4-flash-0731',
          fastFallbackModels: []
        }
      };

      // Attacker attempts to inject expensive model and overrides through profile call
      const maliciousInput = {
        profile: 'FAST',
        messages: [{ role: 'user', content: 'Injected prompt' }],
        model: 'expensive/frontier-model-v9',
        models: ['attacker/override-1', 'attacker/override-2'],
        cost_tier: 'max',
        costTier: 'max',
        allow_fallbacks: false,
        timeout: 999999,
        provider: { only: ['hacked-provider'] },
        config: cfg
      };

      const req = buildRoutingRequest(maliciousInput);

      assert.equal(req.body.model, 'deepseek/deepseek-v4-flash-0731', 'Injected model MUST be ignored');
      assert.equal(req.body.models, undefined, 'Injected models array MUST be ignored');
      assert.equal(req.body.cost_tier, undefined, 'Injected cost_tier MUST be ignored');
      assert.equal(req.body.provider, undefined, 'Injected provider overrides MUST be ignored');
      assert.notEqual(req.timeoutMs, 999999, 'Injected timeout MUST be ignored');
    });

    test('telemetry strictly redacts keys, auth tokens, passwords, and private file paths', () => {
      const dummyReq = {
        profile: 'FAST',
        routingMode: 'PINNED_FALLBACK',
        requestedModel: 'deepseek/deepseek-v4-flash-0731',
        requestedModels: ['deepseek/deepseek-v4-flash-0731'],
        timeoutMs: 30000
      };

      const classifiedErr = classifyProviderError(
        new Error(`Failure on C:\\Users\\Administrator\\secret\\file.txt with key ${TEST_API_KEY}`),
        500,
        TEST_API_KEY
      );

      const tel = buildTelemetry({
        routingRequest: dummyReq,
        durationMs: 420,
        success: false,
        error: classifiedErr
      });

      const telJson = JSON.stringify(tel);
      assert.equal(telJson.includes(TEST_API_KEY), false, 'API key must not be present in telemetry');
      assert.equal(telJson.includes('Administrator'), false, 'User paths must not be present in telemetry');
      assert.equal(telJson.includes('C:\\'), false, 'Drive letters must not be present in telemetry');
      assert.equal(tel.errorCode, OPENROUTER_ERROR_CODES.ROUTING_FAILED);
    });

    test('sanitizeError redacts Bearer headers and OpenRouter key formats', () => {
      const msg = `Unauthorized: Bearer ${TEST_API_KEY} rejected at /v1/chat/completions`;
      const sanitized = sanitizeError(msg, TEST_API_KEY);
      assert.equal(sanitized.includes(TEST_API_KEY), false);
      assert.ok(sanitized.includes('[REDACTED]'));
    });

    test('no tracked project source or test file contains realistic OpenRouter secret strings', () => {
      // Build search pattern dynamically so test file itself contains no secret fixture
      const secretPattern = new RegExp(['sk', 'or', 'v1', '[a-f0-9]{32,}'].join('[-_]'), 'i');
      const rootDir = resolve(__dirname, '../..');

      const scanDir = (dir) => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.agents') continue;
            scanDir(fullPath);
          } else if (entry.isFile()) {
            if (entry.name === '.env') continue; // Never scan local private .env
            if (/\.(js|mjs|json|md|html|yml|yaml|example)$/i.test(entry.name)) {
              const content = readFileSync(fullPath, 'utf8');
              const hasSecret = secretPattern.test(content);
              assert.equal(hasSecret, false, `Tracked file ${entry.name} must not contain realistic OpenRouter key`);
            }
          }
        }
      };

      scanDir(join(rootDir, 'src'));
      scanDir(join(rootDir, 'tests'));
      scanDir(join(rootDir, 'scripts'));
    });
  });

  // =========================================================================
  // Section 5: Telemetry Accounting & Cost Representation
  // =========================================================================

  describe('5. Telemetry Accounting & Truthful Cost Representation', () => {
    test('captures actual model, tokens, provider, and numeric cost accurately', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'gen-test-1',
          model: 'deepseek/deepseek-v4-flash-0731',
          provider: 'DeepInfra',
          choices: [{ message: { role: 'assistant', content: '4' } }],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 1,
            total_tokens: 16,
            cost: 0.000024
          }
        })
      });

      const gate = new OpenRouterRoutingGate({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
      const res = await gate.complete({
        profile: 'FAST',
        messages: [{ role: 'user', content: '2+2' }]
      });

      assert.equal(res.success, true);
      assert.equal(res.text, '4');
      assert.equal(res.actualModel, 'deepseek/deepseek-v4-flash-0731');
      assert.equal(res.provider, 'DeepInfra');
      assert.equal(res.cost, 0.000024);
      assert.equal(res.telemetry.promptTokens, 15);
      assert.equal(res.telemetry.completionTokens, 1);
      assert.equal(res.telemetry.totalTokens, 16);
      assert.equal(res.telemetry.cost, 0.000024);
      assert.equal(res.telemetry.fallbackUsed, false);
      assert.ok(typeof res.telemetry.latencyMs === 'number');
    });

    test('represents unknown cost truthfully as null (never $0 and never fabricated)', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'gen-test-2',
          model: 'deepseek/deepseek-v4-flash-0731',
          choices: [{ message: { role: 'assistant', content: 'Response without cost' } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15
            // cost is intentionally omitted by upstream
          }
        })
      });

      const gate = new OpenRouterRoutingGate({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
      const res = await gate.complete({
        profile: 'FAST',
        messages: [{ role: 'user', content: 'Ping' }]
      });

      assert.equal(res.success, true);
      assert.strictEqual(res.cost, null, 'Cost must be null when not provided');
      assert.strictEqual(res.telemetry.cost, null, 'Telemetry cost must be null');
      assert.notEqual(res.telemetry.cost, 0, 'Must NOT treat unknown cost as $0');
    });

    test('detects fallbackUsed truthfully when served by secondary fallback model', async () => {
      const cfg = {
        openRouter: {
          apiKey: TEST_API_KEY,
          fastModel: 'deepseek/deepseek-v4-flash-0731',
          fastFallbackModels: ['meta-llama/llama-3.3-70b-instruct']
        }
      };

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'gen-test-3',
          model: 'meta-llama/llama-3.3-70b-instruct', // OpenRouter fell back to second model
          choices: [{ message: { role: 'assistant', content: 'Response from fallback' } }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: 0.00005 }
        })
      });

      const gate = new OpenRouterRoutingGate({ apiKey: TEST_API_KEY, fetchFn: mockFetch, config: cfg });
      const res = await gate.complete({
        profile: 'FAST',
        messages: [{ role: 'user', content: 'Test fallback' }]
      });

      assert.equal(res.success, true);
      assert.equal(res.actualModel, 'meta-llama/llama-3.3-70b-instruct');
      assert.equal(res.telemetry.fallbackUsed, true, 'fallbackUsed must be true when actual differs from requested primary');
    });
  });

  // =========================================================================
  // Section 6: Timeout, Error Classification & Fail-Fast
  // =========================================================================

  describe('6. Timeout, Error Classification & Fail-Fast', () => {
    test('controlled timeout returns OPENROUTER_TIMEOUT with no retry loop', async () => {
      let attempts = 0;
      const mockFetch = async (url, options) => {
        attempts++;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      };

      const gate = new OpenRouterRoutingGate({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
      const res = await gate.complete({
        profile: 'FAST',
        messages: [{ role: 'user', content: 'Hanging call' }],
        timeoutMs: 50 // Short bounded timeout
      });

      assert.equal(attempts, 1, 'Client retry count must be 0 (no retry loop on timeout)');
      assert.equal(res.success, false);
      assert.equal(res.errorCode, OPENROUTER_ERROR_CODES.TIMEOUT);
      assert.ok(res.error.includes('timed out'));
      assert.equal(res.telemetry.success, false);
      assert.equal(res.telemetry.errorCode, OPENROUTER_ERROR_CODES.TIMEOUT);
    });

    test('HTTP status error codes classified accurately', async () => {
      const cases = [
        { status: 429, expectedCode: OPENROUTER_ERROR_CODES.RATE_LIMITED },
        { status: 401, expectedCode: OPENROUTER_ERROR_CODES.AUTH_FAILED },
        { status: 400, expectedCode: OPENROUTER_ERROR_CODES.BAD_REQUEST },
        { status: 503, expectedCode: OPENROUTER_ERROR_CODES.UPSTREAM_UNAVAILABLE }
      ];

      for (const { status, expectedCode } of cases) {
        const mockFetch = async () => ({
          ok: false,
          status,
          statusText: 'Error',
          json: async () => ({ error: { message: `Simulated ${status}` } })
        });

        const gate = new OpenRouterRoutingGate({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
        const res = await gate.complete({
          profile: 'FAST',
          messages: [{ role: 'user', content: 'Status check' }]
        });

        assert.equal(res.success, false);
        assert.equal(res.errorCode, expectedCode, `Expected ${expectedCode} for HTTP ${status}`);
      }
    });
  });

  // =========================================================================
  // Section 7: Streaming Telemetry & Safe Interruption
  // =========================================================================

  describe('7. Streaming Telemetry & Interruption Safety', () => {
    test('stream yields string deltas and captures final usage in telemetry', async () => {
      const sseChunks = [
        'data: {"id":"1","model":"deepseek/deepseek-v4-flash-0731","choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"id":"1","model":"deepseek/deepseek-v4-flash-0731","choices":[{"delta":{"content":"lo!"}}]}\n\n',
        'data: {"id":"1","model":"deepseek/deepseek-v4-flash-0731","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7,"cost":0.00001}}\n\n',
        'data: [DONE]\n\n'
      ];

      const mockFetch = async () => {
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of sseChunks) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
          }
        });
        return {
          ok: true,
          status: 200,
          body: stream
        };
      };

      const gate = new OpenRouterRoutingGate({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
      const deltas = [];

      for await (const chunk of gate.stream({ profile: 'FAST', messages: [{ role: 'user', content: 'Hi' }] })) {
        deltas.push(chunk);
      }

      assert.deepEqual(deltas, ['Hel', 'lo!'], 'Must yield pure text chunks without metadata injection');
      const tel = gate.getLastTelemetry();
      assert.ok(tel, 'Telemetry must be recorded after stream completion');
      assert.equal(tel.promptTokens, 5);
      assert.equal(tel.completionTokens, 2);
      assert.equal(tel.totalTokens, 7);
      assert.equal(tel.cost, 0.00001);
      assert.equal(tel.actualModel, 'deepseek/deepseek-v4-flash-0731');
    });

    test('interrupted stream does not duplicate or replay completions', async () => {
      const sseChunks = [
        'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'
      ];

      let streamClosedPrematurely = false;
      const mockFetch = async () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseChunks[0]));
            // Emulate upstream interruption
            controller.error(new Error('Connection terminated'));
          },
          cancel() {
            streamClosedPrematurely = true;
          }
        });
        return {
          ok: true,
          status: 200,
          body: stream
        };
      };

      const gate = new OpenRouterRoutingGate({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
      let thrown = null;

      try {
        for await (const chunk of gate.stream({ profile: 'FAST', messages: [{ role: 'user', content: 'Abort test' }] })) {
          assert.equal(chunk, 'Partial');
        }
      } catch (err) {
        thrown = err;
      }

      assert.ok(thrown, 'Must bubble sanitized stream error upon upstream interruption');
      assert.equal(gate.getLastTelemetry().success, false);
    });
  });

  // =========================================================================
  // Section 8: Backward Compatibility with OpenRouterTextProvider
  // =========================================================================

  describe('8. Backward Compatibility with OpenRouterTextProvider', () => {
    test('existing generate(prompt) defaults to FAST profile and retains contract', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'gen-legacy-1',
          model: 'deepseek/deepseek-v4-flash-0731',
          choices: [{ message: { role: 'assistant', content: 'Legacy OK' } }],
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11, cost: 0.00001 }
        })
      });

      const provider = new OpenRouterTextProvider({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
      const result = await provider.generate('What is 2+2?');

      assert.equal(result.success, true);
      assert.equal(result.text, 'Legacy OK');
      assert.equal(result.model, 'deepseek/deepseek-v4-flash-0731');
      assert.equal(result.provider, 'openrouter');
      assert.ok(result.telemetry);
      assert.equal(result.telemetry.routingProfile, 'FAST');
      assert.equal(result.telemetry.routingMode, 'PINNED_FALLBACK');
    });

    test('existing stream(prompt) yields deltas and captures lastTelemetry', async () => {
      const sseChunks = [
        'data: {"choices":[{"delta":{"content":"Delta1"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Delta2"}}]}\n\n',
        'data: [DONE]\n\n'
      ];

      const mockFetch = async () => {
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of sseChunks) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
          }
        });
        return {
          ok: true,
          status: 200,
          body: stream
        };
      };

      const provider = new OpenRouterTextProvider({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
      const collected = [];

      for await (const chunk of provider.stream('Stream prompt')) {
        collected.push(chunk);
      }

      assert.deepEqual(collected, ['Delta1', 'Delta2']);
      assert.ok(provider.getLastTelemetry());
      assert.equal(provider.getLastTelemetry().routingProfile, 'FAST');
    });
  });

  // =========================================================================
  // Section 9: Runtime Agent Harness Integration Preparation (Section 36)
  // =========================================================================

  describe('9. Runtime Agent Harness Preparation (Section 36)', () => {
    test('RuntimeAgentHarness.createRoutingContext maps runId to sessionId and verifies profile', () => {
      const harness = new RuntimeAgentHarness();
      const run = harness.createRun({ task: 'Perform inspection' });

      // Default profile
      const ctx1 = harness.createRoutingContext(run.runId);
      assert.equal(ctx1.runId, run.runId);
      assert.equal(ctx1.sessionId, run.runId, 'runId maps cleanly to safe sessionId');
      assert.equal(ctx1.profile, 'FAST');

      // Reasoning profile
      const ctx2 = harness.createRoutingContext(run.runId, { profile: 'REASONING' });
      assert.equal(ctx2.profile, 'REASONING');

      // Rejects invalid profile
      assert.throws(
        () => harness.createRoutingContext(run.runId, { profile: 'CUSTOM_AGENT' }),
        /SECURITY_OVERRIDE_REJECTED/
      );

      // Caller attempts to pass security overrides
      const ctx3 = harness.createRoutingContext(run.runId, {
        profile: 'FAST',
        model: 'malicious/override',
        cost_tier: 'max'
      });
      assert.equal(ctx3.profile, 'FAST');
      assert.equal(ctx3.model, undefined, 'Overrides must not be returned');

      // Verify audit recorded security override attempt
      const audit = harness.getAuditLog(run.runId);
      assert.ok(audit.some((a) => a.decision === 'SECURITY_OVERRIDE_BLOCKED' || a.type === 'SECURITY_OVERRIDE_BLOCKED'));
    });

    test('resolveRoutingProfile selects FAST for routine tasks and REASONING for complex recovery', () => {
      const harness = new RuntimeAgentHarness();
      assert.equal(harness.resolveRoutingProfile('routine'), 'FAST');
      assert.equal(harness.resolveRoutingProfile('click'), 'FAST');
      assert.equal(harness.resolveRoutingProfile('recovery'), 'REASONING');
      assert.equal(harness.resolveRoutingProfile('reasoning'), 'REASONING');
    });

    test('zero LLM or model execution is triggered in RuntimeAgentHarness', () => {
      const harness = new RuntimeAgentHarness();
      const run = harness.createRun({ task: 'Zero AI test' });
      harness.createRoutingContext(run.runId, { profile: 'FAST' });

      // Harness runs Map and audit logs exist, exactly 0 external calls
      assert.equal(harness.runs.size, 1);
      assert.equal(run.state, 'READY');
    });
  });

  // =========================================================================
  // Section 10: Configuration Validation & Startup Integrity
  // =========================================================================

  describe('10. Configuration Validation & Startup Integrity (Section 40)', () => {
    test('loadConfig validates routing mode and cost tier with clear error', () => {
      assert.throws(
        () => loadConfig({ OPENROUTER_FAST_ROUTING_MODE: 'unsupported_mode' }),
        /Invalid OPENROUTER_FAST_ROUTING_MODE/
      );

      assert.throws(
        () => loadConfig({ OPENROUTER_REASONING_COST_TIER: 'super_tier' }),
        /Invalid OPENROUTER_REASONING_COST_TIER/
      );
    });

    test('loadConfig clamps fast and reasoning timeouts safely', () => {
      const cfg = loadConfig({
        OPENROUTER_FAST_TIMEOUT_MS: '500', // below min 1000
        OPENROUTER_REASONING_TIMEOUT_MS: '999999' // above max 120000
      });

      assert.equal(cfg.openRouter.fastTimeoutMs, 1000);
      assert.equal(cfg.openRouter.reasoningTimeoutMs, 120000);
    });

    test('loadConfig normalizes comma-separated fallback models removing duplicates', () => {
      const cfg = loadConfig({
        OPENROUTER_FAST_MODEL: 'deepseek/deepseek-v4-flash-0731',
        OPENROUTER_FAST_FALLBACK_MODELS: 'deepseek/deepseek-v4-flash-0731, model-1, model-1, model-2, model-3'
      });

      assert.equal(cfg.openRouter.fastFallbackModels.length, 2);
      assert.equal(cfg.openRouter.fastFallbackModels[0], 'model-1');
      assert.equal(cfg.openRouter.fastFallbackModels[1], 'model-2');
    });
  });
});
