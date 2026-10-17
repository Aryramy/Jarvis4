/**
 * Golden Task Loader for JARVIS4 (PRE-040C).
 *
 * Invariants:
 * - Loads task definitions strictly from trusted local directory.
 * - Validates schema on load, deep-freezes, and hashes definitions.
 * - Enforces separation: getPublicTask returns only public data without expected evidence.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvalTask, extractPublicTask, EvalTaskError, EVAL_ERROR_CODES } from './taskSchema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_TASKS_DIR = path.resolve(__dirname, '../../../tests/eval/tasks');

const taskCache = new Map();

/**
 * Resolves the directory containing eval tasks.
 * @param {string} [customDir]
 * @returns {string}
 */
export function getTasksDirectory(customDir) {
  return customDir ? path.resolve(customDir) : DEFAULT_TASKS_DIR;
}

/**
 * Loads and validates a single golden task definition by ID.
 *
 * @param {string} taskId
 * @param {Object} [options={}]
 * @param {string} [options.tasksDir]
 * @param {boolean} [options.bypassCache=false]
 * @returns {Object} Validated, deep-frozen task definition
 */
export function loadTaskById(taskId, options = {}) {
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new EvalTaskError('taskId must be a non-empty string.', EVAL_ERROR_CODES.EVAL_TASK_INVALID);
  }

  const cleanId = taskId.trim();
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(cleanId)) {
    throw new EvalTaskError(`Invalid taskId "${cleanId}". Must be alphanumeric identifier (2-32 chars).`, EVAL_ERROR_CODES.EVAL_TASK_INVALID, { taskId: cleanId });
  }

  const tasksDir = getTasksDirectory(options.tasksDir);
  const cacheKey = `${tasksDir}:${cleanId}`;

  if (!options.bypassCache && taskCache.has(cacheKey)) {
    return taskCache.get(cacheKey);
  }

  let filePath = path.join(tasksDir, `${cleanId}.json`);
  if (!fs.existsSync(filePath)) {
    const recoveryPath = path.resolve(__dirname, '../../../tests/eval/recovery-tasks', `${cleanId}.json`);
    const verificationPath = path.resolve(__dirname, '../../../tests/eval/verification-tasks', `${cleanId}.json`);
    if (fs.existsSync(recoveryPath)) {
      filePath = recoveryPath;
    } else if (fs.existsSync(verificationPath)) {
      filePath = verificationPath;
    } else {
      throw new EvalTaskError(`Eval task file "${cleanId}.json" not found in "${tasksDir}".`, EVAL_ERROR_CODES.EVAL_TASK_INVALID, { taskId: cleanId, filePath });
    }
  }

  let rawJson;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    rawJson = JSON.parse(content);
  } catch (parseErr) {
    throw new EvalTaskError(
      `Failed to parse task JSON for "${cleanId}": ${parseErr.message}`,
      EVAL_ERROR_CODES.EVAL_TASK_INVALID,
      { taskId: cleanId, error: parseErr.message }
    );
  }

  const validated = validateEvalTask(rawJson);
  taskCache.set(cacheKey, validated);
  return validated;
}

/**
 * Loads all golden task definitions in the tasks directory.
 *
 * @param {Object} [options={}]
 * @param {string} [options.tasksDir]
 * @returns {Array<Object>} Sorted list of validated tasks
 */
export function loadAllTasks(options = {}) {
  const tasksDir = getTasksDirectory(options.tasksDir);
  if (!fs.existsSync(tasksDir)) {
    throw new EvalTaskError(`Tasks directory not found: "${tasksDir}".`, EVAL_ERROR_CODES.EVAL_TASK_INVALID, { tasksDir });
  }

  const files = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json')).sort();
  const tasks = [];

  for (const file of files) {
    const taskId = path.basename(file, '.json');
    const task = loadTaskById(taskId, options);
    tasks.push(task);
  }

  return tasks;
}

/**
 * Loads all recovery benchmark tasks (R01-R08).
 *
 * @param {Object} [options={}]
 * @returns {Array<Object>} Sorted list of validated recovery tasks
 */
export function loadRecoveryTasks(options = {}) {
  const recoveryDir = path.resolve(__dirname, '../../../tests/eval/recovery-tasks');
  return loadAllTasks({ ...options, tasksDir: recoveryDir });
}

/**
 * Loads all verification benchmark tasks (V01-V08).
 *
 * @param {Object} [options={}]
 * @returns {Array<Object>} Sorted list of validated verification tasks
 */
export function loadVerificationTasks(options = {}) {
  const verificationDir = path.resolve(__dirname, '../../../tests/eval/verification-tasks');
  return loadAllTasks({ ...options, tasksDir: verificationDir });
}

/**
 * Retrieves the public task definition for an agent under test.
 * Strips all grader expectations, optimal step counts, and hidden evidence.
 *
 * @param {string} taskId
 * @param {Object} [options={}]
 * @returns {Object} Public task context
 */
export function getPublicTask(taskId, options = {}) {
  const fullTask = loadTaskById(taskId, options);
  return extractPublicTask(fullTask);
}

/**
 * Clears the task cache (useful in testing).
 */
export function clearTaskCache() {
  taskCache.clear();
}
