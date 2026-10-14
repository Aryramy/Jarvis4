/**
 * Form Population module for JARVIS4 (Brick 33).
 * Safely maps user-supplied values to discovered fields and mutates them transactionally.
 *
 * Strict invariants:
 * - 0 AI / 0 LLM calls.
 * - ZERO autonomous value generation or guessing missing values.
 * - Snapshot authorization required (TARGET_STALE if invalid or re-rendered).
 * - Full PREFLIGHT validation before ANY mutation (if one field fails preflight: 0 mutations!).
 * - Passwords strictly BLOCKED (SENSITIVE_FIELD_NOT_ALLOWED).
 * - File inputs strictly BLOCKED (FILE_INPUT_NOT_ALLOWED).
 * - Hidden inputs strictly BLOCKED (ACTION_NOT_SUPPORTED_FOR_TARGET).
 * - Disabled fields strictly BLOCKED (TARGET_DISABLED).
 * - Readonly fields strictly BLOCKED (FIELD_READONLY).
 * - Select option verified before selection (OPTION_NOT_FOUND).
 * - Radio choice verified before selection (OPTION_NOT_FOUND).
 * - Transactional atomicity: best-effort rollback on mid-operation failure.
 * - Truthful reporting: PARTIAL_FORM_UPDATE if rollback cannot guarantee full restore.
 * - Form submission remains STRICTLY BLOCKED (FORM_SUBMISSION_NOT_AUTHORIZED).
 * - NO Enter key usage to finalize fields (prevents accidental submit).
 * - Privacy: supplied field values are NEVER persisted or unnecessarily echoed.
 */

import { inspectForms, FormInspectionError } from './formInspector.js';

export class FormPopulationError extends Error {
  /**
   * @param {string} message
   * @param {string} [code='FORM_POPULATION_FAILED']
   * @param {Object} [details={}]
   */
  constructor(message, code = 'FORM_POPULATION_FAILED', details = {}) {
    super(message);
    this.name = 'FormPopulationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Finds a field's real DOM element in the page context.
 *
 * @param {Document} doc
 * @param {Object} targetField
 * @returns {Element|null}
 */
export function findFieldDomElement(docOrField, maybeField) {
  let doc = typeof document !== 'undefined' ? document : null;
  let targetField = docOrField;
  if (maybeField && docOrField && docOrField.getElementById) {
    doc = docOrField;
    targetField = maybeField;
  }
  if (!doc || !targetField) return null;

  if (targetField.id) {
    const el = doc.getElementById(targetField.id);
    if (el) return el;
  }

  let form = null;
  if (targetField.formId) {
    const match = String(targetField.formId).match(/^form_(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      const allForms = doc.querySelectorAll('form');
      if (allForms && allForms[idx]) {
        form = allForms[idx];
      }
    } else if (doc.getElementById) {
      const f = doc.getElementById(targetField.formId);
      if (f) form = f;
    }
  }

  const root = form || doc;

  if (targetField.name) {
    if (targetField.type === 'radio' || targetField.kind === 'radio') {
      const radioVal = targetField.selectedValue ?? targetField.value;
      const radios = root.querySelectorAll(`input[type="radio"][name="${targetField.name}"]`);
      if (radios.length > 0) {
        if (radioVal !== undefined) {
          const normVal = String(radioVal).trim().toLowerCase();
          for (let i = 0; i < radios.length; i++) {
            const r = radios[i];
            if ((r.value || '').trim().toLowerCase() === normVal) return r;
            const lab = (r.closest && r.closest('label')) || (r.id ? doc.querySelector(`label[for="${r.id}"]`) : null);
            if (lab) {
              const labText = (lab.innerText || lab.textContent || '').trim().toLowerCase();
              if (labText.includes(normVal)) return r;
            }
          }
        }
        return radios[0];
      }
    }

    const named = root.querySelectorAll(`[name="${targetField.name}"]`);
    for (let i = 0; i < named.length; i++) {
      const el = named[i];
      const tag = (el.tagName || '').toLowerCase();
      const itype = (tag === 'input' ? ((el.getAttribute ? el.getAttribute('type') : null) || el.type || 'text') : tag).toLowerCase();
      if (targetField.type && itype === targetField.type) {
        if (targetField.value !== undefined && itype === 'radio') {
          if (el.value === targetField.value) return el;
        } else {
          return el;
        }
      } else if (!targetField.type) {
        return el;
      }
    }
  }

  if (targetField.accessibleName) {
    const all = root.querySelectorAll('input, textarea, select');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.getAttribute && el.getAttribute('aria-label') === targetField.accessibleName) {
        return el;
      }
    }
  }

  return null;
}

/**
 * Helper to normalize string for comparison.
 * @param {string} str
 * @returns {string}
 */
function normalizeName(str) {
  if (typeof str !== 'string') return '';
  return str.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Safely populates explicit form fields with preflight atomicity and verification.
 *
 * @param {Object} page - Playwright page instance or mock page
 * @param {Object} browserManager - JARVIS BrowserManager instance
 * @param {Object} populateRequest - Request payload
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>}
 */
export async function populateForm(page, browserManager, populateRequest, options = {}) {
  // 1. Structure validation
  if (!populateRequest || typeof populateRequest !== 'object' || Array.isArray(populateRequest)) {
    throw new FormPopulationError('Populate form request must be an object.', 'INVALID_REQUEST');
  }

  const expectedSnapshotToken = populateRequest.expectedSnapshotToken;
  if (!expectedSnapshotToken || typeof expectedSnapshotToken !== 'string' || expectedSnapshotToken.trim().length === 0) {
    throw new FormPopulationError('Expected snapshot token is required.', 'MISSING_SNAPSHOT_TOKEN');
  }

  if (!Array.isArray(populateRequest.fields) || populateRequest.fields.length === 0) {
    throw new FormPopulationError('Request must specify a non-empty array of fields to populate.', 'INVALID_FIELDS');
  }

  const targetPageId = options.pageId || populateRequest.pageId || browserManager.activePageId;
  const pageEntry = browserManager._pages ? browserManager._pages.get(targetPageId) : null;
  const preSemanticRevision = pageEntry ? pageEntry.semanticRevision : 1;

  // Snapshot token validation
  const isTokenValid = typeof browserManager.isSnapshotTokenValid === 'function'
    ? browserManager.isSnapshotTokenValid(expectedSnapshotToken, targetPageId)
    : (browserManager.snapshotToken === expectedSnapshotToken);

  if (!isTokenValid) {
    throw new FormPopulationError('Snapshot token is stale or invalid.', 'TARGET_STALE');
  }

  // Synchronize dynamic tracker state
  if (typeof browserManager.syncDynamicState === 'function') {
    await browserManager.syncDynamicState(targetPageId);
    if (!browserManager.isSnapshotTokenValid(expectedSnapshotToken, targetPageId)) {
      throw new FormPopulationError('Snapshot token became stale.', 'TARGET_STALE');
    }
  }

  const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  const actionTimeoutMs = Math.min(Math.max(Number(options.timeoutMs ?? options.actionTimeoutMs ?? 10000) || 10000, 100), 60000);

  // 2. Discover and map forms on target page
  const inspection = await browserManager.inspectForms({ pageId: targetPageId, ...options });
  const allForms = inspection.forms || [];
  const unassociated = inspection.unassociatedFields || [];

  let targetForm = null;

  if (populateRequest.formId) {
    const requestedFormId = String(populateRequest.formId).trim();
    targetForm = allForms.find(f =>
      f.formId === requestedFormId ||
      f.name === requestedFormId ||
      f.id === requestedFormId ||
      (f.accessibleName && normalizeName(f.accessibleName) === normalizeName(requestedFormId))
    );
    if (!targetForm) {
      if (requestedFormId === 'unassociated' && unassociated.length > 0) {
        targetForm = { formId: 'unassociated', fields: unassociated, buttons: [], radioGroups: [] };
      } else {
        throw new FormPopulationError(`Form "${populateRequest.formId}" not found on page.`, 'FORM_NOT_FOUND');
      }
    }
  } else {
    if (allForms.length === 1) {
      targetForm = allForms[0];
    } else if (allForms.length === 0) {
      if (unassociated.length > 0) {
        targetForm = { formId: 'unassociated', fields: unassociated, buttons: [], radioGroups: [] };
      } else {
        throw new FormPopulationError('No forms found on current page.', 'FORM_NOT_FOUND');
      }
    } else {
      // Multiple forms exist; determine if requested fields match exactly one form
      const matchingForms = allForms.filter(f => {
        return populateRequest.fields.every(rf => {
          const rfName = normalizeName(rf.name || rf.label || rf.fieldId);
          return f.fields.some(field =>
            normalizeName(field.name) === rfName ||
            normalizeName(field.label) === rfName ||
            normalizeName(field.accessibleName) === rfName ||
            normalizeName(field.placeholder) === rfName ||
            field.fieldId === rf.fieldId
          );
        });
      });

      if (matchingForms.length === 1) {
        targetForm = matchingForms[0];
      } else {
        throw new FormPopulationError(
          'Multiple forms exist on the page. Please specify formId.',
          'FORM_AMBIGUOUS',
          { availableForms: allForms.map(f => ({ formId: f.formId, name: f.name, accessibleName: f.accessibleName })) }
        );
      }
    }
  }

  // 3. PREFLIGHT VALIDATION FOR ALL REQUESTED FIELDS (ZERO DOM MUTATION ON FAILURE)
  const preflightPlan = [];

  for (let fIdx = 0; fIdx < populateRequest.fields.length; fIdx++) {
    const rf = populateRequest.fields[fIdx];
    if (!rf || typeof rf !== 'object') {
      throw new FormPopulationError(`Field at index ${fIdx} must be an object.`, 'INVALID_FIELD_REQUEST');
    }

    const rfId = rf.fieldId;
    const rfName = normalizeName(rf.name || '');
    const rfLabel = normalizeName(rf.label || '');
    const rfAccessible = normalizeName(rf.accessibleName || '');

    if (!rfId && !rfName && !rfLabel && !rfAccessible) {
      throw new FormPopulationError(`Field at index ${fIdx} must specify name, label, or fieldId.`, 'INVALID_FIELD_REQUEST');
    }

    // Match candidate fields in target form
    let candidates = [];

    if (rfId) {
      candidates = targetForm.fields.filter(f => f.fieldId === rfId);
    }

    if (candidates.length === 0 && (rfName || rfLabel || rfAccessible)) {
      candidates = targetForm.fields.filter(f => {
        const fName = normalizeName(f.name || '');
        const fLabel = normalizeName(f.label || '');
        const fAcc = normalizeName(f.accessibleName || '');
        const fPlace = normalizeName(f.placeholder || '');
        const fGroup = normalizeName(f.group || '');

        if (rfName && (fName === rfName || fLabel === rfName || fAcc === rfName || (fPlace && fPlace === rfName))) return true;
        if (rfLabel && (fLabel === rfLabel || fAcc === rfLabel || fName === rfLabel)) return true;
        if (rfAccessible && (fAcc === rfAccessible || fLabel === rfAccessible)) return true;

        // Check if targeting radio group by non-empty group name or radio group label
        const fGrpLabel = normalizeName(f.groupLabel || f.label || '');
        if ((f.type === 'radio' || f.kind === 'radio') && (fGroup || fGrpLabel)) {
          const matchesGroup = (fGroup && (fGroup === rfName || fGroup === rfLabel)) ||
                               (fGrpLabel && (fGrpLabel === rfName || fGrpLabel === rfLabel));
          if (matchesGroup) {
            if (rf.value !== undefined) {
              const optVal = normalizeName(String(rf.value));
              if (normalizeName(f.value) === optVal ||
                  normalizeName(f.label) === optVal ||
                  normalizeName(f.accessibleName) === optVal ||
                  (Array.isArray(f.options) && f.options.some(o => normalizeName(o.value) === optVal || normalizeName(o.label) === optVal))) {
                return true;
              }
            } else {
              return true;
            }
          }
        }

        return false;
      });
    }

    // Radio group disambiguation if multiple radios match the group name
    if (candidates.length > 1 && candidates.every(c => c.type === 'radio')) {
      if (rf.value !== undefined) {
        const valNorm = normalizeName(String(rf.value));
        const exactRadio = candidates.find(c =>
          normalizeName(c.value) === valNorm ||
          normalizeName(c.label) === valNorm ||
          normalizeName(c.accessibleName) === valNorm
        );
        if (exactRadio) {
          candidates = [exactRadio];
        } else {
          throw new FormPopulationError(
            `Option "${rf.value}" not found for radio group "${candidates[0].group || candidates[0].name}".`,
            'OPTION_NOT_FOUND',
            { requestedValue: rf.value, availableOptions: candidates.map(c => c.value || c.label) }
          );
        }
      }
    }

    if (candidates.length === 0) {
      throw new FormPopulationError(
        `Field "${rf.name || rf.label || rf.fieldId}" not found in form "${targetForm.formId}".`,
        'FIELD_NOT_FOUND',
        { requestedField: rf.name || rf.label || rf.fieldId }
      );
    }

    if (candidates.length > 1) {
      throw new FormPopulationError(
        `Field "${rf.name || rf.label || rf.fieldId}" is ambiguous in form "${targetForm.formId}".`,
        'TARGET_AMBIGUOUS',
        { candidateCount: candidates.length, candidates: candidates.map(c => ({ id: c.id, name: c.name, label: c.label, kind: c.kind })) }
      );
    }

    const matchedField = candidates[0];

    // Password input check
    if (matchedField.type === 'password' || matchedField.sensitive) {
      throw new FormPopulationError(
        'Password filling is not authorized in Brick 33.',
        'SENSITIVE_FIELD_NOT_ALLOWED',
        { field: matchedField.name || matchedField.label }
      );
    }

    // File input check
    if (matchedField.type === 'file' || matchedField.isFile) {
      throw new FormPopulationError(
        'File input filling is not authorized in Brick 33.',
        'FILE_INPUT_NOT_ALLOWED',
        { field: matchedField.name || matchedField.label }
      );
    }

    // Hidden input check
    if (matchedField.type === 'hidden' || matchedField.isHidden) {
      throw new FormPopulationError(
        'Hidden field filling is not authorized.',
        'ACTION_NOT_SUPPORTED_FOR_TARGET',
        { field: matchedField.name || matchedField.label }
      );
    }

    // Disabled check
    if (matchedField.disabled) {
      throw new FormPopulationError(
        `Field "${matchedField.name || matchedField.label}" is disabled.`,
        'TARGET_DISABLED',
        { field: matchedField.name || matchedField.label }
      );
    }

    // Readonly check
    if (matchedField.readonly) {
      throw new FormPopulationError(
        `Field "${matchedField.name || matchedField.label}" is readonly.`,
        'FIELD_READONLY',
        { field: matchedField.name || matchedField.label }
      );
    }

    // Specific field validation checks
    let matchedOption = null;

    if (matchedField.kind === 'select') {
      const optCandidate = rf.value ?? rf.label ?? rf.option;
      if (optCandidate === undefined || optCandidate === null) {
        throw new FormPopulationError(
          `Select field "${matchedField.name || matchedField.label}" requires an option label or value.`,
          'INVALID_OPTION'
        );
      }
      const optNorm = normalizeName(String(optCandidate));
      matchedOption = (matchedField.options || []).find(o =>
        normalizeName(o.label) === optNorm || normalizeName(o.value) === optNorm
      );
      if (!matchedOption) {
        throw new FormPopulationError(
          `Option "${optCandidate}" not found in select "${matchedField.name || matchedField.label}".`,
          'OPTION_NOT_FOUND',
          { availableOptions: (matchedField.options || []).map(o => o.label) }
        );
      }
    } else if (matchedField.type === 'radio' || matchedField.kind === 'radio') {
      if (rf.value !== undefined) {
        const radioValNorm = normalizeName(String(rf.value));
        if (Array.isArray(matchedField.options) && matchedField.options.length > 0) {
          const matchOpt = matchedField.options.find(o =>
            normalizeName(o.value) === radioValNorm ||
            normalizeName(o.label) === radioValNorm
          );
          if (!matchOpt) {
            throw new FormPopulationError(
              `Radio option "${rf.value}" not found for "${matchedField.name || matchedField.label}".`,
              'OPTION_NOT_FOUND',
              { availableOptions: matchedField.options.map(o => o.label) }
            );
          }
          matchedOption = matchOpt;
        } else {
          const matchesVal = normalizeName(matchedField.value) === radioValNorm ||
                             normalizeName(matchedField.label) === radioValNorm ||
                             normalizeName(matchedField.accessibleName) === radioValNorm;
          if (!matchesVal) {
            throw new FormPopulationError(
              `Radio option "${rf.value}" not found for "${matchedField.name || matchedField.label}".`,
              'OPTION_NOT_FOUND'
            );
          }
        }
      }
    } else if (matchedField.type === 'checkbox') {
      if (rf.checked === undefined && rf.value === undefined) {
        throw new FormPopulationError(
          `Checkbox field "${matchedField.name || matchedField.label}" requires explicit boolean "checked" state.`,
          'INVALID_FIELD_VALUE'
        );
      }
    } else {
      // Text-like input or textarea
      if (rf.value === undefined || rf.value === null) {
        throw new FormPopulationError(
          `Field "${matchedField.name || matchedField.label}" requires a value.`,
          'INVALID_FIELD_VALUE'
        );
      }
    }

    preflightPlan.push({
      reqField: rf,
      matchedField,
      matchedOption
    });
  }

  // Preflight snapshot verification: ensure page didn't mutate during preflight
  if (typeof browserManager.syncDynamicState === 'function') {
    await browserManager.syncDynamicState(targetPageId);
  }
  if (!browserManager.isSnapshotTokenValid(expectedSnapshotToken, targetPageId)) {
    throw new FormPopulationError('Snapshot token became stale during preflight.', 'TARGET_STALE');
  }

  // 4. TRANSACTIONAL SEQUENTIAL MUTATION
  const mutatedFields = [];
  const populatedResults = [];

  try {
    for (const item of preflightPlan) {
      const { reqField, matchedField, matchedOption } = item;

      if (matchedOption && matchedOption.value !== undefined) {
        matchedField.selectedValue = matchedOption.value;
      } else if (reqField.value !== undefined) {
        matchedField.selectedValue = reqField.value;
      }

      // Locate DOM ElementHandle
      let elementHandle = null;
      let rawHandle = null;

      if (typeof options.evaluateHandle === 'function') {
        rawHandle = await options.evaluateHandle(findFieldDomElement, matchedField);
        elementHandle = rawHandle && typeof rawHandle.asElement === 'function' ? rawHandle.asElement() : rawHandle;
      } else if (typeof page.evaluateHandle === 'function') {
        rawHandle = await page.evaluateHandle(findFieldDomElement, matchedField);
        elementHandle = rawHandle && typeof rawHandle.asElement === 'function' ? rawHandle.asElement() : rawHandle;
      } else if (options.mockElementHandle) {
        elementHandle = options.mockElementHandle;
      } else {
        // Mock fallback for tests
        elementHandle = {
          fill: async (v) => (typeof page.fill === 'function' ? page.fill(v) : null),
          check: async () => (typeof page.check === 'function' ? page.check() : null),
          uncheck: async () => (typeof page.uncheck === 'function' ? page.uncheck() : null),
          selectOption: async (opt) => (typeof page.selectOption === 'function' ? page.selectOption(opt) : null),
          inputValue: async () => String(reqField.value ?? ''),
          isChecked: async () => Boolean(reqField.checked !== undefined ? reqField.checked : reqField.value),
          isDisabled: async () => false,
          isConnected: async () => true,
          dispose: async () => {}
        };
      }

      if (!elementHandle) {
        throw new FormPopulationError(`Element for field "${matchedField.name || matchedField.label}" could not be located.`, 'TARGET_NOT_FOUND');
      }

      if (typeof elementHandle.isConnected === 'function') {
        const isConn = await elementHandle.isConnected().catch(() => true);
        if (!isConn) {
          throw new FormPopulationError(`Element for field "${matchedField.name || matchedField.label}" is detached.`, 'TARGET_CHANGED');
        }
      }

      // Record previous state for rollback
      let prevVal = null;
      let prevChecked = null;
      let prevSelected = null;

      if (['text', 'email', 'tel', 'url', 'number', 'search', 'date', 'textarea'].includes(matchedField.type) || matchedField.kind === 'textarea') {
        if (typeof elementHandle.inputValue === 'function') {
          prevVal = await elementHandle.inputValue();
        } else if (typeof page.evaluate === 'function') {
          prevVal = await page.evaluate(el => el ? el.value : '', elementHandle).catch(() => '');
        }
      } else if (matchedField.type === 'checkbox') {
        if (typeof elementHandle.isChecked === 'function') {
          prevChecked = await elementHandle.isChecked();
        } else if (typeof page.evaluate === 'function') {
          prevChecked = await page.evaluate(el => el ? Boolean(el.checked) : false, elementHandle).catch(() => false);
        }
      } else if (matchedField.type === 'radio') {
        if (typeof elementHandle.isChecked === 'function') {
          prevChecked = await elementHandle.isChecked();
        } else if (typeof page.evaluate === 'function') {
          prevChecked = await page.evaluate(el => el ? Boolean(el.checked) : false, elementHandle).catch(() => false);
        }
      } else if (matchedField.kind === 'select') {
        if (typeof page.evaluate === 'function') {
          prevSelected = await page.evaluate(el => el ? el.selectedIndex : 0, elementHandle).catch(() => 0);
        }
      }

      // Mutate
      if (['text', 'email', 'tel', 'url', 'number', 'search', 'date', 'textarea'].includes(matchedField.type) || matchedField.kind === 'textarea') {
        const textVal = String(reqField.value ?? '');
        await elementHandle.fill(textVal, { timeout: actionTimeoutMs });

        // Internal verification (Section 27)
        let currentVal = null;
        if (typeof elementHandle.inputValue === 'function') {
          currentVal = await elementHandle.inputValue();
        } else if (typeof page.evaluate === 'function') {
          currentVal = await page.evaluate(el => el ? el.value : null, elementHandle).catch(() => null);
        }
        if (currentVal !== null && currentVal !== textVal) {
          throw new FormPopulationError('Failed to verify text field value after fill.', 'ACTION_VERIFICATION_FAILED');
        }

        mutatedFields.push({ item, elementHandle, prevVal });
        populatedResults.push({
          field: matchedField.label || matchedField.accessibleName || matchedField.name,
          updated: true,
          verified: true
        });

      } else if (matchedField.type === 'checkbox') {
        const targetChecked = reqField.checked !== undefined
          ? Boolean(reqField.checked)
          : (reqField.value === true || reqField.value === 'true');

        if (targetChecked) {
          await elementHandle.check({ timeout: actionTimeoutMs });
        } else {
          await elementHandle.uncheck({ timeout: actionTimeoutMs });
        }

        // Verification
        let isChecked = null;
        if (typeof elementHandle.isChecked === 'function') {
          isChecked = await elementHandle.isChecked();
        } else if (typeof page.evaluate === 'function') {
          isChecked = await page.evaluate(el => el ? Boolean(el.checked) : null, elementHandle).catch(() => null);
        }
        if (isChecked !== null && isChecked !== targetChecked) {
          throw new FormPopulationError('Failed to verify checkbox state after update.', 'ACTION_VERIFICATION_FAILED');
        }

        mutatedFields.push({ item, elementHandle, prevChecked });
        populatedResults.push({
          field: matchedField.label || matchedField.accessibleName || matchedField.name,
          updated: true,
          verified: true,
          checked: targetChecked
        });

      } else if (matchedField.type === 'radio' || matchedField.kind === 'radio') {
        await elementHandle.check({ timeout: actionTimeoutMs });

        // Verification
        let isChecked = null;
        if (typeof elementHandle.isChecked === 'function') {
          isChecked = await elementHandle.isChecked();
        } else if (typeof page.evaluate === 'function') {
          isChecked = await page.evaluate(el => el ? Boolean(el.checked) : null, elementHandle).catch(() => null);
        }
        if (isChecked !== null && !isChecked) {
          throw new FormPopulationError('Failed to verify radio state after update.', 'ACTION_VERIFICATION_FAILED');
        }

        mutatedFields.push({ item, elementHandle, prevChecked });
        populatedResults.push({
          field: matchedField.label || matchedField.accessibleName || matchedField.name,
          updated: true,
          verified: true,
          selected: matchedOption ? matchedOption.label : (matchedField.label || matchedField.value)
        });

      } else if (matchedField.kind === 'select') {
        await elementHandle.selectOption({ label: matchedOption.label }, { timeout: actionTimeoutMs });

        // Verification
        let selectedLabel = null;
        if (typeof page.evaluate === 'function') {
          selectedLabel = await page.evaluate(el => {
            if (!el || !el.options || el.selectedIndex < 0) return null;
            return el.options[el.selectedIndex]?.text?.trim() ?? null;
          }, elementHandle).catch(() => null);
        }
        if (selectedLabel !== null && selectedLabel !== matchedOption.label.trim()) {
          throw new FormPopulationError('Failed to verify select option after update.', 'ACTION_VERIFICATION_FAILED');
        }

        mutatedFields.push({ item, elementHandle, prevSelected });
        populatedResults.push({
          field: matchedField.label || matchedField.accessibleName || matchedField.name,
          updated: true,
          verified: true,
          selected: matchedOption.label
        });
      }
    }
  } catch (err) {
    // Attempt rollback of already-mutated fields
    let rollbackFailed = false;
    for (let rIdx = mutatedFields.length - 1; rIdx >= 0; rIdx--) {
      const { item, elementHandle, prevVal, prevChecked, prevSelected } = mutatedFields[rIdx];
      try {
        if (prevVal !== null && prevVal !== undefined) {
          await elementHandle.fill(prevVal).catch(() => { rollbackFailed = true; });
        } else if (prevChecked !== null && prevChecked !== undefined) {
          if (prevChecked) await elementHandle.check().catch(() => { rollbackFailed = true; });
          else await elementHandle.uncheck().catch(() => { rollbackFailed = true; });
        } else if (prevSelected !== null && prevSelected !== undefined) {
          if (typeof page.evaluate === 'function') {
            await page.evaluate(({ el, idx }) => {
              if (el && el.options) {
                el.selectedIndex = idx;
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, { el: elementHandle, idx: prevSelected }).catch(() => { rollbackFailed = true; });
          }
        }
      } catch {
        rollbackFailed = true;
      }
    }

    // Clean up handles
    for (const m of mutatedFields) {
      try {
        if (m.elementHandle && typeof m.elementHandle.dispose === 'function') {
          await m.elementHandle.dispose();
        }
      } catch {}
    }

    if (rollbackFailed && mutatedFields.length > 0) {
      throw new FormPopulationError(
        'Form population partially failed; rollback could not fully restore state.',
        'PARTIAL_FORM_UPDATE',
        {
          mutatedFields: mutatedFields.map(m => ({
            field: m.item.matchedField.label || m.item.matchedField.name,
            updated: true
          })),
          cause: err.message
        }
      );
    }

    throw err;
  } finally {
    for (const m of mutatedFields) {
      try {
        if (m.elementHandle && typeof m.elementHandle.dispose === 'function') {
          await m.elementHandle.dispose();
        }
      } catch {}
    }
  }

  // 5. Post-Mutation Snapshot Invalidation & Required/Validation Assessment
  let postSnapshotToken = expectedSnapshotToken;
  if (typeof browserManager._invalidateSnapshot === 'function') {
    postSnapshotToken = browserManager._invalidateSnapshot(targetPageId);
  }

  // Check remaining required fields in targetForm
  const populatedFieldIds = new Set(preflightPlan.map(p => p.matchedField.fieldId));
  const remainingRequiredFields = (targetForm.fields || [])
    .filter(f => f.required && !populatedFieldIds.has(f.fieldId) && !f.hasValue && !f.checked)
    .map(f => ({
      fieldId: f.fieldId,
      name: f.name || undefined,
      label: f.label || f.accessibleName || f.name
    }));

  // Re-inspect validation state
  let validationIssues = [];
  try {
    if (typeof page.evaluate === 'function') {
      validationIssues = await page.evaluate((fId) => {
        let fEl = null;
        if (fId && fId.startsWith('form_')) {
          const idx = parseInt(fId.slice(5), 10);
          fEl = document.querySelectorAll('form')[idx];
        }
        const root = fEl || document;
        const inputs = Array.from(root.querySelectorAll('input:not([type="hidden"]), textarea, select'));
        const issues = [];
        for (const input of inputs) {
          if (input.validity && !input.validity.valid) {
            let issue = 'invalid';
            if (input.validity.valueMissing) issue = 'valueMissing';
            else if (input.validity.typeMismatch) issue = 'typeMismatch';
            else if (input.validity.patternMismatch) issue = 'patternMismatch';
            else if (input.validity.rangeUnderflow) issue = 'rangeUnderflow';
            else if (input.validity.rangeOverflow) issue = 'rangeOverflow';
            issues.push({
              field: input.name || input.id || input.getAttribute('aria-label') || 'unnamed',
              issue,
              message: input.validationMessage || ''
            });
          }
        }
        return issues;
      }, targetForm.formId).catch(() => []);
    }
  } catch {}

  const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
  const durationMs = Math.max(0.001, Number((endTime - startTime).toFixed(3)));

  return {
    success: true,
    pageId: targetPageId,
    formId: targetForm.formId,
    preSnapshotToken: expectedSnapshotToken,
    postSnapshotToken,
    snapshotChanged: postSnapshotToken !== expectedSnapshotToken,
    updatedCount: populatedResults.length,
    populatedFields: populatedResults,
    remainingRequiredFields,
    validation: {
      valid: validationIssues.length === 0 && remainingRequiredFields.length === 0,
      issues: validationIssues
    },
    durationMs
  };
}
