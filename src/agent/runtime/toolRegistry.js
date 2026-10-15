/**
 * Tool Registry for JARVIS4 Runtime Agent Harness (PRE-040A).
 * Defines explicit tool contracts, categories, base risk classifications,
 * and deterministic mappings to BrowserManager execution primitives.
 *
 * Invariants:
 * - Fixed whitelist of registered tools; no dynamic/eval dispatch.
 * - Raw JavaScript, CSS selectors, XPath, and Playwright objects strictly omitted.
 * - Explicit categorization and base risk assignment.
 * - Prohibited capabilities (e.g. resuming auth handoffs) explicitly classified as R4.
 */

import { RuntimeHarnessError, ERROR_CODES } from './runtimeErrors.js';

export const TOOL_CATEGORIES = Object.freeze({
  OBSERVE: 'OBSERVE',
  NAVIGATE: 'NAVIGATE',
  MUTATE: 'MUTATE',
  TRANSFER: 'TRANSFER',
  AUTH_HANDOFF: 'AUTH_HANDOFF',
  CONSEQUENTIAL: 'CONSEQUENTIAL',
  PROHIBITED: 'PROHIBITED'
});

export const RISK_LEVELS = Object.freeze({
  R0: 'R0', // Read-only observation
  R1: 'R1', // Reversible / bounded interaction
  R2: 'R2', // Moderate state change / cross-origin / transfer
  R3: 'R3', // Consequential external action requiring human confirmation
  R4: 'R4'  // Prohibited to autonomous agent
});

/**
 * Registry definitions for all approved agent tools.
 */
const TOOL_DEFINITIONS = [
  // --- Category: OBSERVE (R0) ---
  {
    name: 'browser.getPageStatus',
    category: TOOL_CATEGORIES.OBSERVE,
    baseRisk: RISK_LEVELS.R0,
    isMutating: false,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'Retrieves point-in-time status, URL, and title of active managed page.',
    handler: async (bm) => bm.getPageStatus()
  },
  {
    name: 'browser.inspectPage',
    category: TOOL_CATEGORIES.OBSERVE,
    baseRisk: RISK_LEVELS.R0,
    isMutating: false,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'Observes visible text and interactive element inventory of active document or context.',
    handler: async (bm, args) => bm.inspectPage(args)
  },
  {
    name: 'browser.inspectContexts',
    category: TOOL_CATEGORIES.OBSERVE,
    baseRisk: RISK_LEVELS.R0,
    isMutating: false,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'Discovers hierarchy of iframes and open shadow roots on the page.',
    handler: async (bm, args) => bm.inspectContexts(args.pageId)
  },
  {
    name: 'browser.inspectForms',
    category: TOOL_CATEGORIES.OBSERVE,
    baseRisk: RISK_LEVELS.R0,
    isMutating: false,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'Discovers forms and semantic input fields on the active page without scraping values.',
    handler: async (bm, args) => bm.inspectForms(args)
  },
  {
    name: 'browser.extractData',
    category: TOOL_CATEGORIES.OBSERVE,
    baseRisk: RISK_LEVELS.R0,
    isMutating: false,
    requiresPageId: false,
    requiresSnapshotToken: true,
    budgetCounter: 'toolCalls',
    description: 'Extracts bounded structured data across 7 semantic categories.',
    handler: async (bm, args) => bm.extractStructuredData(args)
  },
  {
    name: 'browser.waitForStable',
    category: TOOL_CATEGORIES.OBSERVE,
    baseRisk: RISK_LEVELS.R0,
    isMutating: false,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'Waits for dynamic DOM mutations to settle on the active page.',
    handler: async (bm, args) => bm.waitForStable(args)
  },
  {
    name: 'browser.waitForTarget',
    category: TOOL_CATEGORIES.OBSERVE,
    baseRisk: RISK_LEVELS.R0,
    isMutating: false,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'Waits for a unique semantic target to become ready on the page.',
    handler: async (bm, args) => bm.waitForTarget(args)
  },
  {
    name: 'browser.listPages',
    category: TOOL_CATEGORIES.OBSERVE,
    baseRisk: RISK_LEVELS.R0,
    isMutating: false,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'Lists all open managed pages and tabs.',
    handler: async (bm) => bm.listPages()
  },
  {
    name: 'browser.listDownloads',
    category: TOOL_CATEGORIES.OBSERVE,
    baseRisk: RISK_LEVELS.R0,
    isMutating: false,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'Lists completed downloads in the approved JARVIS download directory.',
    handler: async (bm) => {
      if (bm.fileTransferManager && typeof bm.fileTransferManager.listDownloads === 'function') {
        return bm.fileTransferManager.listDownloads();
      }
      return { downloads: [] };
    }
  },

  // --- Category: NAVIGATE (R1 / R2) ---
  {
    name: 'browser.navigate',
    category: TOOL_CATEGORIES.NAVIGATE,
    baseRisk: RISK_LEVELS.R1,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'navigations',
    description: 'Navigates active page to an authorized HTTP/HTTPS destination URL.',
    handler: async (bm, args) => bm.navigate(args.url, args)
  },
  {
    name: 'browser.navigateHistory',
    category: TOOL_CATEGORIES.NAVIGATE,
    baseRisk: RISK_LEVELS.R1,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'navigations',
    description: 'Executes back, forward, or refresh on active page history.',
    handler: async (bm, args) => {
      const action = (args.action || '').toLowerCase();
      if (action === 'back') return bm.back(args);
      if (action === 'forward') return bm.forward(args);
      if (action === 'refresh') return bm.refresh(args);
      throw new RuntimeHarnessError(`Invalid history navigation action: "${args.action}"`, ERROR_CODES.TOOL_ARGUMENT_INVALID);
    }
  },
  {
    name: 'browser.openPage',
    category: TOOL_CATEGORIES.NAVIGATE,
    baseRisk: RISK_LEVELS.R2,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'navigations',
    description: 'Opens a new managed page or tab at the requested URL.',
    handler: async (bm, args) => bm.openPage(args.url, args)
  },
  {
    name: 'browser.switchPage',
    category: TOOL_CATEGORIES.NAVIGATE,
    baseRisk: RISK_LEVELS.R1,
    isMutating: true,
    requiresPageId: true,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'Switches the active managed page context to specified page ID.',
    handler: async (bm, args) => bm.switchPage(args.pageId)
  },
  {
    name: 'browser.closePage',
    category: TOOL_CATEGORIES.NAVIGATE,
    baseRisk: RISK_LEVELS.R2,
    isMutating: true,
    requiresPageId: true,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'Closes the specified managed page.',
    handler: async (bm, args) => bm.closePage(args.pageId)
  },

  // --- Category: MUTATE (R1 / R2) ---
  {
    name: 'browser.click',
    category: TOOL_CATEGORIES.MUTATE,
    baseRisk: RISK_LEVELS.R1,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: true,
    budgetCounter: 'mutations',
    description: 'Performs a semantic click on a unique, high-confidence interactive target.',
    handler: async (bm, args) => bm.executeAction({ action: 'click', ...args })
  },
  {
    name: 'browser.fill',
    category: TOOL_CATEGORIES.MUTATE,
    baseRisk: RISK_LEVELS.R1,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: true,
    budgetCounter: 'mutations',
    description: 'Fills text into a uniquely resolved text input or textarea.',
    handler: async (bm, args) => bm.executeAction({ action: 'fill', ...args })
  },
  {
    name: 'browser.check',
    category: TOOL_CATEGORIES.MUTATE,
    baseRisk: RISK_LEVELS.R1,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: true,
    budgetCounter: 'mutations',
    description: 'Checks a uniquely resolved checkbox or radio input.',
    handler: async (bm, args) => bm.executeAction({ action: 'check', ...args })
  },
  {
    name: 'browser.uncheck',
    category: TOOL_CATEGORIES.MUTATE,
    baseRisk: RISK_LEVELS.R1,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: true,
    budgetCounter: 'mutations',
    description: 'Unchecks a uniquely resolved checkbox.',
    handler: async (bm, args) => bm.executeAction({ action: 'uncheck', ...args })
  },
  {
    name: 'browser.select',
    category: TOOL_CATEGORIES.MUTATE,
    baseRisk: RISK_LEVELS.R1,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: true,
    budgetCounter: 'mutations',
    description: 'Selects an option by label in a uniquely resolved dropdown.',
    handler: async (bm, args) => bm.executeAction({ action: 'select', ...args })
  },
  {
    name: 'browser.fillForm',
    category: TOOL_CATEGORIES.MUTATE,
    baseRisk: RISK_LEVELS.R2,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: true,
    budgetCounter: 'mutations',
    description: 'Transactionally populates multiple semantic form fields with rollback safety.',
    handler: async (bm, args) => bm.fillForm(args)
  },

  // --- Category: CONSEQUENTIAL (R2 / R3) ---
  {
    name: 'browser.prepareFormSubmit',
    category: TOOL_CATEGORIES.CONSEQUENTIAL,
    baseRisk: RISK_LEVELS.R2,
    isMutating: false,
    requiresPageId: false,
    requiresSnapshotToken: true,
    budgetCounter: 'toolCalls',
    description: 'Evaluates native HTML5 form validity and prepares confirmation token without submitting.',
    handler: async (bm, args) => bm.prepareFormSubmission(args)
  },
  {
    name: 'browser.submitForm',
    category: TOOL_CATEGORIES.CONSEQUENTIAL,
    baseRisk: RISK_LEVELS.R3,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: true,
    confirmationRequired: true,
    budgetCounter: 'submissions',
    description: 'Submits a prepared form with single-use confirmation token and evaluates evidence.',
    handler: async (bm, args) => bm.submitForm(args)
  },

  // --- Category: TRANSFER (R2) ---
  {
    name: 'browser.upload',
    category: TOOL_CATEGORIES.TRANSFER,
    baseRisk: RISK_LEVELS.R2,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: true,
    budgetCounter: 'uploads',
    description: 'Uploads a pre-authorized, validated local file into a resolved file input.',
    handler: async (bm, args) => bm.uploadFile(args)
  },
  {
    name: 'browser.download',
    category: TOOL_CATEGORIES.TRANSFER,
    baseRisk: RISK_LEVELS.R2,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: true,
    budgetCounter: 'downloads',
    description: 'Clicks a download link and verifies real browser download event and safe file storage.',
    handler: async (bm, args) => bm.downloadFile(args)
  },

  // --- Category: AUTH_HANDOFF (R1) ---
  {
    name: 'browser.requestHumanAuth',
    category: TOOL_CATEGORIES.AUTH_HANDOFF,
    baseRisk: RISK_LEVELS.R1,
    isMutating: false,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'Initiates a safe human authentication handoff for login, MFA, or CAPTCHA barriers.',
    handler: async (bm, args) => bm.startHandoff(args)
  },
  {
    name: 'browser.cancelHandoff',
    category: TOOL_CATEGORIES.AUTH_HANDOFF,
    baseRisk: RISK_LEVELS.R1,
    isMutating: false,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'Cancels an active human authentication handoff.',
    handler: async (bm, args) => bm.cancelHandoff(args)
  },

  // --- Category: PROHIBITED (R4) ---
  {
    name: 'browser.resumeHandoff',
    category: TOOL_CATEGORIES.PROHIBITED,
    baseRisk: RISK_LEVELS.R4,
    isMutating: true,
    requiresPageId: false,
    requiresSnapshotToken: false,
    budgetCounter: 'toolCalls',
    description: 'HUMAN-ONLY action. Autonomous agents are strictly prohibited from resuming auth handoffs.',
    handler: async () => {
      throw new RuntimeHarnessError('Autonomous agents are prohibited from resuming human authentication handoffs.', ERROR_CODES.BLOCKED_BY_POLICY);
    }
  }
];

const TOOL_REGISTRY = new Map();
for (const def of TOOL_DEFINITIONS) {
  TOOL_REGISTRY.set(def.name, Object.freeze(def));
}

/**
 * Retrieves a registered tool definition by exact name.
 * Returns null if tool is not registered.
 *
 * @param {string} toolName
 * @returns {Readonly<Object>|null}
 */
export function getRegisteredTool(toolName) {
  if (typeof toolName !== 'string') return null;
  return TOOL_REGISTRY.get(toolName.trim()) || null;
}

/**
 * Checks whether a tool name is registered in the whitelist.
 *
 * @param {string} toolName
 * @returns {boolean}
 */
export function isToolRegistered(toolName) {
  return getRegisteredTool(toolName) !== null;
}

/**
 * Returns a list of all registered tool definitions.
 *
 * @returns {Readonly<Object>[]}
 */
export function getAllRegisteredTools() {
  return Array.from(TOOL_REGISTRY.values());
}

/**
 * Returns a list of all registered tool names.
 *
 * @returns {string[]}
 */
export function listRegisteredToolNames() {
  return Array.from(TOOL_REGISTRY.keys());
}
