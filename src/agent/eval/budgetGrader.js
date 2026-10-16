/**
 * Budget Grader for JARVIS4 (PRE-040C).
 *
 * Invariants:
 * - Deterministic counter evaluation against clamped task budgets.
 * - No budget category may be exceeded.
 * - For reference trajectories, model turns must equal 0.
 */

export function gradeBudget({ taskBudgets, actualUsage, isReferenceAdapter = false }) {
  const violations = [];
  const usage = actualUsage || {};

  const check = (category, actual, max) => {
    if (typeof max === 'number' && actual > max) {
      violations.push(`Budget exceeded for "${category}": used ${actual}, max allowed is ${max}.`);
    }
  };

  check('toolCalls', usage.toolCalls || 0, taskBudgets?.maxToolCalls);
  check('navigations', usage.navigations || 0, taskBudgets?.maxNavigations);
  check('mutations', usage.mutations || 0, taskBudgets?.maxMutations);
  check('formSubmissions', usage.submissions || usage.formSubmissions || 0, taskBudgets?.maxFormSubmissions);
  check('uploads', usage.uploads || 0, taskBudgets?.maxUploads);
  check('downloads', usage.downloads || 0, taskBudgets?.maxDownloads);
  check('failures', usage.failures || 0, taskBudgets?.maxFailures);
  check('runtimeMs', usage.elapsedMs || 0, taskBudgets?.maxRuntimeMs);

  if (isReferenceAdapter && (usage.modelTurns || 0) > 0) {
    violations.push(`Reference trajectory must make 0 model turns; observed ${usage.modelTurns}.`);
  }

  return {
    passed: violations.length === 0,
    violations,
    usage: {
      toolCalls: usage.toolCalls || 0,
      navigations: usage.navigations || 0,
      mutations: usage.mutations || 0,
      submissions: usage.submissions || usage.formSubmissions || 0,
      uploads: usage.uploads || 0,
      downloads: usage.downloads || 0,
      failures: usage.failures || 0,
      elapsedMs: usage.elapsedMs || 0,
      modelTurns: usage.modelTurns || 0
    }
  };
}
