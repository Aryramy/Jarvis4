/**
 * Tool Proposal Validator for JARVIS4 Runtime Agent Harness (PRE-040A).
 * Enforces strict syntactic, schema, and security checks on model-proposed tool calls
 * before any execution or BrowserManager interaction.
 *
 * Invariants:
 * - Rejects unknown tool names (TOOL_NOT_REGISTERED).
 * - Rejects raw selectors (css, xpath, elementHandle, locator, eval, script) (FORBIDDEN_PROPERTY_DETECTED).
 * - Rejects model-injected security parameters (risk, confirmed, bypass, budgetOverride) (SECURITY_OVERRIDE_REJECTED).
 * - Rejects missing required lifecycle tokens (PAGE_ID_REQUIRED, SNAPSHOT_TOKEN_REQUIRED).
 * - Rejects malformed arguments, invalid URLs, and oversized strings (TOOL_ARGUMENT_INVALID).
 */

import { RuntimeHarnessError, ERROR_CODES } from './runtimeErrors.js';
import { getRegisteredTool } from './toolRegistry.js';
import { SUPPORTED_KINDS } from '../../browser/targetResolver.js';
import { HANDOFF_REASONS } from '../../browser/humanHandoff.js';

const FORBIDDEN_KEYS = Object.freeze(new Set([
  'selector',
  'css',
  'xpath',
  'javascript',
  'script',
  'eval',
  'function',
  'elementhandle',
  'locator'
]));

const SECURITY_OVERRIDE_KEYS = Object.freeze(new Set([
  'risklevel',
  'risk',
  'permission',
  'confirmed',
  'issafe',
  'bypass',
  'bypasssafety',
  'retrycount',
  'budgetoverride',
  'systempolicy',
  'userapproved'
]));

/**
 * Deeply scans an object or array for forbidden selector/code properties
 * and unauthorized model security override attempts.
 *
 * @param {unknown} val
 * @param {string} [path='']
 */
function scanForbiddenAndSecurityProperties(val, path = '') {
  if (!val || typeof val !== 'object') return;

  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      scanForbiddenAndSecurityProperties(val[i], `${path}[${i}]`);
    }
    return;
  }

  for (const rawKey of Object.keys(val)) {
    const lowerKey = rawKey.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (FORBIDDEN_KEYS.has(lowerKey)) {
      throw new RuntimeHarnessError(
        `Forbidden property "${rawKey}" detected at "${path || 'root'}". Raw selectors, code, and locators are not permitted.`,
        ERROR_CODES.FORBIDDEN_PROPERTY_DETECTED,
        { key: rawKey, path }
      );
    }

    if (SECURITY_OVERRIDE_KEYS.has(lowerKey)) {
      throw new RuntimeHarnessError(
        `Model security override "${rawKey}" detected at "${path || 'root'}". Models cannot self-authorize or override risk.`,
        ERROR_CODES.SECURITY_OVERRIDE_REJECTED,
        { key: rawKey, path }
      );
    }

    scanForbiddenAndSecurityProperties(val[rawKey], path ? `${path}.${rawKey}` : rawKey);
  }
}

/**
 * Public detector for forbidden properties and security overrides.
 *
 * @param {unknown} val
 */
export function detectForbiddenProperties(val) {
  scanForbiddenAndSecurityProperties(val);
}

/**
 * Validates a URL scheme and format, ensuring only safe protocols and no embedded credentials.
 *
 * @param {unknown} rawUrl
 * @returns {string}
 */
export function validateUrlScheme(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new RuntimeHarnessError('URL must be a non-empty string.', ERROR_CODES.TOOL_ARGUMENT_INVALID);
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > 2048) {
    throw new RuntimeHarnessError('URL exceeds maximum permitted length of 2048 characters.', ERROR_CODES.TOOL_ARGUMENT_INVALID);
  }
  if (trimmed === 'about:blank') {
    return trimmed;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RuntimeHarnessError(`Malformed URL: "${trimmed}".`, ERROR_CODES.TOOL_ARGUMENT_INVALID);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new RuntimeHarnessError(`Unsupported URL protocol "${parsed.protocol}". Only http: and https: are allowed.`, ERROR_CODES.TOOL_ARGUMENT_INVALID);
  }
  if (parsed.username || parsed.password) {
    throw new RuntimeHarnessError('Embedded URL credentials are not allowed.', ERROR_CODES.TOOL_ARGUMENT_INVALID);
  }
  return trimmed;
}

/**
 * Validates a semantic target query structure.
 *
 * @param {unknown} target
 * @param {string} [contextName='target']
 */
export function validateSemanticTarget(target, contextName = 'target') {
  if (!target || typeof target !== 'object') {
    throw new RuntimeHarnessError(
      `${contextName} must be a valid target object.`,
      ERROR_CODES.TOOL_ARGUMENT_INVALID
    );
  }

  // Reject selector keys in target
  if (target.selector || target.css || target.xpath || target.locator || target.js) {
    throw new RuntimeHarnessError(
      `CSS selectors, XPath, and locator expressions are not permitted in ${contextName}.`,
      ERROR_CODES.FORBIDDEN_PROPERTY_DETECTED
    );
  }

  if (!target.kind || typeof target.kind !== 'string') {
    throw new RuntimeHarnessError(
      `${contextName}.kind is required and must be a string.`,
      ERROR_CODES.TOOL_ARGUMENT_INVALID
    );
  }

  const normalizedKind = target.kind.trim().toLowerCase();
  if (!SUPPORTED_KINDS.includes(normalizedKind)) {
    throw new RuntimeHarnessError(`Unsupported target kind: "${target.kind}".`, ERROR_CODES.TOOL_ARGUMENT_INVALID);
  }

  const hasIdentifier = Boolean(
    target.role ||
    target.inputType ||
    target.accessibleName ||
    target.label ||
    target.text ||
    target.visibleText ||
    target.placeholder ||
    target.name ||
    target.href ||
    target.form ||
    target.targetId
  );

  if (!hasIdentifier) {
    throw new RuntimeHarnessError(
      `${contextName} must specify at least one semantic identifier (accessibleName, text, label, name, placeholder, etc.).`,
      ERROR_CODES.TOOL_ARGUMENT_INVALID
    );
  }
}

/**
 * Validates a structured tool proposal.
 *
 * @param {Object} proposal
 * @returns {{
 *   toolEntry: Object,
 *   tool: string,
 *   pageId: string|null,
 *   contextId: string|null,
 *   snapshotToken: string|null,
 *   arguments: Object,
 *   reason: string|null,
 *   expectedOutcome: Object|null
 * }}
 */
export function validateToolProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new RuntimeHarnessError('Tool proposal must be a valid non-empty object.', ERROR_CODES.TOOL_ARGUMENT_INVALID);
  }

  // 1. Scan proposal recursively for forbidden and security override keys
  scanForbiddenAndSecurityProperties(proposal);

  // 2. Validate tool identity
  const toolName = typeof proposal.tool === 'string' ? proposal.tool.trim() : '';
  if (!toolName) {
    throw new RuntimeHarnessError('Tool proposal must specify a valid "tool" name string.', ERROR_CODES.TOOL_ARGUMENT_INVALID);
  }

  const toolEntry = getRegisteredTool(toolName);
  if (!toolEntry) {
    throw new RuntimeHarnessError(`Tool "${toolName}" is not registered in the agent whitelist.`, ERROR_CODES.TOOL_NOT_REGISTERED, { tool: toolName });
  }

  if (toolEntry.category === 'PROHIBITED' || toolEntry.baseRisk === 'R4') {
    throw new RuntimeHarnessError(`Tool "${toolName}" is prohibited by governance policy.`, ERROR_CODES.BLOCKED_BY_POLICY, { tool: toolName });
  }

  // 3. Extract and normalize lifecycle context
  const pageId = typeof proposal.pageId === 'string' && proposal.pageId.trim()
    ? proposal.pageId.trim()
    : (typeof proposal.arguments?.pageId === 'string' && proposal.arguments.pageId.trim() ? proposal.arguments.pageId.trim() : null);

  const contextId = typeof proposal.contextId === 'string' && proposal.contextId.trim()
    ? proposal.contextId.trim()
    : (typeof proposal.arguments?.contextId === 'string' && proposal.arguments.contextId.trim() ? proposal.arguments.contextId.trim() : null);

  const snapshotToken = typeof proposal.snapshotToken === 'string' && proposal.snapshotToken.trim()
    ? proposal.snapshotToken.trim()
    : (typeof proposal.arguments?.expectedSnapshotToken === 'string' && proposal.arguments.expectedSnapshotToken.trim() ? proposal.arguments.expectedSnapshotToken.trim() : null);

  if (toolEntry.requiresPageId && !pageId) {
    throw new RuntimeHarnessError(`Tool "${toolName}" requires an explicit "pageId".`, ERROR_CODES.PAGE_ID_REQUIRED);
  }

  if (toolEntry.requiresSnapshotToken && !snapshotToken) {
    throw new RuntimeHarnessError(`Tool "${toolName}" requires an explicit "snapshotToken".`, ERROR_CODES.SNAPSHOT_TOKEN_REQUIRED);
  }

  // 4. Validate arguments object
  const args = proposal.arguments && typeof proposal.arguments === 'object' && !Array.isArray(proposal.arguments)
    ? { ...proposal.arguments }
    : {};

  // Standardize pageId / contextId / snapshotToken in arguments
  if (pageId && !args.pageId) args.pageId = pageId;
  if (contextId && !args.contextId) args.contextId = contextId;
  if (snapshotToken && !args.expectedSnapshotToken) args.expectedSnapshotToken = snapshotToken;

  // 5. Tool-specific schema validations
  validateToolSpecificArguments(toolName, args);

  // 6. Optional metadata
  const reason = typeof proposal.reason === 'string' ? proposal.reason.slice(0, 2000) : null;
  const expectedOutcome = proposal.expectedOutcome && typeof proposal.expectedOutcome === 'object'
    ? proposal.expectedOutcome
    : null;

  return {
    toolEntry,
    tool: toolName,
    pageId,
    contextId,
    snapshotToken,
    arguments: args,
    reason,
    expectedOutcome
  };
}

/**
 * Validates tool-specific arguments against deterministic constraints.
 *
 * @param {string} toolName
 * @param {Object} args
 */
function validateToolSpecificArguments(toolName, args) {
  switch (toolName) {
    case 'browser.navigate':
    case 'browser.openPage': {
      args.url = validateUrlScheme(args.url);
      break;
    }

    case 'browser.navigateHistory': {
      const act = (args.action || '').toLowerCase().trim();
      if (!['back', 'forward', 'refresh'].includes(act)) {
        throw new RuntimeHarnessError('browser.navigateHistory requires action "back", "forward", or "refresh".', ERROR_CODES.TOOL_ARGUMENT_INVALID);
      }
      args.action = act;
      break;
    }

    case 'browser.click': {
      validateSemanticTarget(args.target, 'target');
      if (args.popupPolicy) {
        const policy = String(args.popupPolicy).toLowerCase().trim();
        if (!['block', 'allow-single'].includes(policy)) {
          throw new RuntimeHarnessError('popupPolicy must be "block" or "allow-single".', ERROR_CODES.TOOL_ARGUMENT_INVALID);
        }
        args.popupPolicy = policy;
      }
      break;
    }

    case 'browser.fill': {
      validateSemanticTarget(args.target, 'target');
      if (typeof args.value !== 'string') {
        throw new RuntimeHarnessError('browser.fill requires a string "value".', ERROR_CODES.TOOL_ARGUMENT_INVALID);
      }
      if (args.value.length > 50000) {
        throw new RuntimeHarnessError('Fill value exceeds maximum permitted length of 50000 characters.', ERROR_CODES.TOOL_ARGUMENT_INVALID);
      }
      break;
    }

    case 'browser.check':
    case 'browser.uncheck': {
      validateSemanticTarget(args.target, 'target');
      break;
    }

    case 'browser.select': {
      validateSemanticTarget(args.target, 'target');
      if (typeof args.optionLabel !== 'string' || args.optionLabel.trim().length === 0) {
        throw new RuntimeHarnessError('browser.select requires a non-empty string "optionLabel".', ERROR_CODES.TOOL_ARGUMENT_INVALID);
      }
      if (args.optionLabel.length > 500) {
        throw new RuntimeHarnessError('optionLabel exceeds maximum permitted length of 500 characters.', ERROR_CODES.TOOL_ARGUMENT_INVALID);
      }
      break;
    }

    case 'browser.fillForm': {
      if (!args.fields || typeof args.fields !== 'object' || Array.isArray(args.fields) || Object.keys(args.fields).length === 0) {
        throw new RuntimeHarnessError('browser.fillForm requires a non-empty "fields" object.', ERROR_CODES.TOOL_ARGUMENT_INVALID);
      }
      if (args.form) {
        validateSemanticTarget(args.form, 'form');
      }
      break;
    }

    case 'browser.upload': {
      validateSemanticTarget(args.target, 'target');
      if (typeof args.filePath !== 'string' || args.filePath.trim().length === 0) {
        throw new RuntimeHarnessError('browser.upload requires a non-empty string "filePath".', ERROR_CODES.TOOL_ARGUMENT_INVALID);
      }
      break;
    }

    case 'browser.download': {
      validateSemanticTarget(args.target, 'target');
      break;
    }

    case 'browser.prepareFormSubmit': {
      if (args.form) validateSemanticTarget(args.form, 'form');
      if (args.submitter) validateSemanticTarget(args.submitter, 'submitter');
      if (!args.form && !args.submitter) {
        throw new RuntimeHarnessError('browser.prepareFormSubmit requires a "form" or "submitter" target query.', ERROR_CODES.TOOL_ARGUMENT_INVALID);
      }
      break;
    }

    case 'browser.submitForm': {
      // Arguments validated during internal confirmation binding
      break;
    }

    case 'browser.requestHumanAuth': {
      if (!args.reason || typeof args.reason !== 'string' || !HANDOFF_REASONS[args.reason]) {
        throw new RuntimeHarnessError(
          `browser.requestHumanAuth requires a valid "reason" code: ${Object.keys(HANDOFF_REASONS).join(', ')}.`,
          ERROR_CODES.TOOL_ARGUMENT_INVALID
        );
      }
      break;
    }

    case 'browser.extractData': {
      if (args.types !== undefined && !Array.isArray(args.types)) {
        throw new RuntimeHarnessError('browser.extractData "types" must be an array of category strings.', ERROR_CODES.TOOL_ARGUMENT_INVALID);
      }
      break;
    }

    default:
      break;
  }
}
