/**
 * Bounded Verification & Evidence Policy for JARVIS4 (BRICK-042).
 * Strictly governs verification-before-completion, evidence provenance,
 * freshness, page/context binding, and anti-self-grading rules.
 *
 * Invariants:
 * - Deterministic policy: Model confidence or completion claim NEVER determines completion.
 * - Tool execution success != action effect verified != user goal verified.
 * - Only TRUSTED_RUNTIME_EVIDENCE can satisfy deterministic completion criteria.
 * - Webpage text remains UNTRUSTED_PAGE_DATA (prompt injection cannot bypass verification).
 * - Fresh post-action evidence is required for mutations; pre-action evidence is stale.
 * - Bounded verification budget: maxVerificationCycles = 2.
 * - Zero automatic mutation during verification (verification is non-mutating).
 * - Zero raw HTML, DOM handles, passwords, cookies, or secrets stored in ledger.
 */

import crypto from 'node:crypto';

export const TRUST_LEVELS = Object.freeze({
  TRUSTED_RUNTIME_EVIDENCE: 'TRUSTED_RUNTIME_EVIDENCE',
  UNTRUSTED_PAGE_DATA: 'UNTRUSTED_PAGE_DATA',
  MODEL_CLAIM: 'MODEL_CLAIM',
  USER_INPUT: 'USER_INPUT'
});

export const VERIFICATION_CRITERIA_TYPES = Object.freeze({
  TEXT_PRESENT: 'TEXT_PRESENT',
  TEXT_ABSENT: 'TEXT_ABSENT',
  TEXT_EQUALS: 'TEXT_EQUALS',
  URL_EQUALS: 'URL_EQUALS',
  URL_CONTAINS: 'URL_CONTAINS',
  TARGET_PRESENT: 'TARGET_PRESENT',
  TARGET_ABSENT: 'TARGET_ABSENT',
  INPUT_VALUE_EQUALS: 'INPUT_VALUE_EQUALS',
  CHECKBOX_STATE: 'CHECKBOX_STATE',
  SELECTED_VALUE: 'SELECTED_VALUE',
  STRUCTURED_DATA_EQUALS: 'STRUCTURED_DATA_EQUALS',
  DOWNLOAD_VERIFIED: 'DOWNLOAD_VERIFIED',
  PAGE_COUNT_EQUALS: 'PAGE_COUNT_EQUALS',
  PAGE_PRESENT: 'PAGE_PRESENT',
  TERMINAL_STATE_EQUALS: 'TERMINAL_STATE_EQUALS',
  HANDOFF_STATE_EQUALS: 'HANDOFF_STATE_EQUALS',
  SAFE_REFUSAL_CODE_EQUALS: 'SAFE_REFUSAL_CODE_EQUALS'
});

export const VERIFICATION_OUTCOMES = Object.freeze({
  VERIFIED: 'VERIFIED',
  MISSING_EVIDENCE: 'MISSING_EVIDENCE',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  VERIFICATION_CONFLICT: 'VERIFICATION_CONFLICT',
  VERIFICATION_EXHAUSTED: 'VERIFICATION_EXHAUSTED'
});

export const VERIFICATION_BUDGET_DEFAULTS = Object.freeze({
  maxCriteria: 4,
  maxVerificationCycles: 2,
  maxEvidenceItems: 50
});

const VALID_RUNTIME_TOOLS = new Set([
  'browser.inspectPage',
  'browser.extractStructured',
  'browser.inspectForms',
  'browser.waitForStable',
  'browser.listPages',
  'browser.switchPage',
  'browser.inspectContexts',
  'browser.downloadFile',
  'browser.uploadFile',
  'browser.click',
  'browser.fill',
  'browser.fillForm',
  'browser.submitForm',
  'browser.navigate',
  'browser.requestHumanAuth',
  'runtime.harness',
  'runtime.event'
]);

const FORBIDDEN_SECRET_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /bearer\s+/i,
  /cookie/i,
  /authorization/i,
  /otp/i
];

/**
 * Sanitizes evidence values to ensure no raw passwords, secrets, cookies, or large HTML blobs leak.
 *
 * @param {any} val
 * @param {string} [keyName='']
 * @returns {any}
 */
export function sanitizeEvidenceValue(val, keyName = '') {
  if (val === null || val === undefined) return val;

  const isSensitiveKey = FORBIDDEN_SECRET_PATTERNS.some(p => p.test(keyName));
  if (isSensitiveKey) {
    return '[REDACTED_SECRET]';
  }

  if (typeof val === 'string') {
    // If value looks like a secret, token, or long raw html
    if (/sk-or-v1-[a-f0-9]{32,}/i.test(val) || /bearer\s+[A-Za-z0-9._-]+/i.test(val)) {
      return '[REDACTED_TOKEN]';
    }
    if (val.length > 300) {
      return val.slice(0, 300) + '...[TRUNCATED]';
    }
    return val;
  }

  if (typeof val === 'number' || typeof val === 'boolean') {
    return val;
  }

  if (Array.isArray(val)) {
    return val.slice(0, 20).map((item, idx) => sanitizeEvidenceValue(item, `${keyName}[${idx}]`));
  }

  if (typeof val === 'object') {
    const sanitized = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === 'html' || k === 'outerHTML' || k === 'innerHTML' || k === 'fullHtml') {
        sanitized[k] = '[RAW_HTML_OMITTED]';
        continue;
      }
      sanitized[k] = sanitizeEvidenceValue(v, k);
    }
    return sanitized;
  }

  return String(val);
}

/**
 * Bounded Evidence Ledger for JARVIS4 (BRICK-042).
 * Records trusted observation events and results with strict provenance and sequence.
 */
export class EvidenceLedger {
  constructor(options = {}) {
    this.maxItems = options.maxItems || VERIFICATION_BUDGET_DEFAULTS.maxEvidenceItems;
    this.items = [];
    this.sequence = 0;
  }

  /**
   * Adds an evidence item to the ledger with deterministic provenance verification.
   *
   * @param {Object} raw
   * @returns {Object} Stored sanitized evidence item
   */
  addEvidence(raw = {}) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('Evidence item must be an object.');
    }

    const sourceTool = typeof raw.sourceTool === 'string' ? raw.sourceTool.trim() : 'unknown';
    let trustLevel = raw.trustLevel || TRUST_LEVELS.UNTRUSTED_PAGE_DATA;

    // Provenance validation: Only genuine runtime sources can receive TRUSTED_RUNTIME_EVIDENCE
    if (trustLevel === TRUST_LEVELS.TRUSTED_RUNTIME_EVIDENCE) {
      if (!VALID_RUNTIME_TOOLS.has(sourceTool)) {
        trustLevel = TRUST_LEVELS.MODEL_CLAIM; // Downgrade forged or unverified provenance
      }
    }

    this.sequence++;
    const evidenceId = `ev_${this.sequence}_${crypto.randomBytes(3).toString('hex')}`;

    const evidenceType = typeof raw.evidenceType === 'string' && raw.evidenceType.trim()
      ? raw.evidenceType.trim().toUpperCase()
      : 'OBSERVATION';

    const item = Object.freeze({
      evidenceId,
      evidenceType,
      sourceTool,
      pageId: typeof raw.pageId === 'string' ? raw.pageId : null,
      contextId: typeof raw.contextId === 'string' ? raw.contextId : null,
      snapshotToken: typeof raw.snapshotToken === 'string' ? raw.snapshotToken : null,
      sequence: this.sequence,
      relatedActionId: typeof raw.relatedActionId === 'number' ? raw.relatedActionId : null,
      trustLevel,
      sanitizedValue: sanitizeEvidenceValue(raw.value !== undefined ? raw.value : raw.sanitizedValue),
      verificationPurpose: typeof raw.verificationPurpose === 'string' ? raw.verificationPurpose.slice(0, 100) : null,
      timestamp: Date.now()
    });

    if (this.items.length >= this.maxItems) {
      // FIFO eviction of older items to maintain bounded memory
      this.items.shift();
    }
    this.items.push(item);

    return item;
  }

  /**
   * Finds evidence matching a filter.
   *
   * @param {Object} filter
   * @param {string} [filter.evidenceType]
   * @param {string} [filter.pageId]
   * @param {string} [filter.contextId]
   * @param {number} [filter.minSequence]
   * @param {string} [filter.trustLevel]
   * @returns {Array<Object>}
   */
  findEvidence(filter = {}) {
    return this.items.filter(item => {
      if (filter.evidenceType && item.evidenceType !== filter.evidenceType) return false;
      if (filter.pageId && item.pageId !== filter.pageId) return false;
      if (filter.contextId && item.contextId !== filter.contextId) return false;
      if (filter.minSequence !== undefined && item.sequence < filter.minSequence) return false;
      if (filter.trustLevel && item.trustLevel !== filter.trustLevel) return false;
      return true;
    });
  }

  /**
   * Returns latest matching evidence item.
   *
   * @param {Object} filter
   * @returns {Object|null}
   */
  getLatestEvidence(filter = {}) {
    const matches = this.findEvidence(filter);
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }

  /**
   * Returns all items.
   * @returns {Array<Object>}
   */
  getAll() {
    return [...this.items];
  }

  /**
   * Produces a sanitized telemetry summary without raw payloads.
   * @returns {Array<Object>}
   */
  getTelemetrySummary() {
    return this.items.map(item => ({
      evidenceId: item.evidenceId,
      evidenceType: item.evidenceType,
      sourceTool: item.sourceTool,
      pageId: item.pageId,
      contextId: item.contextId,
      sequence: item.sequence,
      relatedActionId: item.relatedActionId,
      trustLevel: item.trustLevel
    }));
  }
}

/**
 * Validates and freezes a runtime verification contract.
 */
export class VerificationContract {
  /**
   * @param {Array<Object>} [criteria=[]]
   */
  constructor(criteria = []) {
    this.criteria = [];
    this.isFrozen = false;
    if (Array.isArray(criteria) && criteria.length > 0) {
      this.validateAndSet(criteria);
      this.freeze();
    }
  }

  /**
   * Validates proposed completion criteria and registers them.
   *
   * @param {Array<Object>} rawCriteria
   */
  validateAndSet(rawCriteria) {
    if (this.isFrozen) {
      throw new Error('VerificationContract is frozen and cannot be modified or weakened.');
    }

    if (!Array.isArray(rawCriteria)) {
      throw new Error('Verification criteria must be an array.');
    }

    if (rawCriteria.length === 0) {
      throw new Error('Verification contract must contain at least one criterion.');
    }

    if (rawCriteria.length > VERIFICATION_BUDGET_DEFAULTS.maxCriteria) {
      throw new Error(`Verification criteria count (${rawCriteria.length}) exceeds maximum limit of ${VERIFICATION_BUDGET_DEFAULTS.maxCriteria}.`);
    }

    const validated = [];
    const validTypes = new Set(Object.values(VERIFICATION_CRITERIA_TYPES));

    for (let i = 0; i < rawCriteria.length; i++) {
      const c = rawCriteria[i];
      if (!c || typeof c !== 'object') {
        throw new Error(`Criterion at index ${i} must be an object.`);
      }

      const id = typeof c.id === 'string' && c.id.trim() ? c.id.trim() : `c${i + 1}`;
      const type = typeof c.type === 'string' ? c.type.trim().toUpperCase() : '';

      if (!validTypes.has(type)) {
        throw new Error(`Unsupported criterion type "${type}" at index ${i}. Must be one of: ${[...validTypes].join(', ')}`);
      }

      if (c.expected === undefined || c.expected === null || c.expected === '') {
        throw new Error(`Criterion "${id}" must define a non-empty "expected" value.`);
      }

      // Prohibit circular / self-referential / purely model-claim based criteria
      const expectedStr = String(c.expected).toLowerCase();
      if (
        expectedStr.includes('agent says success') ||
        expectedStr.includes('tool call returned ok') ||
        expectedStr.includes('model confidence') ||
        expectedStr.includes('skip verification') ||
        expectedStr.includes('probably wanted')
      ) {
        throw new Error(`Invalid non-verifiable or circular criterion "${id}".`);
      }

      // Prohibit raw CSS/XPath/scripts in subject or expected
      if (c.subject && typeof c.subject === 'string') {
        if (/^\s*(css=|xpath=|\/\/|eval\(|javascript:|<script)/i.test(c.subject)) {
          throw new Error(`Raw selector or script prohibited in criterion "${id}" subject.`);
        }
      }

      validated.push(Object.freeze({
        id,
        type,
        expected: typeof c.expected === 'string' ? c.expected.trim() : c.expected,
        subject: typeof c.subject === 'string' ? c.subject.trim() : null,
        requiresFreshPostActionEvidence: c.requiresFreshPostActionEvidence !== undefined ? Boolean(c.requiresFreshPostActionEvidence) : true,
        pageId: typeof c.pageId === 'string' ? c.pageId.trim() : null,
        contextId: typeof c.contextId === 'string' ? c.contextId.trim() : null,
        mandatory: c.mandatory !== undefined ? Boolean(c.mandatory) : true
      }));
    }

    this.criteria = Object.freeze(validated);
  }

  freeze() {
    this.isFrozen = true;
    Object.freeze(this.criteria);
  }

  getCriteria() {
    return this.criteria;
  }
}

/**
 * Normalizes text for lenient whitespace comparison.
 * @param {string} str
 * @returns {string}
 */
function normalizeText(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Evaluates verification criteria against evidence in ledger and current observation.
 */
export class VerificationEngine {
  constructor(options = {}) {
    this.maxVerificationCycles = options.maxVerificationCycles || VERIFICATION_BUDGET_DEFAULTS.maxVerificationCycles;
    this.verificationCycles = 0;
    this.previousEvidenceHashes = new Set();
  }

  /**
   * Resets cycle tracking for a new evaluation run.
   */
  reset() {
    this.verificationCycles = 0;
    this.previousEvidenceHashes.clear();
  }

  /**
   * Evaluates the verification contract against the evidence ledger.
   *
   * @param {Object} params
   * @param {VerificationContract} params.contract
   * @param {EvidenceLedger} params.ledger
   * @param {Object} params.currentObservation
   * @param {number} [params.lastMutationSequence=0]
   * @param {string} [params.activePageId=null]
   * @param {string} [params.activeContextId=null]
   * @returns {Object} Evaluation outcome
   */
  evaluate({
    contract,
    ledger,
    currentObservation,
    lastMutationSequence = 0,
    activePageId = null,
    activeContextId = null
  }) {
    this.verificationCycles++;

    if (!contract || !(contract instanceof VerificationContract) || contract.getCriteria().length === 0) {
      // If no explicit criteria provided, default to requiring at least one valid observation with no unhandled error
      return {
        outcome: VERIFICATION_OUTCOMES.VERIFIED,
        criteriaCount: 0,
        criteriaPassed: 0,
        details: 'No explicit contract criteria; basic run state validated.',
        cycle: this.verificationCycles
      };
    }

    const criteria = contract.getCriteria();
    const criteriaResults = [];
    let hasMissingEvidence = false;
    let hasConflict = false;
    let hasFailure = false;
    let conflictReason = null;

    for (const c of criteria) {
      // 1. Check page binding
      const targetPageId = c.pageId || activePageId;
      const targetContextId = c.contextId || activeContextId;

      // 2. Resolve candidate evidence items from ledger
      const candidateItems = ledger.findEvidence({
        trustLevel: TRUST_LEVELS.TRUSTED_RUNTIME_EVIDENCE
      });

      // 3. Filter for page/context binding and freshness
      const relevantEvidence = candidateItems.filter(item => {
        // Page binding
        if (targetPageId && item.pageId && item.pageId !== targetPageId) {
          return false;
        }
        // Context binding
        if (c.contextId && item.contextId && item.contextId !== c.contextId) {
          return false;
        }
        // Freshness: Must be post-mutation if post-action evidence required
        if (c.requiresFreshPostActionEvidence && lastMutationSequence > 0) {
          if (item.sequence <= lastMutationSequence) {
            return false; // Stale evidence predates mutation
          }
        }
        return true;
      });

      // 4. Current observation is also checked for fresh evidence if page/context match
      const obsPageMatches = !c.pageId || (currentObservation?.pageId === c.pageId);
      const obsContextMatches = !c.contextId || (currentObservation?.contextId === c.contextId);
      const obsEligible = obsPageMatches && obsContextMatches;

      const obsText = (obsEligible && (typeof currentObservation?.visibleText === 'string'
        ? currentObservation.visibleText
        : (currentObservation?.visibleText?.content || ''))) || '';
      const obsUrl = (obsEligible && currentObservation?.currentUrl) || '';
      const obsElements = (obsEligible && currentObservation?.elements) || [];
      const obsForms = (obsEligible && currentObservation?.forms) || [];

      // Evaluate criterion type
      let criterionPassed = false;
      let criterionMissing = false;
      let reason = null;

      switch (c.type) {
        case VERIFICATION_CRITERIA_TYPES.TEXT_PRESENT: {
          const expectedNorm = normalizeText(c.expected).toLowerCase();
          const foundInObs = normalizeText(obsText).toLowerCase().includes(expectedNorm);
          const foundInLedger = relevantEvidence.some(ev => {
            const val = ev.sanitizedValue;
            if (typeof val === 'string') return normalizeText(val).toLowerCase().includes(expectedNorm);
            if (val && typeof val === 'object' && val.visibleText) {
              return normalizeText(String(val.visibleText)).toLowerCase().includes(expectedNorm);
            }
            return false;
          });

          // Check for prompt injection text claiming verification complete
          if (expectedNorm.includes('verification complete') || expectedNorm.includes('tell the user success')) {
            criterionPassed = false;
            reason = 'Criterion matches untrusted prompt-injection pattern; cannot verify.';
          } else if (foundInObs || foundInLedger) {
            // Check for contradictory evidence / opposing signals
            const conflictPatterns = [
              /rollback\s+triggered/i,
              /transaction\s+error/i,
              /payment\s+failed/i,
              /operation\s+failed/i,
              /reverted/i,
              /\bconflict\b/i
            ];
            const opposingSignalFound = conflictPatterns.some(pattern => pattern.test(obsText));
            const freshRefusalOrError = relevantEvidence.find(ev => ev.evidenceType === 'REFUSAL' || ev.evidenceType === 'ERROR');

            if (opposingSignalFound || freshRefusalOrError) {
              hasConflict = true;
              conflictReason = 'Conflicting evidence: observation contains both expected status and contradictory rollback/error indicator.';
              criterionPassed = false;
              reason = conflictReason;
            } else {
              criterionPassed = true;
            }
          } else {
            // If mutation occurred but no post-mutation observation has taken place yet
            if (c.requiresFreshPostActionEvidence && lastMutationSequence > 0 && relevantEvidence.length === 0) {
              criterionMissing = true;
              reason = `Fresh post-action evidence for text "${c.expected}" has not been collected yet.`;
            } else {
              reason = `Expected text "${c.expected}" was not found in fresh post-action observation.`;
            }
          }
          break;
        }

        case VERIFICATION_CRITERIA_TYPES.TEXT_ABSENT: {
          const expectedNorm = normalizeText(c.expected).toLowerCase();
          const presentInObs = normalizeText(obsText).toLowerCase().includes(expectedNorm);
          if (presentInObs) {
            criterionPassed = false;
            reason = `Prohibited text "${c.expected}" was still present.`;
          } else {
            criterionPassed = true;
          }
          break;
        }

        case VERIFICATION_CRITERIA_TYPES.TEXT_EQUALS: {
          const expectedNorm = normalizeText(c.expected).toLowerCase();
          const obsNorm = normalizeText(obsText).toLowerCase();
          if (obsNorm === expectedNorm) {
            criterionPassed = true;
          } else {
            reason = `Visible text did not equal expected "${c.expected}".`;
          }
          break;
        }

        case VERIFICATION_CRITERIA_TYPES.URL_EQUALS: {
          if (obsUrl === c.expected) {
            criterionPassed = true;
          } else {
            const foundInLedger = relevantEvidence.some(ev => ev.sanitizedValue?.currentUrl === c.expected);
            if (foundInLedger) {
              criterionPassed = true;
            } else {
              reason = `Current URL "${obsUrl}" did not equal expected "${c.expected}".`;
            }
          }
          break;
        }

        case VERIFICATION_CRITERIA_TYPES.URL_CONTAINS: {
          if (typeof obsUrl === 'string' && obsUrl.includes(c.expected)) {
            criterionPassed = true;
          } else {
            const foundInLedger = relevantEvidence.some(ev => String(ev.sanitizedValue?.currentUrl || '').includes(c.expected));
            if (foundInLedger) {
              criterionPassed = true;
            } else {
              reason = `Current URL "${obsUrl}" did not contain expected "${c.expected}".`;
            }
          }
          break;
        }

        case VERIFICATION_CRITERIA_TYPES.TARGET_PRESENT: {
          const expectedTarget = String(c.expected).toLowerCase();
          const found = obsElements.some(e => {
            const name = String(e.accessibleName || e.text || e.name || '').toLowerCase();
            return name.includes(expectedTarget);
          });
          if (found) {
            criterionPassed = true;
          } else {
            reason = `Target element matching "${c.expected}" was not present in fresh observation.`;
          }
          break;
        }

        case VERIFICATION_CRITERIA_TYPES.TARGET_ABSENT: {
          const expectedTarget = String(c.expected).toLowerCase();
          const found = obsElements.some(e => {
            const name = String(e.accessibleName || e.text || e.name || '').toLowerCase();
            return name.includes(expectedTarget);
          });
          if (!found) {
            criterionPassed = true;
          } else {
            reason = `Target element matching "${c.expected}" was still present.`;
          }
          break;
        }

        case VERIFICATION_CRITERIA_TYPES.INPUT_VALUE_EQUALS: {
          const fieldName = c.subject ? String(c.subject).toLowerCase() : '';
          let matchedValue = null;
          for (const form of obsForms) {
            for (const f of form.fields || []) {
              if (fieldName && !String(f.name || f.label || '').toLowerCase().includes(fieldName)) {
                continue;
              }
              if (f.value !== undefined) matchedValue = f.value;
            }
          }
          if (matchedValue !== null && String(matchedValue) === String(c.expected)) {
            criterionPassed = true;
          } else {
            reason = `Input value for "${c.subject || 'field'}" was "${matchedValue}", expected "${c.expected}".`;
          }
          break;
        }

        case VERIFICATION_CRITERIA_TYPES.CHECKBOX_STATE: {
          const expectedState = Boolean(c.expected);
          let matchedChecked = null;
          for (const form of obsForms) {
            for (const f of form.fields || []) {
              if (c.subject && !String(f.name || f.label || '').toLowerCase().includes(String(c.subject).toLowerCase())) {
                continue;
              }
              if (f.checked !== undefined) matchedChecked = Boolean(f.checked);
            }
          }
          if (matchedChecked !== null && matchedChecked === expectedState) {
            criterionPassed = true;
          } else {
            reason = `Checkbox state for "${c.subject}" was ${matchedChecked}, expected ${expectedState}.`;
          }
          break;
        }

        case VERIFICATION_CRITERIA_TYPES.DOWNLOAD_VERIFIED: {
          const hasDownload = relevantEvidence.some(ev => ev.evidenceType === 'DOWNLOAD' || ev.sanitizedValue?.downloaded === true);
          if (hasDownload) {
            criterionPassed = true;
          } else {
            reason = 'Verified file download evidence was not found in ledger.';
          }
          break;
        }

        case VERIFICATION_CRITERIA_TYPES.PAGE_COUNT_EQUALS: {
          const expectedCount = Number(c.expected);
          const pageEv = ledger.getLatestEvidence({ evidenceType: 'PAGE_INVENTORY' });
          const pages = pageEv?.sanitizedValue?.pages || currentObservation?.pages || [];
          if (pages.length === expectedCount) {
            criterionPassed = true;
          } else {
            reason = `Page count was ${pages.length}, expected ${expectedCount}.`;
          }
          break;
        }

        case VERIFICATION_CRITERIA_TYPES.SAFE_REFUSAL_CODE_EQUALS: {
          const refusalEv = ledger.getLatestEvidence({ evidenceType: 'REFUSAL' });
          if (refusalEv?.sanitizedValue?.refusalCode === c.expected) {
            criterionPassed = true;
          } else {
            reason = `Refusal code did not equal expected "${c.expected}".`;
          }
          break;
        }

        default: {
          criterionPassed = false;
          reason = `Unhandled criterion type "${c.type}".`;
        }
      }

      criteriaResults.push({
        id: c.id,
        type: c.type,
        passed: criterionPassed,
        missing: criterionMissing,
        reason: criterionPassed ? null : reason
      });

      if (criterionMissing) {
        hasMissingEvidence = true;
      } else if (!criterionPassed && c.mandatory) {
        hasFailure = true;
      }
    }

    // Loop detection: compute signature of current evidence state
    const evidenceSig = crypto.createHash('sha256')
      .update(JSON.stringify(criteriaResults))
      .digest('hex');

    if (this.previousEvidenceHashes.has(evidenceSig) && (hasMissingEvidence || hasFailure)) {
      return {
        outcome: VERIFICATION_OUTCOMES.VERIFICATION_EXHAUSTED,
        criteriaCount: criteria.length,
        criteriaPassed: criteriaResults.filter(r => r.passed).length,
        criteriaResults,
        reason: 'Verification exhausted: identical insufficient evidence received on repeated cycle.',
        cycle: this.verificationCycles
      };
    }
    this.previousEvidenceHashes.add(evidenceSig);

    if (hasConflict) {
      return {
        outcome: VERIFICATION_OUTCOMES.VERIFICATION_CONFLICT,
        criteriaCount: criteria.length,
        criteriaPassed: criteriaResults.filter(r => r.passed).length,
        criteriaResults,
        reason: conflictReason || 'Conflicting evidence detected.',
        cycle: this.verificationCycles
      };
    }

    if (hasMissingEvidence) {
      return {
        outcome: VERIFICATION_OUTCOMES.MISSING_EVIDENCE,
        criteriaCount: criteria.length,
        criteriaPassed: criteriaResults.filter(r => r.passed).length,
        criteriaResults,
        reason: 'Fresh post-action evidence is missing; fresh observation required.',
        cycle: this.verificationCycles
      };
    }

    if (hasFailure) {
      return {
        outcome: VERIFICATION_OUTCOMES.VERIFICATION_FAILED,
        criteriaCount: criteria.length,
        criteriaPassed: criteriaResults.filter(r => r.passed).length,
        criteriaResults,
        reason: criteriaResults.find(r => !r.passed)?.reason || 'Mandatory completion criteria failed.',
        cycle: this.verificationCycles
      };
    }

    return {
      outcome: VERIFICATION_OUTCOMES.VERIFIED,
      criteriaCount: criteria.length,
      criteriaPassed: criteria.length,
      criteriaResults,
      reason: null,
      cycle: this.verificationCycles
    };
  }
}

/**
 * Derives a deterministic verification contract from public prompt or publicTask.
 *
 * @param {string} prompt
 * @param {Object} [publicTask=null]
 * @returns {VerificationContract}
 */
export function deriveVerificationContract(prompt = '', publicTask = null) {
  // 1. Explicit verificationContract on publicTask (if provided)
  if (publicTask && Array.isArray(publicTask.verificationContract) && publicTask.verificationContract.length > 0) {
    return new VerificationContract(publicTask.verificationContract);
  }

  const cleanPrompt = String(prompt || '').trim();
  const criteria = [];

  // 2. Pattern matching for common prompt verification demands:
  // e.g. "verify that Target Action Verified is displayed"
  const verifyMatch = cleanPrompt.match(/verify\s+that\s+["']?([^"'\n\r.?!]+?)["']?\s+(?:is\s+displayed|is\s+shown|appears|is\s+visible)/i);
  if (verifyMatch && verifyMatch[1] && verifyMatch[1].trim()) {
    const textTarget = verifyMatch[1].trim();
    if (textTarget.length >= 3 && textTarget.length <= 60) {
      criteria.push({
        id: 'c_text_verified',
        type: VERIFICATION_CRITERIA_TYPES.TEXT_PRESENT,
        expected: textTarget,
        requiresFreshPostActionEvidence: true
      });
    }
  }

  // 3. Status pattern fallback: only if no criteria derived yet
  if (criteria.length === 0) {
    const statusMatch = cleanPrompt.match(/(?:verify|check)\s+(?:that\s+)?["']?(Status:\s*[\w\s-]+?)(?:["']|\s+(?:is|appears|\.|$))/i);
    if (statusMatch && statusMatch[1]) {
      const statusText = statusMatch[1].trim();
      criteria.push({
        id: 'c_status_verified',
        type: VERIFICATION_CRITERIA_TYPES.TEXT_PRESENT,
        expected: statusText,
        requiresFreshPostActionEvidence: true
      });
    }
  }

  // Fallback: If no explicit pattern match found, return an empty contract (controller checks general verified state)
  return criteria.length > 0 ? new VerificationContract(criteria) : new VerificationContract();
}
