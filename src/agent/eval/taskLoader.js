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
  const tasksDir = getTasksDirectory(options.tasksDir);
  const cacheKey = `${tasksDir}:${cleanId}`;

  if (!options.bypassCache && taskCache.has(cacheKey)) {
    return taskCache.get(cacheKey);
  }

  const filePath = path.join(tasksDir, `${cleanId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new EvalTaskError(`Eval task file "${cleanId}.json" not found in "${tasksDir}".`, EVAL_ERROR_CODES.EVAL_TASK_INVALID, { taskId: cleanId, filePath });
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
