#!/usr/bin/env node

/**
 * Cross-Gateway Same-Model AI Latency Benchmark Tool for JARVIS4 (Brick 16).
 *
 * Compares latency for DeepSeek V4 Flash 0731 between:
 * - Gateway A: Cheaper Inference / OmniRoute (deepseek-v4-flash-0731)
 * - Gateway B: OpenRouter (deepseek/deepseek-v4-flash-0731)
 *
 * STRICT SAFETY RULES:
 * - Benchmark ONLY. Production configuration remains UNCHANGED.
 * - Does NOT alter production CHEAPER_INFERENCE_MODEL.
 * - Does NOT modify /api/ai routing or add automatic fallbacks.
 * - Never invoked automatically by verify, web server, or automated test suites.
 * - Strictly redacts all secrets and API keys from outputs and saved results.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');

export const CHEAPER_TARGET_MODEL = 'deepseek-v4-flash-0731';
export const OPENROUTER_TARGET_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const DEFAULT_BENCHMARK_PROMPT = 'What is 2 + 2? Answer with only the number.';
export const DEFAULT_TRIALS_PER_GATEWAY = 3;
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_TOKENS = 50;
export const DEFAULT_TEMPERATURE = 0.1;
export const DEFAULT_MAX_REQUESTS = 6; // 3 Cheaper + 3 OpenRouter

export const DEFAULT_OUTPUT_JSON = resolve(ROOT_DIR, 'runtime', 'ai-gateway-benchmark-latest.json');
export const DEFAULT_OUTPUT_TXT = resolve(ROOT_DIR, 'runtime', 'ai-gateway-benchmark-latest.txt');

/**
 * Sanitizes any string to ensure secrets are never leaked.
 *
 * @param {string} text
 * @param {Array<string>} [secrets]
 * @returns {string}
 */
export function sanitizeSecret(text, secrets = []) {
  if (!text || typeof text !== 'string') return '';
  let safe = text;

  const keyList = [
    ...(Array.isArray(secrets) ? secrets : [secrets]),
    process.env.CHEAPER_INFERENCE_API_KEY,
    config.cheaperInference?.apiKey,
    process.env.OPENROUTER_API_KEY,
    config.openRouter?.apiKey
  ].filter(k => k && typeof k === 'string' && k.trim().length > 0);

  for (const k of keyList) {
    safe = safe.replaceAll(k, '[REDACTED]');
  }

  return safe;
}

/**
 * Evaluates semantic correctness for the simple benchmark prompt.
 * Expected answer is 4. Harmless formatting like "4", "4." allowed.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function evaluateCorrectness(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return /^4\.?$/.test(trimmed);
}

/**
 * Verifies that the required model is available on OpenRouter.
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} targetModel
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ available: boolean, error?: string, modelId?: string }>}
 */
export async function verifyOpenRouterModelAvailability(
  baseUrl = 'https://openrouter.ai/api/v1',
  apiKey = '',
  targetModel = OPENROUTER_TARGET_MODEL,
  fetchFn = globalThis.fetch
) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return { available: false, error: 'OpenRouter API key is required to verify model availability' };
  }

  const cleanBase = baseUrl.trim().replace(/\/+$/, '');
  const endpoint = `${cleanBase}/models`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error('Model catalog request timed out after 15000ms'));
  }, 15000);

  try {
    const response = await fetchFn(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      let errDetail = '';
      try {
        const errJson = await response.json();
        errDetail = errJson.error?.message || errJson.message || JSON.stringify(errJson);
      } catch {
        errDetail = response.statusText;
      }
      return {
        available: false,
        error: `OpenRouter model check HTTP ${response.status}: ${sanitizeSecret(errDetail, [apiKey])}`
      };
    }

    const json = await response.json();
    const list = Array.isArray(json) ? json : (json?.data || json?.models || []);
    const match = list.find(m => m.id === targetModel);

    if (match) {
      return { available: true, modelId: match.id };
    }

    return {
      available: false,
      error: `Target model "${targetModel}" was NOT found in OpenRouter model catalog (${list.length} models available). Silent model substitution is prohibited.`
    };
  } catch (err) {
    return {
      available: false,
      error: `Failed to query OpenRouter model catalog: ${sanitizeSecret(err?.message, [apiKey])}`
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Executes a single OpenAI-compatible chat completion request with monotonic timing.
 *
 * @param {Object} gatewayConfig
 * @param {string} gatewayConfig.name
 * @param {string} gatewayConfig.baseUrl
 * @param {string} gatewayConfig.apiKey
 * @param {string} gatewayConfig.model
 * @param {string} prompt
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {typeof fetch} [options.fetchFn]
 * @returns {Promise<Object>}
 */
export async function executeGatewayRequest(gatewayConfig, prompt, options = {}) {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const fetchFn = options.fetchFn || globalThis.fetch;

  const endpoint = `${gatewayConfig.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  let timeoutId = null;

  if (timeout > 0 && typeof setTimeout === 'function') {
    timeoutId = setTimeout(() => {
      controller.abort(new Error(`Request timed out after ${timeout}ms`));
    }, timeout);
  }

  const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  const getDurationMs = () => {
    const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    return Math.max(0, Math.round(now - startTime));
  };

  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayConfig.apiKey}`
      },
      body: JSON.stringify({
        model: gatewayConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
        stream: false
      }),
      signal: controller.signal
    });

    const durationMs = getDurationMs();

    if (!response.ok) {
      let errDetail = '';
      try {
        const errJson = await response.json();
        errDetail = errJson.error?.message || errJson.message || JSON.stringify(errJson);
      } catch {
        try {
          errDetail = await response.text();
        } catch {
          errDetail = response.statusText;
        }
      }
      const safeError = sanitizeSecret(errDetail || response.statusText, options.secrets || [gatewayConfig.apiKey]);
      return {
        success: false,
        durationMs,
        timeout: false,
        status: response.status,
        error: `HTTP ${response.status}: ${safeError}`,
        text: '',
        correct: false
      };
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      return {
        success: false,
        durationMs,
        timeout: false,
        status: response.status,
        error: `Malformed JSON response: ${err.message}`,
        text: '',
        correct: false
      };
    }

    const assistantContent = data?.choices?.[0]?.message?.content;
    if (typeof assistantContent !== 'string') {
      return {
        success: false,
        durationMs,
        timeout: false,
        status: response.status,
        error: 'Missing message content in choices[0]',
        text: '',
        correct: false
      };
    }

    const correct = evaluateCorrectness(assistantContent);

    return {
      success: true,
      durationMs,
      timeout: false,
      status: response.status,
      text: assistantContent,
      correct,
      modelReturned: data.model || gatewayConfig.model,
      usage: data.usage || null,
      error: null
    };
  } catch (err) {
    const durationMs = getDurationMs();
    const isTimeout = err.name === 'AbortError' ||
                      controller.signal.aborted ||
                      err.message.toLowerCase().includes('time');

    const safeError = sanitizeSecret(err?.message || 'Network error', options.secrets || [gatewayConfig.apiKey]);
    return {
      success: false,
      durationMs,
      timeout: isTimeout,
      status: null,
      error: isTimeout ? `Request timed out after ${timeout}ms` : safeError,
      text: '',
      correct: false
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Calculates statistical summary for a gateway across its trials.
 *
 * @param {Object} gateway - Gateway configuration
 * @param {Array<Object>} trials - Recorded trials for this gateway
 * @returns {Object}
 */
export function calculateGatewaySummary(gateway, trials) {
  const successfulTrials = trials.filter(t => t.success);
  const failedTrials = trials.filter(t => !t.success);
  const timeoutCount = trials.filter(t => t.timeout).length;
  const correctCount = trials.filter(t => t.correct).length;

  const successfulDurations = successfulTrials.map(t => t.durationMs);

  let minMs = null;
  let maxMs = null;
  let avgMs = null;
  let medianMs = null;

  if (successfulDurations.length > 0) {
    minMs = Math.min(...successfulDurations);
    maxMs = Math.max(...successfulDurations);
    const sum = successfulDurations.reduce((a, b) => a + b, 0);
    avgMs = Math.round(sum / successfulDurations.length);

    const sorted = [...successfulDurations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
      medianMs = sorted[mid];
    } else {
      medianMs = Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    }
  }

  return {
    gateway: gateway.name,
    gatewayId: gateway.id,
    model: gateway.model,
    totalTrials: trials.length,
    successful: successfulTrials.length,
    failed: failedTrials.length,
    timeouts: timeoutCount,
    correctCount,
    medianMs,
    avgMs,
    minMs,
    maxMs
  };
}

/**
 * Runs sequential cross-gateway benchmark trials.
 * Cheaper Inference: 3 sequential trials.
 * OpenRouter: 3 sequential trials.
 * Requests are strictly sequential (never concurrent). Max 6 requests total.
 *
 * @param {Array<Object>} gateways
 * @param {Object} [options]
 * @param {string} [options.prompt]
 * @param {number} [options.trialsPerGateway]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {typeof fetch} [options.fetchFn]
 * @param {Function} [options.onTrialStart]
 * @param {Function} [options.onTrialComplete]
 * @returns {Promise<Object>}
 */
export async function runCrossGatewayBenchmark(gateways, options = {}) {
  const prompt = options.prompt || DEFAULT_BENCHMARK_PROMPT;
  const trialsPerGateway = Number(options.trialsPerGateway || DEFAULT_TRIALS_PER_GATEWAY);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const onTrialStart = options.onTrialStart || (() => {});
  const onTrialComplete = options.onTrialComplete || (() => {});

  const allTrials = [];
  const summaries = [];

  const allSecrets = gateways.map(g => g.apiKey).filter(Boolean);

  for (const gateway of gateways) {
    const trials = [];

    for (let trialNum = 1; trialNum <= trialsPerGateway; trialNum++) {
      onTrialStart({ gateway: gateway.name, model: gateway.model, trial: trialNum });

      const trialResult = await executeGatewayRequest(gateway, prompt, {
        timeoutMs,
        temperature,
        maxTokens,
        fetchFn,
        secrets: allSecrets
      });

      const trialRecord = {
        gateway: gateway.name,
        gatewayId: gateway.id,
        model: gateway.model,
        trial: trialNum,
        success: trialResult.success,
        durationMs: trialResult.durationMs,
        timeout: trialResult.timeout,
        status: trialResult.status,
        text: trialResult.text,
        correct: trialResult.correct,
        modelReturned: trialResult.modelReturned || null,
        usage: trialResult.usage || null,
        error: trialResult.error
      };

      trials.push(trialRecord);
      allTrials.push(trialRecord);
      onTrialComplete(trialRecord);
    }

    const summary = calculateGatewaySummary(gateway, trials);
    summaries.push(summary);
  }

  // Comparison logic
  const cheaperSummary = summaries.find(s => s.gatewayId === 'cheaper-inference');
  const openRouterSummary = summaries.find(s => s.gatewayId === 'openrouter');

  let comparison = {
    hasComparableSamples: false,
    speedRatioText: 'N/A',
    medianDiffMs: null,
    fastestGateway: null,
    notes: ''
  };

  if (cheaperSummary?.medianMs !== null && openRouterSummary?.medianMs !== null) {
    comparison.hasComparableSamples = true;
    comparison.medianDiffMs = Math.abs(cheaperSummary.medianMs - openRouterSummary.medianMs);

    if (openRouterSummary.medianMs < cheaperSummary.medianMs) {
      const ratio = (cheaperSummary.medianMs / openRouterSummary.medianMs).toFixed(2);
      comparison.fastestGateway = 'OpenRouter';
      comparison.speedRatioText = `${ratio}x faster`;
      comparison.notes = `OpenRouter was faster by ${comparison.medianDiffMs} ms (${comparison.speedRatioText}).`;
    } else if (cheaperSummary.medianMs < openRouterSummary.medianMs) {
      const ratio = (openRouterSummary.medianMs / cheaperSummary.medianMs).toFixed(2);
      comparison.fastestGateway = 'Cheaper Inference';
      comparison.speedRatioText = `${ratio}x faster`;
      comparison.notes = `Cheaper Inference was faster by ${comparison.medianDiffMs} ms (${comparison.speedRatioText}).`;
    } else {
      comparison.fastestGateway = 'Tie';
      comparison.speedRatioText = '1.0x';
      comparison.notes = 'Both gateways exhibited identical median latency.';
    }
  } else if (cheaperSummary?.medianMs === null && openRouterSummary?.medianMs !== null) {
    comparison.hasComparableSamples = false;
    comparison.fastestGateway = 'OpenRouter';
    comparison.notes = 'Cheaper baseline produced no successful samples within the timeout. OpenRouter produced valid samples.';
  } else if (openRouterSummary?.medianMs === null && cheaperSummary?.medianMs !== null) {
    comparison.hasComparableSamples = false;
    comparison.fastestGateway = 'Cheaper Inference';
    comparison.notes = 'OpenRouter produced no successful samples within the timeout. Cheaper Inference produced valid samples.';
  } else {
    comparison.hasComparableSamples = false;
    comparison.fastestGateway = 'None';
    comparison.notes = 'Neither gateway produced successful samples within the timeout.';
  }

  return {
    timestamp: new Date().toISOString(),
    prompt,
    timeoutMs,
    temperature,
    maxTokens,
    gateways: gateways.map(g => ({ name: g.name, id: g.id, model: g.model })),
    trials: allTrials,
    summary: summaries,
    comparison
  };
}

/**
 * Formats cross-gateway summaries into a structured console table string.
 *
 * @param {Array<Object>} summaries
 * @returns {string}
 */
export function formatConsoleTable(summaries) {
  const headers = [
    'Gateway',
    'Model',
    'Trials',
    'Success',
    'Timeouts',
    'Median ms',
    'Average ms',
    'Min ms',
    'Max ms',
    'Correct'
  ];

  const rows = summaries.map(s => [
    s.gateway,
    s.model,
    String(s.totalTrials),
    String(s.successful),
    String(s.timeouts),
    s.medianMs !== null ? `${s.medianMs} ms` : 'N/A',
    s.avgMs !== null ? `${s.avgMs} ms` : 'N/A',
    s.minMs !== null ? `${s.minMs} ms` : 'N/A',
    s.maxMs !== null ? `${s.maxMs} ms` : 'N/A',
    `${s.correctCount}/${s.totalTrials}`
  ]);

  const colWidths = headers.map((h, i) => {
    const maxVal = Math.max(...rows.map(r => r[i].length), h.length);
    return maxVal;
  });

  const formatRow = (cols) => cols.map((c, i) => c.padEnd(colWidths[i])).join(' | ');
  const separator = colWidths.map(w => '-'.repeat(w)).join('-+-');

  const lines = [
    formatRow(headers),
    separator,
    ...rows.map(formatRow)
  ];

  return lines.join('\n');
}

/**
 * Saves sanitized benchmark results to runtime file locations.
 *
 * @param {Object} resultData
 * @param {string} [jsonPath]
 * @param {string} [txtPath]
 */
export function saveBenchmarkResult(resultData, jsonPath = DEFAULT_OUTPUT_JSON, txtPath = DEFAULT_OUTPUT_TXT) {
  const jsonDir = dirname(jsonPath);
  if (!existsSync(jsonDir)) {
    mkdirSync(jsonDir, { recursive: true });
  }

  const safeData = JSON.parse(JSON.stringify(resultData));
  writeFileSync(jsonPath, JSON.stringify(safeData, null, 2), 'utf8');

  if (txtPath) {
    const txtDir = dirname(txtPath);
    if (!existsSync(txtDir)) {
      mkdirSync(txtDir, { recursive: true });
    }
    const tableText = formatConsoleTable(resultData.summary || []);
    const summaryText = [
      `JARVIS4 — Cross-Gateway Same-Model Latency Benchmark`,
      `Timestamp: ${resultData.timestamp}`,
      `Prompt: ${resultData.prompt}`,
      `Timeout: ${resultData.timeoutMs}ms`,
      ``,
      tableText,
      ``,
      `CHEAPER INFERENCE RESULT: ${resultData.summary?.find(s => s.gatewayId === 'cheaper-inference')?.medianMs ?? 'N/A'} ms median`,
      `OPENROUTER RESULT: ${resultData.summary?.find(s => s.gatewayId === 'openrouter')?.medianMs ?? 'N/A'} ms median`,
      `FASTEST OBSERVED GATEWAY: ${resultData.comparison?.fastestGateway || 'None'}`,
      `Notes: ${resultData.comparison?.notes || ''}`,
      ``,
      `CRITICAL SAFETY NOTE: Diagnostic benchmark result only. Production gateway remains Cheaper Inference.`
    ].join('\n');
    writeFileSync(txtPath, summaryText, 'utf8');
  }
}

/**
 * Parses CLI command line arguments.
 *
 * @param {Array<string>} args
 * @returns {Object}
 */
export function parseArgs(args) {
  const options = {
    check: false,
    trials: DEFAULT_TRIALS_PER_GATEWAY,
    timeout: DEFAULT_TIMEOUT_MS,
    prompt: DEFAULT_BENCHMARK_PROMPT,
    out: DEFAULT_OUTPUT_JSON,
    help: false
  };

  for (const arg of args) {
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--trials=')) {
      options.trials = Number(arg.slice(9)) || DEFAULT_TRIALS_PER_GATEWAY;
    } else if (arg.startsWith('--timeout=')) {
      options.timeout = Number(arg.slice(10)) || DEFAULT_TIMEOUT_MS;
    } else if (arg.startsWith('--prompt=')) {
      options.prompt = arg.slice(9);
    } else if (arg.startsWith('--out=')) {
      options.out = resolve(process.cwd(), arg.slice(6));
    }
  }

  return options;
}

/**
 * CLI execution entrypoint.
 */
export async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
JARVIS4 Cross-Gateway Same-Model Latency Benchmark Tool (Brick 16)

Usage:
  node scripts/benchmark-ai-gateways.mjs [options]
  npm run benchmark:gateways

Options:
  --check          Pre-benchmark check mode: verifies credentials & OpenRouter model availability (0 prompt requests)
  --trials=<n>     Number of sequential trials per gateway (default: 3)
  --timeout=<ms>   Timeout per trial in ms (default: 30000)
  --prompt="<str>" Prompt string (default: "What is 2 + 2? Answer with only the number.")
  --out=<path>     Output JSON path (default: runtime/ai-gateway-benchmark-latest.json)
  --help           Show this help message
`);
    process.exit(0);
  }

  console.log('\n==================================================');
  console.log('  JARVIS4 — Cross-Gateway Same-Model Benchmark (Brick 16)');
  console.log('==================================================');
  console.log('[SAFETY NOTICE] This is an operator diagnostic tool.');
  console.log('[SAFETY NOTICE] Production provider remains Cheaper Inference (deepseek-v4-flash-0731).');
  console.log('[SAFETY NOTICE] Production configuration will NOT be modified.');

  const cheaperApiKey = config.cheaperInference?.apiKey;
  const cheaperBaseUrl = config.cheaperInference?.baseUrl;
  const openRouterApiKey = config.openRouter?.apiKey;
  const openRouterBaseUrl = 'https://openrouter.ai/api/v1';

  const cheaperConfigured = Boolean(cheaperApiKey && cheaperApiKey.trim().length > 0);
  const openRouterConfigured = Boolean(openRouterApiKey && openRouterApiKey.trim().length > 0);

  console.log('\n• Configuration & Target Inspection:');
  console.log(`  Gateway A (Cheaper Inference): Target Model = ${CHEAPER_TARGET_MODEL}`);
  console.log(`    Credentials Configured: ${cheaperConfigured ? 'YES' : 'NO'}`);
  console.log(`  Gateway B (OpenRouter): Target Model = ${OPENROUTER_TARGET_MODEL}`);
  console.log(`    Credentials Configured: ${openRouterConfigured ? 'YES' : 'NO'}`);
  console.log(`  Timeout per Trial: ${args.timeout} ms`);
  console.log(`  Planned Live Requests: ${args.trials * 2} maximum (${args.trials} Cheaper + ${args.trials} OpenRouter)`);

  if (!cheaperConfigured) {
    console.error('\n[ERROR] Cheaper Inference API key is missing. Set CHEAPER_INFERENCE_API_KEY in .env');
    process.exit(1);
  }

  if (!openRouterConfigured) {
    console.error('\n[ERROR] OpenRouter API key is missing. Set OPENROUTER_API_KEY in .env');
    process.exit(1);
  }

  console.log('\n• Verifying OpenRouter target model availability ...');
  const modelCheck = await verifyOpenRouterModelAvailability(
    openRouterBaseUrl,
    openRouterApiKey,
    OPENROUTER_TARGET_MODEL
  );

  if (!modelCheck.available) {
    console.error(`\n[FATAL] Model availability check failed: ${modelCheck.error}`);
    console.error('[FATAL] Silent model substitution is prohibited. Stopping benchmark.');
    process.exit(1);
  }
  console.log(`  Target model confirmed available: ${modelCheck.modelId}`);

  if (args.check) {
    console.log('\n[PRE-BENCHMARK CHECK MODE: PASS]');
    console.log('All credentials and target models verified.');
    console.log('Zero benchmark prompt requests sent.');
    process.exit(0);
  }

  const gateways = [
    {
      name: 'Cheaper Inference',
      id: 'cheaper-inference',
      baseUrl: cheaperBaseUrl,
      apiKey: cheaperApiKey,
      model: CHEAPER_TARGET_MODEL
    },
    {
      name: 'OpenRouter',
      id: 'openrouter',
      baseUrl: openRouterBaseUrl,
      apiKey: openRouterApiKey,
      model: OPENROUTER_TARGET_MODEL
    }
  ];

  console.log(`\n[WARNING] Executing ${gateways.length} gateways × ${args.trials} trials = ${args.trials * 2} LIVE sequential requests.`);
  console.log(`[WARNING] Prompt: "${args.prompt}" | Timeout: ${args.timeout}ms`);

  const benchmarkResult = await runCrossGatewayBenchmark(gateways, {
    prompt: args.prompt,
    trialsPerGateway: args.trials,
    timeoutMs: args.timeout,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    onTrialStart: ({ gateway, model, trial }) => {
      process.stdout.write(`  [${gateway} - ${model}] Trial ${trial}/${args.trials} ... `);
    },
    onTrialComplete: (trial) => {
      if (trial.success) {
        const correctLabel = trial.correct ? 'PASS (answer=4)' : `FLAGGED (answer="${trial.text}")`;
        console.log(`\x1b[32mSUCCESS\x1b[0m (${trial.durationMs}ms, ${correctLabel})`);
      } else if (trial.timeout) {
        console.log(`\x1b[33mTIMEOUT\x1b[0m (${trial.durationMs}ms)`);
      } else {
        console.log(`\x1b[31mFAILED\x1b[0m (${trial.durationMs}ms: ${trial.error})`);
      }
    }
  });

  console.log('\n==================================================');
  console.log('  Cross-Gateway Benchmark Summary');
  console.log('==================================================\n');
  console.log(formatConsoleTable(benchmarkResult.summary));

  console.log('\n==================================================');
  console.log('  Comparison Outcome');
  console.log('==================================================');

  const cheaperSum = benchmarkResult.summary.find(s => s.gatewayId === 'cheaper-inference');
  const openRouterSum = benchmarkResult.summary.find(s => s.gatewayId === 'openrouter');

  console.log(`\nCHEAPER INFERENCE RESULT:`);
  console.log(`  Model: ${cheaperSum?.model}`);
  console.log(`  Median: ${cheaperSum?.medianMs !== null ? `${cheaperSum?.medianMs} ms` : 'N/A'}`);
  console.log(`  Success: ${cheaperSum?.successful}/${cheaperSum?.totalTrials}`);
  console.log(`  Timeouts: ${cheaperSum?.timeouts}/${cheaperSum?.totalTrials}`);
  console.log(`  Correct: ${cheaperSum?.correctCount}/${cheaperSum?.totalTrials}`);

  console.log(`\nOPENROUTER RESULT:`);
  console.log(`  Model: ${openRouterSum?.model}`);
  console.log(`  Median: ${openRouterSum?.medianMs !== null ? `${openRouterSum?.medianMs} ms` : 'N/A'}`);
  console.log(`  Success: ${openRouterSum?.successful}/${openRouterSum?.totalTrials}`);
  console.log(`  Timeouts: ${openRouterSum?.timeouts}/${openRouterSum?.totalTrials}`);
  console.log(`  Correct: ${openRouterSum?.correctCount}/${openRouterSum?.totalTrials}`);

  console.log(`\nFASTEST OBSERVED GATEWAY: ${benchmarkResult.comparison.fastestGateway}`);
  if (benchmarkResult.comparison.hasComparableSamples) {
    console.log(`  Difference: ${benchmarkResult.comparison.medianDiffMs} ms (${benchmarkResult.comparison.speedRatioText})`);
  }
  console.log(`  Notes: ${benchmarkResult.comparison.notes}`);

  console.log('\n[CRITICAL SAFETY NOTE] Cross-gateway benchmark is an empirical diagnostic tool only.');
  console.log('[CRITICAL SAFETY NOTE] Normal JARVIS production provider remains Cheaper Inference.');

  saveBenchmarkResult(benchmarkResult, args.out);
  console.log(`\nBenchmark result saved to: ${args.out}`);
}

// Execute when run directly as CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(err => {
    console.error(`\n[FATAL GATEWAY BENCHMARK ERROR] ${err.message}`);
    process.exit(1);
  });
}
