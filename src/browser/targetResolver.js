/**
 * Target Resolver module for JARVIS4 (Brick 29).
 * Provides deterministic, semantic, read-only element target resolution without interaction.
 *
 * Strict invariants:
 * - Read-only: zero clicking, typing, scrolling, form submitting, reloading, or navigating.
 * - Strict privacy: zero field values returned (passwords, text, email, tokens omitted).
 * - Untrusted data: extracted content treated strictly as passive text, zero AI calls.
 * - Exact-match-first: prefers exact normalized matches before weaker matching.
 * - Ambiguity handling: returns TARGET_AMBIGUOUS if multiple candidates tie.
 * - Not-found handling: returns TARGET_NOT_FOUND if no candidate matches.
 * - Staleness protection: target results are tied to a page snapshot token and invalidated on navigation.
 * - No actionable selectors exposed: zero CSS selectors, XPath, Playwright locators, or handles exposed.
 */

export class TargetResolutionError extends Error {
  constructor(message, code = 'TARGET_RESOLUTION_FAILED') {
    super(message);
    this.name = 'TargetResolutionError';
    this.code = code;
  }
}

export const SUPPORTED_KINDS = Object.freeze([
  'heading',
  'link',
  'button',
  'input',
  'textarea',
  'select',
  'form'
]);

/**
 * Normalizes text deterministically: Unicode NFC normalization, trimming,
 * collapsing multiple whitespace characters into single space, and lowercase.
 * Preserves Unicode scripts (English, Arabic, Urdu, etc.) without alteration.
 *
 * @param {unknown} str
 * @returns {string}
 */
export function normalizeTargetText(str) {
  if (typeof str !== 'string') return '';
  return str
    .normalize('NFC')
    .trim()
    .replace(/[\s\t\r\n]+/g, ' ')
    .toLowerCase();
}

let tokenCounter = 0;

/**
 * Generates an opaque, non-sensitive snapshot token tied to the current page document version.
 *
 * @param {number} [version=1]
 * @param {string} [salt='']
 * @returns {string}
 */
export function generateSnapshotToken(version = 1, salt = '') {
  const v = Math.max(1, Number(version) || 1);
  tokenCounter = (tokenCounter + 1) % 1000000;
  const s = salt ? String(salt) : `${Date.now().toString(36)}_${tokenCounter.toString(36)}`;
  return `snap_v${v}_${s}`;
}

/**
 * Creates a safe, non-actionable, privacy-preserving summary of an element candidate.
 * Never includes input values, passwords, cookies, or raw DOM selectors.
 *
 * @param {Object} el
 * @param {number} [index]
 * @param {string} [snapshotToken]
 * @returns {Object}
 */
export function createSafeElementSummary(el, index, snapshotToken) {
  if (!el || typeof el !== 'object') return {};

  const summary = {
    kind: el.kind,
    tag: el.tag
  };

  if (el.role) summary.role = el.role;
  if (el.accessibleName) summary.accessibleName = el.accessibleName;
  if (el.text) summary.text = el.text;
  if (el.label) summary.label = el.label;
  if (el.placeholder) summary.placeholder = el.placeholder;
  if (el.inputType) summary.inputType = el.inputType;
  if (el.name) summary.name = el.name;
  if (el.href) summary.href = el.href;
  if (el.disabled) summary.disabled = true;
  if (el.required) summary.required = true;
  if (el.checked !== undefined) summary.checked = el.checked;
  if (el.selectedText) summary.selectedText = el.selectedText;
  if (el.method) summary.method = el.method;
  if (el.action) summary.action = el.action;
  if (el.formAction) summary.formAction = el.formAction;
  if (el.formMethod) summary.formMethod = el.formMethod;
  if (el.formName) summary.formName = el.formName;

  // Internal opaque snapshot-local reference (Section 13)
  if (snapshotToken && index !== undefined) {
    const salt = Buffer.from(snapshotToken).toString('base64url').slice(0, 8);
    summary.targetId = `tgt_${index}_${salt}`;
  }

  return summary;
}

/**
 * Resolves a unique target element from a list of visible elements using deterministic semantic scoring.
 *
 * @param {Array<Object>} elements - List of visible elements from Brick 28 inspection
 * @param {Object|string} targetQuery - Target description object
 * @param {Object} [options={}]
 * @param {string} [options.snapshotToken]
 * @param {string} [options.pageUrl]
 * @param {string} [options.pageTitle]
 * @returns {{
 *   success: boolean,
 *   resolution: 'unique' | 'ambiguous' | 'not_found',
 *   target: Object,
 *   match?: Object,
 *   candidates?: Array<Object>,
 *   candidateCount: number,
 *   confidence?: 'high' | 'medium' | 'low',
 *   matchedBy?: Array<string>,
 *   pageUrl?: string,
 *   pageTitle?: string,
 *   snapshotToken?: string,
 *   error?: string,
 *   code?: string,
 *   message?: string
 * }}
 */
export function resolveTargetFromElements(elements, targetQuery, options = {}) {
  if (!Array.isArray(elements)) {
    elements = [];
  }

  let query = targetQuery;
  if (typeof query === 'string') {
    query = { name: query };
  }

  if (!query || typeof query !== 'object') {
    throw new TargetResolutionError('Target query must be an object', 'INVALID_TARGET_QUERY');
  }

  // Reject forbidden selector types
  if (query.selector || query.css || query.xpath || query.locator || query.js) {
    throw new TargetResolutionError(
      'CSS selectors, XPath, and locator expressions are not accepted.',
      'INVALID_TARGET_QUERY'
    );
  }

  // Validate supported kind if supplied
  let targetKind = null;
  if (query.kind !== undefined && query.kind !== null) {
    if (typeof query.kind !== 'string' || query.kind.trim().length === 0) {
      throw new TargetResolutionError('Target kind must be a non-empty string', 'INVALID_TARGET_QUERY');
    }
    const normalizedKind = query.kind.trim().toLowerCase();
    if (!SUPPORTED_KINDS.includes(normalizedKind)) {
      throw new TargetResolutionError(`Unsupported target kind: ${query.kind}`, 'UNSUPPORTED_TARGET_KIND');
    }
    targetKind = normalizedKind;
  }

  // Extract normalized query signals
  const targetRole = typeof query.role === 'string' ? normalizeTargetText(query.role) : null;
  const targetInputType = typeof query.inputType === 'string' ? normalizeTargetText(query.inputType) : null;
  const targetAccName = typeof query.accessibleName === 'string' ? normalizeTargetText(query.accessibleName) : null;
  const targetLabel = typeof query.label === 'string' ? normalizeTargetText(query.label) : null;
  const targetText = typeof (query.visibleText || query.text) === 'string' ? normalizeTargetText(query.visibleText || query.text) : null;
  const targetPlaceholder = typeof query.placeholder === 'string' ? normalizeTargetText(query.placeholder) : null;
  const targetName = typeof query.name === 'string' ? normalizeTargetText(query.name) : null;
  const targetHref = typeof query.href === 'string' ? normalizeTargetText(query.href) : null;
  const targetForm = typeof query.form === 'string' ? normalizeTargetText(query.form) : null;

  const hasAnySignal = Boolean(
    targetKind || targetRole || targetInputType || targetAccName ||
    targetLabel || targetText || targetPlaceholder || targetName || targetHref || targetForm
  );

  if (!hasAnySignal) {
    throw new TargetResolutionError('Target query must specify at least one search signal.', 'INVALID_TARGET_QUERY');
  }

  const snapshotToken = options.snapshotToken || generateSnapshotToken();
  const pageUrl = options.pageUrl || '';
  const pageTitle = options.pageTitle || '';

  // 1. Initial Filtering by strict category signals
  const eligibleCandidates = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el || typeof el !== 'object') continue;

    // Filter by kind
    if (targetKind && el.kind !== targetKind && el.role !== targetKind) {
      continue;
    }

    // Filter by role
    if (targetRole && el.role !== targetRole) {
      continue;
    }

    // Filter by inputType
    if (targetInputType && el.inputType !== targetInputType) {
      continue;
    }

    // Filter by form context if supplied
    if (targetForm) {
      const fSources = [el.formAction, el.formName, el.action, el.formMethod].filter(Boolean).map(normalizeTargetText);
      const matchesForm = fSources.some(s => s.includes(targetForm) || s === targetForm);
      if (!matchesForm) {
        continue;
      }
    }

    eligibleCandidates.push({ el, originalIndex: i });
  }

  if (eligibleCandidates.length === 0) {
    return {
      success: false,
      resolution: 'not_found',
      error: 'TARGET_NOT_FOUND',
      code: 'TARGET_NOT_FOUND',
      message: 'No matching element found on the current page.',
      target: query,
      candidateCount: 0,
      pageUrl,
      pageTitle,
      snapshotToken
    };
  }

  // 2. Score Candidates using Exact-Match-First Priority (Section 7 & 8)
  const exactScored = [];

  for (const { el, originalIndex } of eligibleCandidates) {
    let score = 0;
    const matchedBy = [];

    if (targetKind && (el.kind === targetKind || el.role === targetKind)) {
      matchedBy.push('kind');
      score += 10;
    }
    if (targetRole && el.role === targetRole) {
      matchedBy.push('role');
      score += 10;
    }
    if (targetInputType && el.inputType === targetInputType) {
      matchedBy.push('inputType');
      score += 10;
    }
    if (targetForm) {
      matchedBy.push('form');
      score += 15;
    }

    const normAcc = normalizeTargetText(el.accessibleName || el.ariaLabel);
    const normLabel = normalizeTargetText(el.label);
    const normText = normalizeTargetText(el.text);
    const normPh = normalizeTargetText(el.placeholder);
    const normNameAttr = normalizeTargetText(el.name);
    const normHref = normalizeTargetText(el.href);

    let hasPrimarySignalMatch = false;

    // A. Specific Signal Queries
    if (targetAccName && normAcc && normAcc === targetAccName) {
      matchedBy.push('accessibleName');
      score += 100;
      hasPrimarySignalMatch = true;
    }

    if (targetLabel && normLabel && normLabel === targetLabel) {
      matchedBy.push('label');
      score += 90;
      hasPrimarySignalMatch = true;
    }

    if (targetText && normText && normText === targetText) {
      matchedBy.push('visibleText');
      score += 80;
      hasPrimarySignalMatch = true;
    }

    if (targetPlaceholder && normPh && normPh === targetPlaceholder) {
      matchedBy.push('placeholder');
      score += 70;
      hasPrimarySignalMatch = true;
    }

    if (targetHref && normHref && normHref === targetHref) {
      matchedBy.push('href');
      score += 50;
      hasPrimarySignalMatch = true;
    }

    // B. General `name` Query (matches accessibleName > label > text > placeholder > name attribute)
    if (targetName) {
      if (normAcc && normAcc === targetName) {
        matchedBy.push('accessibleName');
        score += 100;
        hasPrimarySignalMatch = true;
      } else if (normLabel && normLabel === targetName) {
        matchedBy.push('label');
        score += 90;
        hasPrimarySignalMatch = true;
      } else if (normText && normText === targetName) {
        matchedBy.push('visibleText');
        score += 80;
        hasPrimarySignalMatch = true;
      } else if (normPh && normPh === targetName) {
        matchedBy.push('placeholder');
        score += 70;
        hasPrimarySignalMatch = true;
      } else if (normNameAttr && normNameAttr === targetName) {
        matchedBy.push('name');
        score += 60;
        hasPrimarySignalMatch = true;
      }
    }

    // If only structural signals (like kind: 'form' or kind: 'input' with inputType: 'password')
    // were queried without specific text labels:
    const onlyStructuralQueried = !targetName && !targetAccName && !targetLabel && !targetText && !targetPlaceholder && !targetHref;
    if (onlyStructuralQueried && score > 0) {
      hasPrimarySignalMatch = true;
    }

    if (hasPrimarySignalMatch) {
      exactScored.push({ el, originalIndex, score, matchedBy });
    }
  }

  // 3. Process Exact Matches
  if (exactScored.length > 0) {
    // Sort descending by score
    exactScored.sort((a, b) => b.score - a.score);

    const highestScore = exactScored[0].score;
    const topCandidates = exactScored.filter(c => c.score === highestScore);

    if (topCandidates.length === 1) {
      const winner = topCandidates[0];
      return {
        success: true,
        resolution: 'unique',
        target: query,
        match: createSafeElementSummary(winner.el, winner.originalIndex, snapshotToken),
        confidence: 'high',
        matchedBy: winner.matchedBy,
        candidateCount: 1,
        pageUrl,
        pageTitle,
        snapshotToken
      };
    }

    // Tied candidates -> TARGET_AMBIGUOUS
    return {
      success: false,
      resolution: 'ambiguous',
      error: 'TARGET_AMBIGUOUS',
      code: 'TARGET_AMBIGUOUS',
      message: 'Multiple elements matched the target query equally.',
      target: query,
      candidateCount: topCandidates.length,
      candidates: topCandidates.map(c => createSafeElementSummary(c.el, c.originalIndex, snapshotToken)),
      pageUrl,
      pageTitle,
      snapshotToken
    };
  }

  // 4. Partial Matching (Fallback when exact match produced 0 candidates, Section 24 & 25)
  const searchText = targetName || targetAccName || targetLabel || targetText || targetPlaceholder;

  if (searchText && searchText.length >= 2) {
    const partialScored = [];

    for (const { el, originalIndex } of eligibleCandidates) {
      let score = 0;
      const matchedBy = [];

      if (targetKind && (el.kind === targetKind || el.role === targetKind)) {
        matchedBy.push('kind');
        score += 10;
      }

      const normAcc = normalizeTargetText(el.accessibleName || el.ariaLabel);
      const normLabel = normalizeTargetText(el.label);
      const normText = normalizeTargetText(el.text);
      const normPh = normalizeTargetText(el.placeholder);

      if (normAcc && normAcc.includes(searchText)) {
        matchedBy.push('accessibleName');
        score += 30;
      } else if (normLabel && normLabel.includes(searchText)) {
        matchedBy.push('label');
        score += 25;
      } else if (normText && normText.includes(searchText)) {
        matchedBy.push('visibleText');
        score += 20;
      } else if (normPh && normPh.includes(searchText)) {
        matchedBy.push('placeholder');
        score += 15;
      }

      if (score > 10) {
        partialScored.push({ el, originalIndex, score, matchedBy });
      }
    }

    if (partialScored.length > 0) {
      partialScored.sort((a, b) => b.score - a.score);

      const highestScore = partialScored[0].score;
      const topCandidates = partialScored.filter(c => c.score === highestScore);

      if (topCandidates.length === 1) {
        const winner = topCandidates[0];
        return {
          success: true,
          resolution: 'unique',
          target: query,
          match: createSafeElementSummary(winner.el, winner.originalIndex, snapshotToken),
          confidence: 'medium',
          matchedBy: winner.matchedBy,
          candidateCount: 1,
          pageUrl,
          pageTitle,
          snapshotToken
        };
      }

      return {
        success: false,
        resolution: 'ambiguous',
        error: 'TARGET_AMBIGUOUS',
        code: 'TARGET_AMBIGUOUS',
        message: 'Multiple elements matched the target query partially.',
        target: query,
        candidateCount: topCandidates.length,
        candidates: topCandidates.map(c => createSafeElementSummary(c.el, c.originalIndex, snapshotToken)),
        pageUrl,
        pageTitle,
        snapshotToken
      };
    }
  }

  // 5. Not Found
  return {
    success: false,
    resolution: 'not_found',
    error: 'TARGET_NOT_FOUND',
    code: 'TARGET_NOT_FOUND',
    message: 'No matching element found on the current page.',
    target: query,
    candidateCount: 0,
    pageUrl,
    pageTitle,
    snapshotToken
  };
}
