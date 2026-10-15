/**
 * Deterministic Risk Policy Engine for JARVIS4 Runtime Agent Harness (PRE-040A).
 * Calculates authoritative risk tier (R0 through R4) from tool metadata,
 * argument contents, and current runtime state.
 *
 * Invariants:
 * - Deterministic classification; never trusts model-supplied risk tags.
 * - Consequential actions (submit, purchase, external transmission) elevated to R3.
 * - Prohibited capabilities classified as R4 (hard blocked).
 */

import { RISK_LEVELS, TOOL_CATEGORIES } from './toolRegistry.js';

const CONSEQUENTIAL_TEXT_PATTERN = /\b(submit|place order|pay|purchase|checkout|confirm order|delete account|wire funds)\b/i;

/**
 * Calculates the authoritative risk level for a validated tool proposal.
 *
 * @param {Object} toolEntry - Registration record from toolRegistry
 * @param {Object} validatedProposal - Validated proposal from toolValidator
 * @param {Object} [runtimeContext={}] - Current browser/runtime context (currentUrl, activePageId, etc.)
 * @returns {string} One of RISK_LEVELS ('R0', 'R1', 'R2', 'R3', 'R4')
 */
export function calculateToolRisk(toolEntry, validatedProposal, runtimeContext = {}) {
  if (!toolEntry || toolEntry.category === TOOL_CATEGORIES.PROHIBITED || toolEntry.baseRisk === RISK_LEVELS.R4) {
    return RISK_LEVELS.R4;
  }

  const toolName = toolEntry.name;
  const args = validatedProposal.arguments || {};

  // 1. Consequential form submissions are always R3
  if (toolName === 'browser.submitForm') {
    return RISK_LEVELS.R3;
  }

  // 2. Evaluate clicks for consequential targets (submit buttons, checkout, purchase)
  if (toolName === 'browser.click' && args.target) {
    const target = args.target;
    const isSubmitType = target.type === 'submit' || target.inputType === 'submit';
    const textToCheck = [
      target.text,
      target.visibleText,
      target.accessibleName,
      target.name,
      target.label
    ].filter(Boolean).join(' ');

    const isConsequentialText = textToCheck && CONSEQUENTIAL_TEXT_PATTERN.test(textToCheck);

    if (isSubmitType || isConsequentialText) {
      return RISK_LEVELS.R3;
    }
  }

  // 3. Evaluate navigation origin: same-origin is R1; cross-origin/new domain is R2
  if (toolName === 'browser.navigate' && args.url) {
    const targetUrl = args.url;
    const currentUrl = runtimeContext.currentUrl;

    if (currentUrl && typeof currentUrl === 'string' && currentUrl !== 'about:blank') {
      try {
        const currentOrigin = new URL(currentUrl).origin;
        const targetOrigin = new URL(targetUrl).origin;
        if (currentOrigin === targetOrigin) {
          return RISK_LEVELS.R1;
        }
      } catch {
        // Safe fallback to R2 if parsing fails
      }
    }
    return RISK_LEVELS.R2;
  }

  // 4. Default to tool's registered base risk
  return toolEntry.baseRisk || RISK_LEVELS.R1;
}
