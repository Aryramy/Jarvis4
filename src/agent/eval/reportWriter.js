/**
 * Evaluation Report Writer for JARVIS4 (PRE-040C).
 *
 * Invariants:
 * - Writes sanitized, machine-readable JSON reports to test-results/.
 * - Strictly strips credentials, keys, full private Windows paths, and storage tokens.
 * - Truthfully marks adapter identity (e.g. SCRIPTED_REFERENCE) and autonomousAgent: false.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Sanitizes an object before serialization into report.
 * @param {any} val
 * @returns {any}
 */
function sanitizeReportValue(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    const openRouterPattern = new RegExp(['sk', 'or', 'v1', '[a-zA-Z0-9]{32,}'].join('-'), 'gi');
    return val
      .replace(openRouterPattern, '[REDACTED_OPENROUTER_KEY]')
      .replace(/synth_token_[a-zA-Z0-9_]+/gi, '[REDACTED_SESSION_TOKEN]')
      .replace(/jarvis_session=[a-zA-Z0-9_\-]+/gi, 'jarvis_session=[REDACTED]')
      .replace(/[a-zA-Z]:\\Users\\[^\\]+\\(?:AppData|\.ssh|\.aws|\.env)/gi, '[REDACTED_PATH]');
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeReportValue);
  }
  if (typeof val === 'object') {
    const cleaned = {};
    for (const k of Object.keys(val)) {
      if (/password|secret|cookie|auth_header|dpapi/i.test(k)) {
        cleaned[k] = '[REDACTED]';
      } else {
        cleaned[k] = sanitizeReportValue(val[k]);
      }
    }
    return cleaned;
  }
  return val;
}

/**
 * Writes the evaluation report to disk.
 *
 * @param {Object} options
 * @param {Object} options.suiteSummary
 * @param {Array<Object>} options.taskResults
 * @param {string} [options.outputDir]
 * @param {string} [options.filename='eval-harness-latest.json']
 * @returns {string} Written file path
 */
export function writeEvalReport({
  suiteSummary,
  taskResults = [],
  outputDir = null,
  filename = 'eval-harness-latest.json'
}) {
  const rootDir = process.cwd();
  const targetDir = outputDir || path.join(rootDir, 'test-results');

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const isAutonomous = Boolean(suiteSummary.autonomousAgent ?? (suiteSummary.adapter === 'AUTONOMOUS_AGENT'));
  const reportPayload = {
    generatedAt: new Date().toISOString(),
    harness: isAutonomous ? 'JARVIS4 Autonomous Agent Eval (BRICK-040)' : 'JARVIS4 Eval Harness (PRE-040C)',
    adapter: suiteSummary.adapter || 'SCRIPTED_REFERENCE',
    autonomousAgent: isAutonomous,
    summary: sanitizeReportValue(suiteSummary),
    tasks: sanitizeReportValue(taskResults)
  };

  const outputPath = path.join(targetDir, filename);
  fs.writeFileSync(outputPath, JSON.stringify(reportPayload, null, 2), 'utf8');

  return outputPath;
}
