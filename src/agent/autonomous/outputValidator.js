/**
 * Autonomous Agent Output Validator for JARVIS4 (BRICK-040).
 * Strictly validates structured JSON outputs from model planning and decision turns.
 *
 * Invariants:
 * - Reject arbitrary prose and unparseable responses with AGENT_OUTPUT_INVALID.
 * - Enforce hybrid short plan bounds: 1 to 4 milestones max.
 * - Enforce exactly one tool proposal per action decision (zero batch execution).
 * - Reject raw CSS, XPath, executable scripts, and DOM handles.
 * - Strictly reject or strip model-supplied security declarations (risk, confirmed, permission, budgetOverride).
 */

import { RuntimeHarnessError, ERROR_CODES } from '../runtime/runtimeErrors.js';
import { getRegisteredTool } from '../runtime/toolRegistry.js';

export const AGENT_VALIDATION_ERRORS = Object.freeze({
  AGENT_OUTPUT_INVALID: 'AGENT_OUTPUT_INVALID',
  AGENT_PLAN_INVALID: 'AGENT_PLAN_INVALID',
  PLAN_BOUNDS_EXCEEDED: 'PLAN_BOUNDS_EXCEEDED',
  AGENT_TOOL_DISALLOWED: 'AGENT_TOOL_DISALLOWED',
  AGENT_PROPOSAL_DISALLOWED_FIELD: 'AGENT_PROPOSAL_DISALLOWED_FIELD',
  AGENT_MULTIPLE_TOOLS_REJECTED: 'AGENT_MULTIPLE_TOOLS_REJECTED',
  MULTIPLE_TOOLS_NOT_SUPPORTED: 'MULTIPLE_TOOLS_NOT_SUPPORTED',
  SECURITY_OVERRIDE_REJECTED: 'SECURITY_OVERRIDE_REJECTED'
});

export class AgentOutputValidationError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Object} [details=null]
   */
  constructor(message, code = AGENT_VALIDATION_ERRORS.AGENT_OUTPUT_INVALID, details = null) {
    super(message);
    this.name = 'AgentOutputValidationError';
    this.code = code;
    this.details = details;
  }
}

const FORBIDDEN_SECURITY_KEYS = Object.freeze([
  'riskLevel',
  'risk',
  'permission',
  'permissionOverride',
  'confirmed',
  'humanApproved',
  'bypass',
  'budgetOverride',
  'systemPolicy',
  'toolAuthorization',
  'sessionAccess',
  'verificationSuccess',
  'override'
]);

const FORBIDDEN_SELECTOR_KEYS = Object.freeze([
  'css',
  'cssSelector',
  'xpath',
  'selector',
  'eval',
  'script',
  'function',
  'javascript',
  'js'
]);

/**
 * Extracts and parses a JSON object from raw model completion text.
 * Strips markdown code blocks and surrounding whitespace.
 *
 * @param {string} text
 * @returns {Object} Parsed JSON object
 */
export function extractJsonFromCompletion(text) {
  if (typeof text !== 'string') {
    throw new AgentOutputValidationError(
      'Model completion is not a string.',
      AGENT_VALIDATION_ERRORS.AGENT_OUTPUT_INVALID
    );
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new AgentOutputValidationError(
      'Model completion is empty.',
      AGENT_VALIDATION_ERRORS.AGENT_OUTPUT_INVALID
    );
  }

  // 1. Try direct JSON parse
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return direct;
    }
  } catch {}

  // 2. Try extracting from markdown code block ```json ... ```
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }

  // 3. Try finding outermost { ... }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }

  throw new AgentOutputValidationError(
    'Failed to parse structured JSON from model response.',
    AGENT_VALIDATION_ERRORS.AGENT_OUTPUT_INVALID,
    { rawPreview: trimmed.slice(0, 200) }
  );
}

/**
 * Recursively asserts that no raw selectors or executable code are present.
 *
 * @param {any} obj
 * @param {string} [path='']
 */
function assertNoRawSelectorsOrScripts(obj, path = '') {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      assertNoRawSelectorsOrScripts(obj[i], `${path}[${i}]`);
    }
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    const lowerKey = key.toLowerCase();

    if (FORBIDDEN_SELECTOR_KEYS.some(k => lowerKey === k.toLowerCase())) {
      throw new AgentOutputValidationError(
        `Raw selector or executable script rejected: property "${currentPath}" is prohibited.`,
        AGENT_VALIDATION_ERRORS.AGENT_PROPOSAL_DISALLOWED_FIELD,
        { property: currentPath }
      );
    }

    if (typeof value === 'string') {
      if (/^\s*(css=|xpath=|\/\/|eval\(|javascript:|<script)/i.test(value)) {
        throw new AgentOutputValidationError(
          `Raw selector or executable code rejected in property "${currentPath}".`,
          AGENT_VALIDATION_ERRORS.AGENT_PROPOSAL_DISALLOWED_FIELD,
          { property: currentPath, valuePreview: value.slice(0, 50) }
        );
      }
    }

    if (value && typeof value === 'object') {
      assertNoRawSelectorsOrScripts(value, currentPath);
    }
  }
}

/**
 * Recursively strips model-supplied security declarations.
 *
 * @param {Object} obj
 * @returns {Object} Sanitized object
 */
function stripSecurityFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => stripSecurityFields(item));
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (FORBIDDEN_SECURITY_KEYS.some(k => lowerKey === k.toLowerCase())) {
      continue; // strip security override field
    }
    cleaned[key] = value && typeof value === 'object' ? stripSecurityFields(value) : value;
  }
  return cleaned;
}

/**
 * Validates the initial short plan from the model.
 *
 * @param {Object} rawPlan
 * @returns {{ goal: string, milestones: Array<{ id: string, description: string, status: string }> }}
 */
export function validatePlanOutput(rawPlan) {
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    throw new AgentOutputValidationError(
      'Plan output must be a JSON object.',
      AGENT_VALIDATION_ERRORS.AGENT_PLAN_INVALID
    );
  }

  assertNoRawSelectorsOrScripts(rawPlan);

  const goal = typeof rawPlan.goal === 'string' ? rawPlan.goal.trim() : '';
  if (!goal) {
    throw new AgentOutputValidationError(
      'Plan must include a non-empty "goal" string.',
      AGENT_VALIDATION_ERRORS.AGENT_PLAN_INVALID
    );
  }

  if (!Array.isArray(rawPlan.milestones)) {
    throw new AgentOutputValidationError(
      'Plan must include a "milestones" array.',
      AGENT_VALIDATION_ERRORS.AGENT_PLAN_INVALID
    );
  }

  if (rawPlan.milestones.length === 0) {
    throw new AgentOutputValidationError(
      'Plan must contain at least 1 milestone.',
      AGENT_VALIDATION_ERRORS.AGENT_PLAN_INVALID
    );
  }

  if (rawPlan.milestones.length > 4) {
    throw new AgentOutputValidationError(
      `Plan exceeds maximum limit of 4 milestones (found ${rawPlan.milestones.length}).`,
      AGENT_VALIDATION_ERRORS.AGENT_PLAN_INVALID
    );
  }

  const validStatuses = new Set(['pending', 'in_progress', 'completed', 'blocked']);
  const validatedMilestones = rawPlan.milestones.map((m, idx) => {
    if (!m || typeof m !== 'object') {
      throw new AgentOutputValidationError(
        `Milestone at index ${idx} must be an object.`,
        AGENT_VALIDATION_ERRORS.AGENT_PLAN_INVALID
      );
    }
    const id = typeof m.id === 'string' && m.id.trim() ? m.id.trim() : `m${idx + 1}`;
    const description = typeof m.description === 'string' ? m.description.trim() : '';
    if (!description) {
      throw new AgentOutputValidationError(
        `Milestone "${id}" must contain a non-empty "description".`,
        AGENT_VALIDATION_ERRORS.AGENT_PLAN_INVALID
      );
    }
    const rawStatus = typeof m.status === 'string' ? m.status.trim().toLowerCase() : 'pending';
    const status = validStatuses.has(rawStatus) ? rawStatus : 'pending';

    return { id, description, status };
  });

  return Object.freeze({
    goal,
    milestones: Object.freeze(validatedMilestones)
  });
}

/**
 * Validates the next-action decision from the model.
 *
 * @param {Object} rawAction
 * @param {Array<string>} [allowedTools] - Bounded tool allowlist for current task
 * @returns {Object} Validated structured decision
 */
export function validateActionOutput(rawAction, allowedTools = null) {
  if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) {
    throw new AgentOutputValidationError(
      'Action output must be a JSON object.',
      AGENT_VALIDATION_ERRORS.AGENT_OUTPUT_INVALID
    );
  }

  // Reject model batch proposals or multiple tools
  if (
    Array.isArray(rawAction.toolProposals) ||
    Array.isArray(rawAction.tools) ||
    Array.isArray(rawAction.actions) ||
    rawAction.additionalTools !== undefined
  ) {
    throw new AgentOutputValidationError(
      'Batch execution is prohibited. Autonomous agent must propose exactly ONE tool per turn.',
      AGENT_VALIDATION_ERRORS.AGENT_MULTIPLE_TOOLS_REJECTED
    );
  }

  // Check raw selectors before stripping
  assertNoRawSelectorsOrScripts(rawAction);

  // Strip model attempts to declare authoritative security state
  const cleanedAction = stripSecurityFields(rawAction);

  let decision = typeof cleanedAction.decision === 'string' ? cleanedAction.decision.trim().toUpperCase() : '';
  if (!decision && (cleanedAction.tool || cleanedAction.toolProposal)) {
    decision = 'TOOL';
  }
  const validDecisions = new Set(['TOOL', 'COMPLETE', 'NEEDS_HUMAN_AUTH', 'CANNOT_PROCEED']);

  if (!validDecisions.has(decision)) {
    throw new AgentOutputValidationError(
      `Invalid agent decision: "${decision}". Allowed decisions: TOOL, COMPLETE, NEEDS_HUMAN_AUTH, CANNOT_PROCEED.`,
      AGENT_VALIDATION_ERRORS.AGENT_OUTPUT_INVALID
    );
  }

  if (decision === 'TOOL') {
    const proposal = cleanedAction.toolProposal || (cleanedAction.tool ? cleanedAction : null);
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
      throw new AgentOutputValidationError(
        'Decision "TOOL" must contain a "toolProposal" object or "tool" specification.',
        AGENT_VALIDATION_ERRORS.AGENT_OUTPUT_INVALID
      );
    }

    const tool = typeof proposal.tool === 'string' ? proposal.tool.trim() : '';
    if (!tool) {
      throw new AgentOutputValidationError(
        'toolProposal must contain a non-empty "tool" name string.',
        AGENT_VALIDATION_ERRORS.AGENT_OUTPUT_INVALID
      );
    }

    const toolDef = getRegisteredTool(tool);
    if (!toolDef) {
      throw new AgentOutputValidationError(
        `Tool "${tool}" is not registered in Runtime Agent Harness.`,
        AGENT_VALIDATION_ERRORS.AGENT_TOOL_DISALLOWED
      );
    }

    if (allowedTools && Array.isArray(allowedTools) && !allowedTools.includes(tool)) {
      throw new AgentOutputValidationError(
        `Tool "${tool}" is not allowed for the current task. Allowed tools: ${allowedTools.join(', ')}`,
        AGENT_VALIDATION_ERRORS.AGENT_TOOL_DISALLOWED
      );
    }

    const rawArgs = proposal.arguments || proposal.args || {};
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? { ...rawArgs }
      : {};

    // Standardize top-level fields into arguments if model placed them on proposal directly
    if (proposal.expectedSnapshotToken && !args.expectedSnapshotToken) args.expectedSnapshotToken = proposal.expectedSnapshotToken;
    if (proposal.snapshotToken && !args.expectedSnapshotToken) args.expectedSnapshotToken = proposal.snapshotToken;
    if (proposal.formId && !args.formId) args.formId = proposal.formId;
    if (proposal.fields && !args.fields) args.fields = proposal.fields;
    if (proposal.target && !args.target) args.target = proposal.target;
    if (proposal.value !== undefined && args.value === undefined) args.value = proposal.value;
    if (proposal.url && !args.url) args.url = proposal.url;
    if (proposal.pageId && !args.pageId) args.pageId = proposal.pageId;
    if (proposal.category && !args.category) args.category = proposal.category;
    if (proposal.timeoutMs && !args.timeoutMs) args.timeoutMs = proposal.timeoutMs;

    const cleanProposal = {
      tool,
      arguments: args
    };

    const ctx = (typeof proposal.contextId === 'string' && proposal.contextId.trim())
      ? proposal.contextId.trim()
      : ((typeof args.contextId === 'string' && args.contextId.trim()) ? args.contextId.trim() : null);

    if (ctx) {
      cleanProposal.contextId = ctx;
      args.contextId = ctx;
    }

    const pid = (typeof proposal.pageId === 'string' && proposal.pageId.trim())
      ? proposal.pageId.trim()
      : ((typeof args.pageId === 'string' && args.pageId.trim()) ? args.pageId.trim() : null);

    if (pid) {
      cleanProposal.pageId = pid;
      args.pageId = pid;
    }

    const result = {
      decision: 'TOOL',
      toolProposal: cleanProposal
    };

    if (cleanedAction.reason && typeof cleanedAction.reason === 'string') {
      result.reason = cleanedAction.reason.slice(0, 300);
    }
    if (cleanedAction.reasonSummary && typeof cleanedAction.reasonSummary === 'string') {
      result.reasonSummary = cleanedAction.reasonSummary.slice(0, 300);
    }
    if (cleanedAction.milestoneUpdate && typeof cleanedAction.milestoneUpdate === 'object') {
      result.milestoneUpdate = {
        id: String(cleanedAction.milestoneUpdate.id || '').trim(),
        status: String(cleanedAction.milestoneUpdate.status || '').trim()
      };
    }

    return Object.freeze(result);
  }

  if (decision === 'COMPLETE') {
    const claim = typeof cleanedAction.completionClaim === 'string' ? cleanedAction.completionClaim.trim() : '';
    return Object.freeze({
      decision: 'COMPLETE',
      completionClaim: claim || 'Task reported complete by agent.'
    });
  }

  if (decision === 'NEEDS_HUMAN_AUTH') {
    const reason = typeof cleanedAction.authReason === 'string' && cleanedAction.authReason.trim()
      ? cleanedAction.authReason.trim().toUpperCase()
      : (typeof cleanedAction.reason === 'string' && cleanedAction.reason.trim()
          ? cleanedAction.reason.trim().toUpperCase()
          : 'LOGIN_REQUIRED');
    return Object.freeze({
      decision: 'NEEDS_HUMAN_AUTH',
      authReason: reason,
      reason
    });
  }

  // CANNOT_PROCEED
  const reason = typeof cleanedAction.reason === 'string' ? cleanedAction.reason.trim() : 'Agent cannot proceed with task.';
  return Object.freeze({
    decision: 'CANNOT_PROCEED',
    reason
  });
}
