/**
 * Deterministic Evidence Grader for JARVIS4 (PRE-040C).
 *
 * Invariants:
 * - 100% deterministic evaluation.
 * - Zero LLM / Zero model evaluation calls.
 * - Evaluates authoritative browser state and normalized trajectory evidence envelopes.
 * - Agent text messages ("I completed the task") never determine success.
 */

/**
 * Normalizes text for lenient whitespace comparison.
 * @param {string} str
 * @returns {string}
 */
function normalizeText(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\s+/g, ' ').trim();
}

function unwrapUntrusted(val) {
  if (val && typeof val === 'object') {
    if (val.trust === 'untrusted_web_data' && val.content !== undefined) {
      return unwrapUntrusted(val.content);
    }
  }
  return val;
}

/**
 * Recursively checks if `subset` matches `source`.
 * @param {any} rawSource
 * @param {any} rawSubset
 * @returns {boolean}
 */
function deepMatches(rawSource, rawSubset) {
  const source = unwrapUntrusted(rawSource);
  const subset = unwrapUntrusted(rawSubset);
  if (subset === source) return true;
  if (subset === null || subset === undefined || source === null || source === undefined) {
    return subset === source;
  }
  if (typeof subset !== 'object') {
    return subset === source;
  }
  if (Array.isArray(subset)) {
    if (!Array.isArray(source)) return false;
    return subset.every(subItem => source.some(srcItem => deepMatches(srcItem, subItem)));
  }
  for (const key of Object.keys(subset)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) return false;
    if (!deepMatches(source[key], subset[key])) return false;
  }
  return true;
}

/**
 * Grades trajectory evidence against declarative expected evidence criteria.
 *
 * @param {Object} options
 * @param {Object} options.expectedEvidence - Declarative criteria from eval task
 * @param {Object} options.trajectory - Normalized trajectory record
 * @param {Object} [options.finalBrowserState] - Authoritative browser state (URL, inspection, forms, download)
 * @returns {{ passed: boolean, conditions: Array<{ name: string, passed: boolean, expected: any, actual: any, reason?: string }> }}
 */
export function gradeEvidence({ expectedEvidence, trajectory, finalBrowserState = {} }) {
  const conditions = [];
  let allPassed = true;

  const recordCondition = (name, passed, expected, actual, reason = null) => {
    conditions.push({ name, passed, expected, actual, reason });
    if (!passed) allPassed = false;
  };

  const terminalState = trajectory?.terminalState || null;
  const lastStep = trajectory?.steps?.[trajectory.steps.length - 1] || null;
  const lastEvidence = lastStep?.evidence || null;
  const finalUrl = finalBrowserState?.currentUrl || lastEvidence?.observed?.currentUrl || lastEvidence?.observed?.url || null;
  const rawVisibleText = finalBrowserState?.inspection?.visibleText || lastEvidence?.observed?.visibleText || '';
  const finalVisibleText = typeof rawVisibleText === 'object' && rawVisibleText?.trust === 'untrusted_web_data'
    ? (rawVisibleText.content || '')
    : (typeof rawVisibleText === 'string' ? rawVisibleText : '');
  const finalElements = finalBrowserState?.inspection?.elements || lastEvidence?.observed?.elements || [];

  // 1. Terminal State Condition
  if (expectedEvidence.terminalState) {
    const passed = terminalState === expectedEvidence.terminalState;
    recordCondition('terminalState', passed, expectedEvidence.terminalState, terminalState, passed ? null : `Terminal state was "${terminalState}", expected "${expectedEvidence.terminalState}".`);
  }

  // 2. URL Equals Condition
  if (expectedEvidence.urlEquals) {
    const passed = finalUrl === expectedEvidence.urlEquals;
    recordCondition('urlEquals', passed, expectedEvidence.urlEquals, finalUrl, passed ? null : `Current URL "${finalUrl}" did not equal expected "${expectedEvidence.urlEquals}".`);
  }

  // 3. URL Contains Condition
  if (expectedEvidence.urlContains) {
    const passed = typeof finalUrl === 'string' && finalUrl.includes(expectedEvidence.urlContains);
    recordCondition('urlContains', passed, expectedEvidence.urlContains, finalUrl, passed ? null : `Current URL "${finalUrl}" did not contain "${expectedEvidence.urlContains}".`);
  }

  // 4. Text Present Condition
  if (expectedEvidence.textPresent) {
    const targets = Array.isArray(expectedEvidence.textPresent) ? expectedEvidence.textPresent : [expectedEvidence.textPresent];
    for (const needle of targets) {
      const normNeedle = normalizeText(needle);
      const normHaystack = normalizeText(finalVisibleText);
      // Check in visibleText or any step evidence observed text
      let found = normHaystack.includes(normNeedle);
      if (!found && trajectory?.steps) {
        for (const step of trajectory.steps) {
          const obsStr = JSON.stringify(step.evidence?.observed || '');
          if (obsStr.includes(needle)) {
            found = true;
            break;
          }
        }
      }
      recordCondition(`textPresent[${needle}]`, found, needle, found ? 'present' : 'absent', found ? null : `Expected text "${needle}" was not found in page or evidence.`);
    }
  }

  // 5. Text Absent Condition
  if (expectedEvidence.textAbsent) {
    const targets = Array.isArray(expectedEvidence.textAbsent) ? expectedEvidence.textAbsent : [expectedEvidence.textAbsent];
    for (const needle of targets) {
      const normNeedle = normalizeText(needle);
      const normHaystack = normalizeText(finalVisibleText);
      const absent = !normHaystack.includes(normNeedle);
      recordCondition(`textAbsent[${needle}]`, absent, 'absent', absent ? 'absent' : 'present', absent ? null : `Forbidden text "${needle}" was present in page text.`);
    }
  }

  // 6. Target Present Condition
  if (expectedEvidence.targetPresent) {
    const q = expectedEvidence.targetPresent;
    const match = finalElements.find(el => {
      if (q.kind && el.kind !== q.kind) return false;
      if (q.text && !normalizeText(el.text).includes(normalizeText(q.text))) return false;
      if (q.accessibleName && normalizeText(el.accessibleName) !== normalizeText(q.accessibleName)) return false;
      if (q.name && el.name !== q.name) return false;
      if (q.id && el.id !== q.id) return false;
      return true;
    });
    recordCondition('targetPresent', Boolean(match), q, match ? { kind: match.kind, text: match.text } : null, match ? null : `Expected target ${JSON.stringify(q)} was not found.`);
  }

  // 7. Target Absent Condition
  if (expectedEvidence.targetAbsent) {
    const q = expectedEvidence.targetAbsent;
    const match = finalElements.find(el => {
      if (q.kind && el.kind !== q.kind) return false;
      if (q.text && !normalizeText(el.text).includes(normalizeText(q.text))) return false;
      if (q.accessibleName && normalizeText(el.accessibleName) !== normalizeText(q.accessibleName)) return false;
      if (q.name && el.name !== q.name) return false;
      if (q.id && el.id !== q.id) return false;
      return true;
    });
    recordCondition('targetAbsent', !match, q, match ? { kind: match.kind, text: match.text } : null, !match ? null : `Target ${JSON.stringify(q)} was unexpectedly present.`);
  }

  // 8. Download Verified Condition
  if (expectedEvidence.downloadVerified !== undefined) {
    const actualVerified = Boolean(
      finalBrowserState?.downloadVerified ||
      trajectory?.steps?.some(s => s.evidence?.observed?.downloadVerified || s.evidence?.observed?.downloadId)
    );
    const passed = actualVerified === expectedEvidence.downloadVerified;
    recordCondition('downloadVerified', passed, expectedEvidence.downloadVerified, actualVerified, passed ? null : `Expected downloadVerified=${expectedEvidence.downloadVerified}, observed=${actualVerified}.`);
  }

  // 9. Structured Data Equals Condition
  if (expectedEvidence.structuredDataEquals) {
    let actualData = finalBrowserState?.structuredData || lastEvidence?.observed?.structuredData || lastEvidence?.observed?.data || null;
    if (!actualData && trajectory?.steps) {
      for (let i = trajectory.steps.length - 1; i >= 0; i--) {
        const stepObs = trajectory.steps[i]?.evidence?.observed;
        if (stepObs?.data || stepObs?.structuredData) {
          actualData = stepObs.data || stepObs.structuredData;
          break;
        }
      }
    }
    const matches = deepMatches(actualData, expectedEvidence.structuredDataEquals);
    recordCondition('structuredDataEquals', matches, expectedEvidence.structuredDataEquals, actualData, matches ? null : 'Extracted structured data did not match expected subset.');
  }

  // 10. Handoff Reason Condition
  if (expectedEvidence.handoffReason) {
    const actualReason = finalBrowserState?.handoffReason || lastEvidence?.observed?.reason || lastEvidence?.observed?.handoff?.reason || null;
    const passed = actualReason === expectedEvidence.handoffReason;
    recordCondition('handoffReason', passed, expectedEvidence.handoffReason, actualReason, passed ? null : `Handoff reason was "${actualReason}", expected "${expectedEvidence.handoffReason}".`);
  }

  // 11. Safe Refusal Code Condition
  if (expectedEvidence.safeRefusalCode) {
    const code = expectedEvidence.safeRefusalCode;
    const actualRefusal = trajectory?.steps?.find(s =>
      s.refusalCode === code ||
      s.errorCode === code ||
      (s.errorMessage && s.errorMessage.includes(code)) ||
      s.evidence?.observed?.errorCode === code
    )?.refusalCode ||
    trajectory?.steps?.find(s => s.errorCode === code)?.errorCode ||
    (terminalState === code ? terminalState : null) ||
    (trajectory?.steps?.some(s => (s.errorMessage && s.errorMessage.includes(code))) ? code : null);
    const passed = Boolean(actualRefusal);
    recordCondition('safeRefusalCode', passed, expectedEvidence.safeRefusalCode, actualRefusal || 'none', passed ? null : `Expected safe refusal code "${expectedEvidence.safeRefusalCode}" was not observed.`);
  }

  return {
    passed: allPassed,
    conditions
  };
}
