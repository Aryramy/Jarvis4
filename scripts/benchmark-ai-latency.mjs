#!/usr/bin/env node

/**
 * AI Latency Benchmark & Candidate Selection Tool for JARVIS4 (Brick 15).
 *
 * Safe, isolated, manually-invoked operator diagnostic tool for testing
 * alternative Cheaper Inference text models against the production baseline.
 *
 * STRICT SAFETY RULES:
 * - Does NOT alter production CHEAPER_INFERENCE_MODEL.
 * - Does NOT modify /api/ai production model routing.
 * - Does NOT implement automatic routing or fallbacks.
 * - Never invoked automatically by verify, web server, or test suites.
 * - Redacts all secrets and API keys from outputs and saved results.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config/index.js';
import { CheaperInferenceProvider } from '../src/providers/cheaperInference.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');

export const DEFAULT_BASELINE_MODEL = 'deepseek-v4-flash-0731';
export const DEFAULT_BENCHMARK_PROMPT = 'What is 2 + 2? Answer with only the number.';
export const DEFAULT_TRIALS_PER_MODEL = 3;
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_CANDIDATES = 4;
export const DEFAULT_OUTPUT_JSON = resolve(ROOT_DIR, 'runtime', 'ai-benchmark-latest.json');
export const DEFAULT_OUTPUT_TXT = resolve(ROOT_DIR, 'runtime', 'ai-benchmark-latest.txt');

/**
 * Sanitizes any string to ensure secrets are never leaked.
 *
 * @param {string} text
 * @param {string} [secret]
 * @returns {string}
 */
export function sanitizeSecret(text, secret) {
  if (!text || typeof text !== 'string') return '';
  let safe = text;
  if (secret && typeof secret === 'string' && secret.trim().length > 0) {
    safe = safe.replaceAll(secret, '[REDACTED]');
  }
  const envKey = process.env.CHEAPER_INFERENCE_API_KEY || config.cheaperInference?.apiKey;
  if (envKey && typeof envKey === 'string' && envKey.trim().length > 0) {
    safe = safe.replaceAll(envKey, '[REDACTED]');
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
 * Safely extracts pricing metadata from a model catalog entry.
 *
 * @param {Object} modelObj
 * @returns {{ inputPrice: string, outputPrice: string }}
 */
export function extractPricing(modelObj) {
  if (!modelObj || typeof modelObj !== 'object') {
    return { inputPrice: 'N/A', outputPrice: 'N/A' };
  }
  const pricing = modelObj.pricing;
  if (!pricing || typeof pricing !== 'object') {
    return { inputPrice: 'N/A', outputPrice: 'N/A' };
  }
  const input = pricing.prompt ?? pricing.input ?? pricing.prompt_tokens ?? pricing.input_cost_per_token ?? 'N/A';
  const output = pricing.completion ?? pricing.output ?? pricing.completion_tokens ?? pricing.output_cost_per_token ?? 'N/A';
  return {
    inputPrice: String(input),
    outputPrice: String(output)
  };
}

/**
 * Safely extracts reliability metadata from a model catalog entry.
 *
 * @param {Object} modelObj
 * @returns {string}
 */
export function extractReliability(modelObj) {
  if (!modelObj || typeof modelObj !== 'object') return 'N/A';
  const rel = modelObj.reliability ?? modelObj.uptime ?? modelObj.status ?? null;
  return rel !== null && rel !== undefined ? String(rel) : 'N/A';
}

/**
 * Discovers available models from the live /v1/models catalog endpoint.
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Array<Object>>}
 */
export async function fetchModelCatalog(baseUrl, apiKey, fetchFn = globalThis.fetch) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('Cheaper Inference API key is required for model catalog discovery');
  }

  const cleanBase = (baseUrl || 'https://api.cheaperinference.com/v1').trim().replace(/\/+$/, '');
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
        try {
          errDetail = await response.text();
        } catch {
          errDetail = response.statusText;
        }
      }
      const safeErr = sanitizeSecret(errDetail, apiKey);
      throw new Error(`Catalog discovery HTTP ${response.status}: ${safeErr || response.statusText}`);
    }

    const json = await response.json();
    const list = Array.isArray(json) ? json : (json?.data || json?.models || []);
    return list;
  } catch (err) {
    const safeMsg = sanitizeSecret(err?.message || 'Unknown network error', apiKey);
    throw new Error(`Failed to discover models: ${safeMsg}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Selects baseline model and up to ~3 alternative candidate models for benchmarking.
 *
 * @param {Array<Object>} catalog - Raw catalog list from /v1/models
 * @param {string} [baselineModel] - Default baseline model ID
 * @param {Object} [options]
 * @param {number} [options.maxCandidates] - Maximum total models to benchmark (baseline + alternatives)
 * @param {Array<string>} [options.explicitModels] - Explicit candidate models to include if specified
 * @returns {Array<{ id: string, isBaseline: boolean, inputPrice: string, outputPrice: string, reliability: string }>}
 */
export function selectCandidates(catalog = [], baselineModel = DEFAULT_BASELINE_MODEL, options = {}) {
  const maxCandidates = Number(options.maxCandidates || DEFAULT_MAX_CANDIDATES);
  const explicitModels = Array.isArray(options.explicitModels) ? options.explicitModels : null;

  const rawList = Array.isArray(catalog) ? catalog : (catalog?.data || catalog?.models || []);
  const normalizedList = rawList
    .map(item => (typeof item === 'string' ? { id: item } : item))
    .filter(item => item && typeof item.id === 'string' && item.id.trim().length > 0);

  // 1. Baseline model is ALWAYS included as first candidate
  let baselineItem = normalizedList.find(m => m.id === baselineModel);
  if (!baselineItem) {
    baselineItem = { id: baselineModel };
  }

  const selected = [{
    id: baselineItem.id,
    isBaseline: true,
    inputPrice: extractPricing(baselineItem).inputPrice,
    outputPrice: extractPricing(baselineItem).outputPrice,
    reliability: extractReliability(baselineItem)
  }];

  // 2. If operator specified explicit models, use them
  if (explicitModels && explicitModels.length > 0) {
    for (const expId of explicitModels) {
      if (selected.length >= maxCandidates) break;
      const cleanId = expId.trim();
      if (!cleanId || cleanId === baselineModel || selected.some(s => s.id === cleanId)) continue;
      const found = normalizedList.find(m => m.id === cleanId) || { id: cleanId };
      selected.push({
        id: found.id,
        isBaseline: false,
        inputPrice: extractPricing(found).inputPrice,
        outputPrice: extractPricing(found).outputPrice,
        reliability: extractReliability(found)
      });
    }
    return selected;
  }

  // 3. Automated heuristic candidate discovery from catalog:
  // Filter out non-text models (embeddings, whisper, tts, vision/diffusion/image, moderation, etc.)
  const nonTextRegex = /(embed|whisper|tts|audio|transcription|speech|dall-e|image|flux|diffusion|moderation|guard|rerank)/i;
  const fastKeywordsRegex = /(flash|mini|haiku|turbo|small|8b|7b|3b)/i;

  const textCandidates = normalizedList.filter(m => {
    if (m.id === baselineModel) return false;
    if (nonTextRegex.test(m.id)) return false;
    return true;
  });

  // Prioritize candidates likely to be lightweight/fast
  const prioritized = [
    ...textCandidates.filter(m => fastKeywordsRegex.test(m.id)),
    ...textCandidates.filter(m => !fastKeywordsRegex.test(m.id))
  ];

  for (const candidate of prioritized) {
    if (selected.length >= maxCandidates) break;
    if (selected.some(s => s.id === candidate.id)) continue;
    selected.push({
      id: candidate.id,
      isBaseline: false,
      inputPrice: extractPricing(candidate).inputPrice,
      outputPrice: extractPricing(candidate).outputPrice,
      reliability: extractReliability(candidate)
    });
  }

  return selected;
}

/**
 * Calculates statistical summary for a single model across its trials.
 *
 * @param {Object} candidate - Candidate metadata object
 * @param {Array<Object>} trials - Recorded trials for this model
 * @returns {Object}
 */
export function calculateModelSummary(candidate, trials) {
  const successfulTrials = trials.filter(t => t.success);
  const failedTrials = trials.filter(t => !t.success);
  const timeoutCount = trials.filter(t => t.timeout).length;
  const correctCount = trials.filter(t => t.correct).length;

  const successfulDurations = successfulTrials.map(t => t.providerDurationMs ?? t.durationMs);

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
    id: candidate.id,
    isBaseline: Boolean(candidate.isBaseline),
    totalTrials: trials.length,
    successful: successfulTrials.length,
    failed: failedTrials.length,
    timeouts: timeoutCount,
    correctCount,
    allCorrect: trials.length > 0 && correctCount === trials.length,
    medianMs,
    avgMs,
    minMs,
    maxMs,
    inputPrice: candidate.inputPrice ?? 'N/A',
    outputPrice: candidate.outputPrice ?? 'N/A',
    reliability: candidate.reliability ?? 'N/A'
  };
}

/**
 * Runs sequential benchmark trials across the specified candidate models.
 * Requests are STRICTLY sequential (not concurrent).
 *
 * @param {Array<Object>} candidates
 * @param {Object} [options]
 * @param {string} [options.prompt]
 * @param {number} [options.trialsPerModel]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetchFn]
 * @param {Function} [options.onTrialStart]
 * @param {Function} [options.onTrialComplete]
 * @returns {Promise<Object>}
 */
export async function runSequentialBenchmark(candidates, options = {}) {
  const prompt = options.prompt || DEFAULT_BENCHMARK_PROMPT;
  const trialsPerModel = Number(options.trialsPerModel || DEFAULT_TRIALS_PER_MODEL);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const apiKey = options.apiKey || config.cheaperInference?.apiKey;
  const baseUrl = options.baseUrl || config.cheaperInference?.baseUrl;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const onTrialStart = options.onTrialStart || (() => {});
  const onTrialComplete = options.onTrialComplete || (() => {});

  if (!apiKey) {
    throw new Error('Cheaper Inference API key is required to run AI latency benchmark');
  }

  const allTrials = [];
  const modelSummaries = [];

  for (const candidate of candidates) {
    const modelId = candidate.id;
    const trials = [];

    // Isolated provider instance for each candidate model
    const provider = new CheaperInferenceProvider({
      apiKey,
      baseUrl,
      model: modelId,
      timeoutMs,
      fetchFn
    });

    // Run trials strictly sequentially
    for (let trialNum = 1; trialNum <= trialsPerModel; trialNum++) {
      onTrialStart({ model: modelId, trial: trialNum });

      const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

      let result;
      let durationMs = 0;
      let isTimeout = false;

      try {
        result = await provider.generate(prompt, { timeoutMs });
        const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();
        durationMs = result?.providerDurationMs ?? Math.max(0, Math.round(endTime - startTime));
      } catch (err) {
        const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();
        durationMs = Math.max(0, Math.round(endTime - startTime));
        const safeErrMsg = provider.sanitizeError(err?.message || 'Unknown error');
        isTimeout = safeErrMsg.toLowerCase().includes('timeout') ||
                    safeErrMsg.toLowerCase().includes('timed out') ||
                    safeErrMsg.toLowerCase().includes('abort');
        result = {
          success: false,
          error: safeErrMsg,
          providerDurationMs: durationMs
        };
      }

      const text = result?.success ? (result.text || '') : '';
      const success = Boolean(result?.success);
      const isErrorTimeout = !success && (
        isTimeout ||
        Boolean(result?.error && (
          result.error.toLowerCase().includes('timeout') ||
          result.error.toLowerCase().includes('timed out') ||
          result.error.toLowerCase().includes('abort')
        ))
      );

      const correct = success && evaluateCorrectness(text);

      const trialRecord = {
        model: modelId,
        trial: trialNum,
        success,
        durationMs,
        providerDurationMs: result?.providerDurationMs ?? durationMs,
        timeout: isErrorTimeout,
        text,
        correct,
        error: !success ? provider.sanitizeError(result?.error || 'Failed') : null
      };

      trials.push(trialRecord);
      allTrials.push(trialRecord);
      onTrialComplete(trialRecord);
    }

    const summary = calculateModelSummary(candidate, trials);
    modelSummaries.push(summary);
  }

  // Baseline summary
  const baselineSummary = modelSummaries.find(s => s.isBaseline);

  // Eligible fastest candidates: must have at least one successful trial AND correct === true
  // Note: An incorrect fast response or totally failed model is NEVER eligible
  const eligibleCandidates = modelSummaries.filter(s => s.successful > 0 && s.correctCount > 0 && s.medianMs !== null);

  let fastestCandidate = null;
  if (eligibleCandidates.length > 0) {
    fastestCandidate = eligibleCandidates.reduce((prev, curr) => {
      return (curr.medianMs < prev.medianMs) ? curr : prev;
    });
  }

  let speedImprovement = null;
  if (fastestCandidate && baselineSummary && baselineSummary.medianMs && fastestCandidate.id !== baselineSummary.id) {
    const diff = baselineSummary.medianMs - fastestCandidate.medianMs;
    const pct = Math.round((diff / baselineSummary.medianMs) * 100);
    const ratio = (baselineSummary.medianMs / fastestCandidate.medianMs).toFixed(2);
    speedImprovement = {
      diffMs: diff,
      percentage: pct,
      ratio: `${ratio}x`
    };
  }

  return {
    timestamp: new Date().toISOString(),
    prompt,
    timeoutMs,
    baselineModel: baselineSummary?.id || DEFAULT_BASELINE_MODEL,
    candidateModels: candidates.map(c => c.id),
    trials: allTrials,
    summary: modelSummaries,
    fastestObservedCandidate: fastestCandidate ? {
      model: fastestCandidate.id,
      medianMs: fastestCandidate.medianMs,
      correctCount: fastestCandidate.correctCount,
      speedImprovement
    } : null
  };
}

/**
 * Formats benchmark summaries into a structured console table string.
 *
 * @param {Array<Object>} summaries
 * @param {Object} [fastest]
 * @returns {string}
 */
export function formatConsoleTable(summaries, fastest) {
  const headers = [
    'Model',
    'Trials',
    'Success',
    'Timeouts',
    'Median ms',
    'Average ms',
    'Min ms',
    'Max ms',
    'Correct',
    'Input Price',
    'Output Price'
  ];

  const rows = summaries.map(s => [
    s.isBaseline ? `${s.id} (BASELINE)` : s.id,
    String(s.totalTrials),
    String(s.successful),
    String(s.timeouts),
    s.medianMs !== null ? `${s.medianMs} ms` : 'N/A',
    s.avgMs !== null ? `${s.avgMs} ms` : 'N/A',
    s.minMs !== null ? `${s.minMs} ms` : 'N/A',
    s.maxMs !== null ? `${s.maxMs} ms` : 'N/A',
    `${s.correctCount}/${s.totalTrials}`,
    s.inputPrice,
    s.outputPrice
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
  // Ensure target directory exists
  const jsonDir = dirname(jsonPath);
  if (!existsSync(jsonDir)) {
    mkdirSync(jsonDir, { recursive: true });
  }

  // Ensure secret cannot leak into JSON
  const safeData = JSON.parse(JSON.stringify(resultData));
  writeFileSync(jsonPath, JSON.stringify(safeData, null, 2), 'utf8');

  if (txtPath) {
    const txtDir = dirname(txtPath);
    if (!existsSync(txtDir)) {
      mkdirSync(txtDir, { recursive: true });
    }
    const tableText = formatConsoleTable(resultData.summary || [], resultData.fastestObservedCandidate);
    const summaryText = [
      `JARVIS4 — AI Latency Benchmark Results`,
      `Timestamp: ${resultData.timestamp}`,
      `Prompt: ${resultData.prompt}`,
      `Timeout: ${resultData.timeoutMs}ms`,
      ``,
      tableText,
      ``,
      `BASELINE MODEL: ${resultData.baselineModel}`,
      `FASTEST OBSERVED CANDIDATE: ${resultData.fastestObservedCandidate?.model || 'None'}`,
      `Note: Benchmark result only. Production model remains unchanged.`
    ].join('\n');
    writeFileSync(txtPath, summaryText, 'utf8');
  }
}

/**
 * Parses CLI command line flags.
 *
 * @param {Array<string>} args
 * @returns {Object}
 */
export function parseArgs(args) {
  const options = {
    discover: false,
    models: null,
    trials: DEFAULT_TRIALS_PER_MODEL,
    timeout: DEFAULT_TIMEOUT_MS,
    prompt: DEFAULT_BENCHMARK_PROMPT,
    out: DEFAULT_OUTPUT_JSON,
    help: false
  };

  for (const arg of args) {
    if (arg === '--discover') {
      options.discover = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--models=')) {
      options.models = arg.slice(9).split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--trials=')) {
      options.trials = Number(arg.slice(9)) || DEFAULT_TRIALS_PER_MODEL;
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
JARVIS4 AI Latency Benchmark & Candidate Selection Tool (Brick 15)

Usage:
  node scripts/benchmark-ai-latency.mjs [options]
  npm run benchmark:ai [-- options]

Options:
  --discover            Fetch live catalog, display candidate models, and exit (makes NO benchmark calls)
  --models=<m1,m2,...>  Explicit candidate models to benchmark alongside baseline
  --trials=<n>          Number of sequential trials per model (default: 3)
  --timeout=<ms>        Timeout per trial in ms (default: 30000)
  --prompt="<text>"     Prompt override (default: "What is 2 + 2? Answer with only the number.")
  --out=<path>          Output JSON file path (default: runtime/ai-benchmark-latest.json)
  --help                Show this help message
`);
    process.exit(0);
  }

  console.log('\n==================================================');
  console.log('  JARVIS4 — AI Latency Benchmark & Candidate Selection');
  console.log('==================================================');
  console.log('[SAFETY NOTICE] This is an operator diagnostic tool.');
  console.log(`[SAFETY NOTICE] Current production model is: ${DEFAULT_BASELINE_MODEL}`);
  console.log('[SAFETY NOTICE] Production configuration will NOT be modified.');

  const apiKey = config.cheaperInference?.apiKey;
  const baseUrl = config.cheaperInference?.baseUrl;

  if (!apiKey) {
    console.error('\n[ERROR] Cheaper Inference API key is missing. Set CHEAPER_INFERENCE_API_KEY in .env');
    process.exit(1);
  }

  console.log(`\n• Discovering live model catalog from ${baseUrl}/models ...`);
  let rawCatalog = [];
  try {
    rawCatalog = await fetchModelCatalog(baseUrl, apiKey);
    console.log(`  Live catalog retrieved: ${rawCatalog.length} models available.`);
  } catch (err) {
    console.error(`  [WARN] Failed to fetch live catalog: ${err.message}`);
    console.log(`  Falling back to explicit/baseline candidates.`);
  }

  const candidates = selectCandidates(rawCatalog, DEFAULT_BASELINE_MODEL, {
    maxCandidates: DEFAULT_MAX_CANDIDATES,
    explicitModels: args.models
  });

  console.log(`\nSelected candidates (${candidates.length} total, max ${DEFAULT_MAX_CANDIDATES}):`);
  for (const c of candidates) {
    const label = c.isBaseline ? '[CURRENT PRODUCTION BASELINE]' : '[CANDIDATE]';
    console.log(`  ${label} ${c.id} (Input: ${c.inputPrice}, Output: ${c.outputPrice}, Reliability: ${c.reliability})`);
  }

  if (args.discover) {
    console.log('\n[DISCOVERY ONLY] Exiting without sending benchmark prompt traffic.');
    process.exit(0);
  }

  const totalRequests = candidates.length * args.trials;
  console.log(`\n[WARNING] Executing ${candidates.length} models × ${args.trials} trials = ${totalRequests} LIVE sequential API requests.`);
  console.log(`[WARNING] Timeout per trial: ${args.timeout}ms. Prompt: "${args.prompt}"`);

  const benchmarkResult = await runSequentialBenchmark(candidates, {
    apiKey,
    baseUrl,
    prompt: args.prompt,
    trialsPerModel: args.trials,
    timeoutMs: args.timeout,
    onTrialStart: ({ model, trial }) => {
      process.stdout.write(`  [${model}] Trial ${trial}/${args.trials} ... `);
    },
    onTrialComplete: (trial) => {
      if (trial.success) {
        const correctLabel = trial.correct ? 'PASS (answer=4)' : `FLAGGED (answer="${trial.text}")`;
        console.log(`\x1b[32mSUCCESS\x1b[0m (${trial.providerDurationMs}ms, ${correctLabel})`);
      } else if (trial.timeout) {
        console.log(`\x1b[33mTIMEOUT\x1b[0m (${trial.providerDurationMs}ms)`);
      } else {
        console.log(`\x1b[31mFAILED\x1b[0m (${trial.providerDurationMs}ms: ${trial.error})`);
      }
    }
  });

  console.log('\n==================================================');
  console.log('  Benchmark Summary');
  console.log('==================================================\n');
  console.log(formatConsoleTable(benchmarkResult.summary, benchmarkResult.fastestObservedCandidate));

  console.log('\n==================================================');
  console.log('  Candidate Selection Outcome');
  console.log('==================================================');

  const baselineSummary = benchmarkResult.summary.find(s => s.isBaseline);
  console.log(`\nCURRENT BASELINE:`);
  console.log(`  Model: ${baselineSummary?.id || DEFAULT_BASELINE_MODEL}`);
  console.log(`  Median: ${baselineSummary?.medianMs !== null ? `${baselineSummary?.medianMs} ms` : 'N/A'}`);
  console.log(`  Success: ${baselineSummary?.successful || 0}/${baselineSummary?.totalTrials || 0}`);
  console.log(`  Correct: ${baselineSummary?.correctCount || 0}/${baselineSummary?.totalTrials || 0}`);

  console.log(`\nFASTEST OBSERVED CANDIDATE:`);
  if (benchmarkResult.fastestObservedCandidate) {
    const f = benchmarkResult.fastestObservedCandidate;
    console.log(`  Model: ${f.model}`);
    console.log(`  Median: ${f.medianMs} ms`);
    console.log(`  Correct: ${f.correctCount}/${args.trials}`);
    if (f.speedImprovement) {
      console.log(`  Speed improvement vs baseline: ${f.speedImprovement.percentage}% faster (${f.speedImprovement.diffMs}ms faster, ${f.speedImprovement.ratio})`);
    } else if (f.model === DEFAULT_BASELINE_MODEL) {
      console.log(`  Current baseline was the fastest observed candidate.`);
    }
  } else {
    console.log(`  None (no candidate achieved both successful completion and correct answer).`);
  }

  console.log('\n[CRITICAL SAFETY NOTE] "FASTEST OBSERVED CANDIDATE" is a diagnostic benchmark result only.');
  console.log('[CRITICAL SAFETY NOTE] Production model remains unchanged: deepseek-v4-flash-0731');

  saveBenchmarkResult(benchmarkResult, args.out);
  console.log(`\nBenchmark result saved to: ${args.out}`);
}

// Execute when run directly as CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(err => {
    console.error(`\n[FATAL BENCHMARK ERROR] ${err.message}`);
    process.exit(1);
  });
}
