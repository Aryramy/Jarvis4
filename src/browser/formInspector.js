/**
 * Form Discovery & Inspection module for JARVIS4 (Brick 33).
 * Provides deterministic, read-only inspection of HTML forms and controls.
 *
 * Strict invariants:
 * - Read-only: zero form submission, zero typing, zero clicks, zero navigation.
 * - Main document only: no iframe or shadow DOM orchestration.
 * - Input privacy: NEVER expose password values, hidden tokens, file paths, or text values.
 * - Label resolution: <label for>, wrapping label, aria-label, aria-labelledby, placeholder fallback, <legend> context.
 * - Control classification: button (submit/reset/button), input kinds, select options, radio groups, checkboxes.
 * - Validation states: HTML5 validity states (valid, valueMissing, typeMismatch, patternMismatch, etc.).
 * - Deterministic: 0 AI calls, 0 search calls.
 */

import * as cheerio from 'cheerio';

export class FormInspectionError extends Error {
  /**
   * @param {string} message
   * @param {string} [code='FORM_INSPECTION_FAILED']
   * @param {Object} [details={}]
   */
  constructor(message, code = 'FORM_INSPECTION_FAILED', details = {}) {
    super(message);
    this.name = 'FormInspectionError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Normalizes text whitespace conservatively while preserving line structure and Unicode characters.
 * @param {string} raw
 * @returns {string}
 */
export function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n|\r/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter((line, idx, arr) => line !== '' || (idx > 0 && arr[idx - 1] !== ''))
    .join('\n')
    .trim();
}

/**
 * Self-contained DOM extraction function executed inside browser page context (via page.evaluate)
 * or with a DOM-compatible document object.
 *
 * @param {Object} [options={}]
 * @returns {Object}
 */
export function extractFormsSnapshot(options = {}) {
  const doc = typeof document !== 'undefined' ? document : options._doc;
  const win = typeof window !== 'undefined' ? window : options._win;

  if (!doc) {
    return {
      forms: [],
      unassociatedFields: [],
      totalFormsCount: 0,
      totalFieldsCount: 0
    };
  }

  function innerCleanText(raw) {
    if (typeof raw !== 'string') return '';
    return raw
      .replace(/\r\n|\r/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .split('\n')
      .map(line => line.trim())
      .filter((line, idx, arr) => line !== '' || (idx > 0 && arr[idx - 1] !== ''))
      .join('\n')
      .trim();
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (['script', 'style', 'template', 'noscript'].includes(tag)) return false;

    if (el.hasAttribute && (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true')) {
      return false;
    }

    if (win && typeof win.getComputedStyle === 'function') {
      try {
        const style = win.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
          return false;
        }
      } catch {}
    } else if (el.style) {
      if (el.style.display === 'none' || el.style.visibility === 'hidden' || el.style.visibility === 'collapse') {
        return false;
      }
    }

    let parent = el.parentElement;
    while (parent && parent !== doc.documentElement) {
      const pTag = (parent.tagName || '').toLowerCase();
      if (['template', 'script', 'style', 'noscript'].includes(pTag)) return false;
      if (parent.hasAttribute && (parent.hasAttribute('hidden') || parent.getAttribute('aria-hidden') === 'true')) {
        return false;
      }
      if (win && typeof win.getComputedStyle === 'function') {
        try {
          const pStyle = win.getComputedStyle(parent);
          if (pStyle.display === 'none' || pStyle.visibility === 'hidden') return false;
        } catch {}
      } else if (parent.style) {
        if (parent.style.display === 'none' || parent.style.visibility === 'hidden') return false;
      }
      parent = parent.parentElement;
    }

    return true;
  }

  function getLabelNodeText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType === 1) {
      const tag = (node.tagName || node.nodeName || '').toLowerCase();
      if (['select', 'option', 'textarea', 'input', 'button', 'script', 'style'].includes(tag)) {
        return '';
      }
      let text = '';
      const children = node.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        text += getLabelNodeText(children[i]) + ' ';
      }
      return text;
    }
    return '';
  }

  function getCleanLabelText(labelNode) {
    if (!labelNode) return '';
    if (labelNode.childNodes && labelNode.childNodes.length > 0) {
      const raw = getLabelNodeText(labelNode);
      const cleaned = innerCleanText(raw);
      if (cleaned.length > 0) return cleaned;
    }
    const fallback = labelNode.innerText || labelNode.textContent || '';
    return innerCleanText(fallback);
  }

  function findAssociatedLabel(el) {
    if (!el || !doc) return undefined;

    // 1. aria-labelledby
    if (el.getAttribute && el.getAttribute('aria-labelledby') && doc.getElementById) {
      const labelledEl = doc.getElementById(el.getAttribute('aria-labelledby'));
      if (labelledEl) {
        const txt = getCleanLabelText(labelledEl);
        if (txt) return txt;
      }
    }

    // 2. <label for="id">
    const id = el.id || (el.getAttribute && el.getAttribute('id'));
    if (id && doc.querySelector) {
      try {
        const labelEl = doc.querySelector(`label[for="${id}"]`);
        if (labelEl) {
          const txt = getCleanLabelText(labelEl);
          if (txt) return txt;
        }
      } catch {}
    }

    // 3. Enclosing <label>
    if (typeof el.closest === 'function') {
      const parentLabel = el.closest('label');
      if (parentLabel) {
        const txt = getCleanLabelText(parentLabel);
        if (txt) return txt;
      }
    } else {
      let p = el.parentElement;
      while (p && p !== doc.documentElement) {
        if ((p.tagName || '').toLowerCase() === 'label') {
          const txt = getCleanLabelText(p);
          if (txt) return txt;
          break;
        }
        p = p.parentElement;
      }
    }

    // 4. Placeholder fallback
    const placeholder = el.getAttribute ? el.getAttribute('placeholder') : null;
    if (placeholder && placeholder.trim().length > 0) {
      return innerCleanText(placeholder);
    }

    return undefined;
  }

  function findFieldsetLegend(el) {
    if (!el || !doc) return undefined;
    let p = el.parentElement;
    while (p && p !== doc.documentElement) {
      if ((p.tagName || '').toLowerCase() === 'fieldset') {
        const legend = p.querySelector ? p.querySelector('legend') : null;
        if (legend) {
          const txt = innerCleanText(legend.innerText || legend.textContent || '');
          if (txt) return txt;
        }
        break;
      }
      p = p.parentElement;
    }
    return undefined;
  }

  function computeAccessibleName(el, label, ariaLabel) {
    if (ariaLabel && ariaLabel.trim().length > 0) return ariaLabel.trim();
    if (el.getAttribute && el.getAttribute('aria-labelledby') && doc.getElementById) {
      const labelledEl = doc.getElementById(el.getAttribute('aria-labelledby'));
      if (labelledEl) {
        const t = getCleanLabelText(labelledEl);
        if (t) return t;
      }
    }
    if (label && label.trim().length > 0) return label.trim();
    const name = el.getAttribute ? el.getAttribute('name') : null;
    if (name && name.trim().length > 0) return name.trim();
    const id = el.id || (el.getAttribute ? el.getAttribute('id') : null);
    if (id && id.trim().length > 0) return id.trim();
    return '';
  }

  function extractValidity(el) {
    if (!el) return { valid: true, issue: null, message: null };
    if (el.validity) {
      const v = el.validity;
      let issue = null;
      if (!v.valid) {
        if (v.valueMissing) issue = 'valueMissing';
        else if (v.typeMismatch) issue = 'typeMismatch';
        else if (v.patternMismatch) issue = 'patternMismatch';
        else if (v.tooLong) issue = 'tooLong';
        else if (v.tooShort) issue = 'tooShort';
        else if (v.rangeUnderflow) issue = 'rangeUnderflow';
        else if (v.rangeOverflow) issue = 'rangeOverflow';
        else if (v.stepMismatch) issue = 'stepMismatch';
        else if (v.badInput) issue = 'badInput';
        else if (v.customError) issue = 'customError';
        else issue = 'invalid';
      }
      return {
        valid: Boolean(v.valid),
        issue,
        message: el.validationMessage ? innerCleanText(el.validationMessage) : null
      };
    }
    return { valid: true, issue: null, message: null };
  }

  // Find all form elements
  const formElements = Array.from(doc.querySelectorAll ? doc.querySelectorAll('form') : []);
  const formMap = new Map();
  const forms = [];

  for (let idx = 0; idx < formElements.length; idx++) {
    const fEl = formElements[idx];
    const formId = `form_${idx}`;
    const name = fEl.getAttribute ? fEl.getAttribute('name') : null;
    const id = fEl.id || (fEl.getAttribute ? fEl.getAttribute('id') : null);
    const action = fEl.getAttribute ? fEl.getAttribute('action') : (typeof fEl.action === 'string' ? fEl.action : '');
    const method = ((fEl.getAttribute ? fEl.getAttribute('method') : null) || fEl.method || 'GET').toUpperCase();

    const ariaLabel = fEl.getAttribute ? fEl.getAttribute('aria-label') : null;
    let accessibleName = '';
    if (ariaLabel && ariaLabel.trim().length > 0) {
      accessibleName = innerCleanText(ariaLabel);
    } else if (fEl.getAttribute && fEl.getAttribute('aria-labelledby') && doc.getElementById) {
      const lab = doc.getElementById(fEl.getAttribute('aria-labelledby'));
      if (lab) accessibleName = getCleanLabelText(lab);
    }
    if (!accessibleName && name) accessibleName = innerCleanText(name);
    if (!accessibleName && id) accessibleName = innerCleanText(id);

    const formObj = {
      formId,
      name: name || undefined,
      id: id || undefined,
      action: action || undefined,
      method,
      accessibleName: accessibleName || undefined,
      fields: [],
      buttons: [],
      radioGroups: []
    };

    forms.push(formObj);
    formMap.set(fEl, formObj);
    if (id) formMap.set(id, formObj);
  }

  // Find all candidate form controls across the main document
  const controlCandidates = Array.from(doc.querySelectorAll ? doc.querySelectorAll('input, textarea, select, button') : []);
  const unassociatedFields = [];
  let fieldCounter = 0;
  let buttonCounter = 0;

  for (let i = 0; i < controlCandidates.length; i++) {
    const el = controlCandidates[i];
    const tag = (el.tagName || '').toLowerCase();
    const itype = (tag === 'input' ? ((el.getAttribute ? el.getAttribute('type') : null) || el.type || 'text') : tag).toLowerCase();

    // Determine associated form
    let parentFormObj = null;
    if (el.form && formMap.has(el.form)) {
      parentFormObj = formMap.get(el.form);
    } else if (el.getAttribute && el.getAttribute('form') && formMap.has(el.getAttribute('form'))) {
      parentFormObj = formMap.get(el.getAttribute('form'));
    } else if (typeof el.closest === 'function') {
      const closestForm = el.closest('form');
      if (closestForm && formMap.has(closestForm)) {
        parentFormObj = formMap.get(closestForm);
      }
    } else {
      let p = el.parentElement;
      while (p && p !== doc.documentElement) {
        if ((p.tagName || '').toLowerCase() === 'form' && formMap.has(p)) {
          parentFormObj = formMap.get(p);
          break;
        }
        p = p.parentElement;
      }
    }

    // BUTTON CLASSIFICATION
    if (tag === 'button' || (tag === 'input' && ['submit', 'reset', 'button', 'image'].includes(itype))) {
      if (!isVisible(el)) continue;

      let bType = 'button';
      if (tag === 'button') {
        const declaredType = (el.getAttribute ? el.getAttribute('type') : null) || el.type;
        if (!declaredType && parentFormObj) {
          bType = 'submit';
        } else if ((declaredType || '').toLowerCase() === 'submit') {
          bType = 'submit';
        } else if ((declaredType || '').toLowerCase() === 'reset') {
          bType = 'reset';
        } else {
          bType = 'button';
        }
      } else if (tag === 'input') {
        if (itype === 'submit' || itype === 'image') bType = 'submit';
        else if (itype === 'reset') bType = 'reset';
        else bType = 'button';
      }

      const btnText = innerCleanText(el.innerText || el.textContent || el.value || (el.getAttribute ? el.getAttribute('value') : '') || '');
      const ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
      const accessibleName = ariaLabel ? innerCleanText(ariaLabel) : (btnText || bType);
      const isDisabled = Boolean(el.disabled || (el.hasAttribute && el.hasAttribute('disabled')) || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'));

      const buttonRecord = {
        buttonId: `btn_${buttonCounter++}`,
        type: bType,
        text: btnText || undefined,
        accessibleName: accessibleName || undefined,
        disabled: isDisabled ? true : undefined,
        formId: parentFormObj ? parentFormObj.formId : undefined
      };

      if (parentFormObj) {
        parentFormObj.buttons.push(buttonRecord);
      }
      continue;
    }

    // FIELD CLASSIFICATION (input, textarea, select)
    const isHiddenInput = itype === 'hidden';
    if (!isHiddenInput && !isVisible(el)) {
      continue;
    }

    const fieldId = `fld_${fieldCounter++}`;
    const name = el.getAttribute ? el.getAttribute('name') : (el.name || null);
    const id = el.id || (el.getAttribute ? el.getAttribute('id') : null);
    const ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
    const cleanAria = ariaLabel ? innerCleanText(ariaLabel) : null;
    const label = findAssociatedLabel(el);
    const accessibleName = computeAccessibleName(el, label, cleanAria);
    const placeholder = el.getAttribute ? el.getAttribute('placeholder') : null;

    const isRequired = Boolean(el.required || (el.hasAttribute && el.hasAttribute('required')) || (el.getAttribute && el.getAttribute('aria-required') === 'true'));
    const isDisabled = Boolean(el.disabled || (el.hasAttribute && el.hasAttribute('disabled')) || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'));
    const isReadonly = Boolean(el.readOnly || (el.hasAttribute && el.hasAttribute('readonly')) || (el.getAttribute && el.getAttribute('aria-readonly') === 'true'));
    const autocomplete = el.getAttribute ? el.getAttribute('autocomplete') : null;
    const groupLegend = findFieldsetLegend(el);

    let kind = itype;
    if (tag === 'select') kind = 'select';
    else if (tag === 'textarea') kind = 'textarea';
    else if (!kind || kind === 'input') kind = 'text';

    const baseRecord = {
      fieldId,
      kind,
      type: itype,
      name: name || undefined,
      id: id || undefined,
      label: label || undefined,
      accessibleName: accessibleName || undefined,
      placeholder: placeholder ? innerCleanText(placeholder) : undefined,
      required: isRequired ? true : undefined,
      disabled: isDisabled ? true : undefined,
      readonly: isReadonly ? true : undefined,
      formId: parentFormObj ? parentFormObj.formId : undefined,
      autocomplete: autocomplete && autocomplete !== 'off' ? autocomplete : undefined
    };

    // STRICT PRIVACY: NEVER EXPOSE VALUES OF PASSWORDS, HIDDEN INPUTS, FILE PATHS, OR TEXT
    if (itype === 'password') {
      baseRecord.sensitive = true;
    } else if (itype === 'file') {
      baseRecord.isFile = true;
    } else if (itype === 'hidden') {
      baseRecord.isHidden = true;
    }

    // Specific control behaviors
    if (itype === 'checkbox') {
      baseRecord.checked = Boolean(el.checked || (el.hasAttribute && el.hasAttribute('checked')));
      if (groupLegend) baseRecord.groupLabel = groupLegend;
    } else if (itype === 'radio') {
      baseRecord.checked = Boolean(el.checked || (el.hasAttribute && el.hasAttribute('checked')));
      baseRecord.group = name || undefined;
      baseRecord.value = (el.getAttribute ? el.getAttribute('value') : el.value) || '';
      if (groupLegend) baseRecord.groupLabel = groupLegend;
    } else if (tag === 'select') {
      const optionsArr = [];
      let selectedOption = null;
      const opts = el.options ? Array.from(el.options) : [];
      for (let oIdx = 0; oIdx < opts.length; oIdx++) {
        const opt = opts[oIdx];
        const optText = innerCleanText(opt.innerText || opt.textContent || opt.text || '');
        const optVal = (opt.getAttribute ? opt.getAttribute('value') : opt.value) ?? optText;
        const optDisabled = Boolean(opt.disabled || (opt.hasAttribute && opt.hasAttribute('disabled')));
        const isSel = Boolean(opt.selected || el.selectedIndex === oIdx);
        const optRecord = {
          label: optText,
          value: optVal,
          selected: isSel ? true : undefined,
          disabled: optDisabled ? true : undefined
        };
        optionsArr.push(optRecord);
        if (isSel && !selectedOption) {
          selectedOption = { label: optText, value: optVal };
        }
      }
      baseRecord.options = optionsArr;
      if (selectedOption) {
        baseRecord.selectedOption = selectedOption;
      }
      baseRecord.multiple = Boolean(el.multiple || (el.hasAttribute && el.hasAttribute('multiple')));
      baseRecord.validity = extractValidity(el);
    } else if (['text', 'email', 'tel', 'url', 'number', 'search', 'date', 'textarea'].includes(itype)) {
      // Indicate whether a value is present without leaking the contents
      const rawVal = el.value || '';
      baseRecord.hasValue = Boolean(rawVal && rawVal.trim().length > 0);
      baseRecord.validity = extractValidity(el);
    }

    if (parentFormObj) {
      parentFormObj.fields.push(baseRecord);
    } else {
      unassociatedFields.push(baseRecord);
    }
  }

  // Aggregate radio groups inside each form
  for (const form of forms) {
    const radioMap = new Map();
    for (const f of form.fields) {
      if (f.type === 'radio' && f.group) {
        if (!radioMap.has(f.group)) {
          radioMap.set(f.group, {
            fieldId: `radio_group_${f.group}`,
            kind: 'radio',
            type: 'radio',
            name: f.group,
            groupName: f.group,
            label: f.groupLabel || f.group,
            accessibleName: f.groupLabel || f.group,
            required: f.required,
            formId: form.formId,
            options: []
          });
        }
        const grp = radioMap.get(f.group);
        const optLabel = f.label || f.accessibleName || f.value;
        grp.options.push({
          label: optLabel,
          value: f.value,
          checked: Boolean(f.checked),
          disabled: Boolean(f.disabled)
        });
        if (f.checked) {
          grp.selected = optLabel;
          grp.value = f.value;
        }
      }
    }
    const groups = Array.from(radioMap.values());
    form.radioGroups = groups;
    for (const grp of groups) {
      if (!form.fields.some(f => f.label === grp.label && f.kind === 'radio' && f.options)) {
        form.fields.push(grp);
      }
    }
  }

  return {
    forms,
    unassociatedFields,
    totalFormsCount: forms.length,
    totalFieldsCount: forms.reduce((sum, f) => sum + f.fields.length, 0) + unassociatedFields.length
  };
}

/**
 * Inspects forms from a Cheerio instance for deterministic offline tests.
 *
 * @param {Object} $ - Cheerio loaded instance
 * @param {Object} [options={}]
 * @returns {Object}
 */
export function inspectFormsFromCheerio($, options = {}) {
  const forms = [];
  const unassociatedFields = [];
  let fieldCounter = 0;
  let buttonCounter = 0;

  function innerClean(raw) {
    return cleanText(raw || '');
  }

  const formElements = $('form').toArray();
  const formMap = new Map();

  formElements.forEach((fEl, idx) => {
    const $f = $(fEl);
    const formId = `form_${idx}`;
    const name = $f.attr('name');
    const id = $f.attr('id');
    const action = $f.attr('action');
    const method = ($f.attr('method') || 'GET').toUpperCase();
    const ariaLabel = $f.attr('aria-label');
    let accessibleName = ariaLabel ? innerClean(ariaLabel) : (name ? innerClean(name) : (id ? innerClean(id) : undefined));

    const formObj = {
      formId,
      name: name || undefined,
      id: id || undefined,
      action: action || undefined,
      method,
      accessibleName,
      fields: [],
      buttons: [],
      radioGroups: []
    };
    forms.push(formObj);
    formMap.set(fEl, formObj);
    if (id) formMap.set(id, formObj);
  });

  const controls = $('input, textarea, select, button').toArray();

  controls.forEach((el) => {
    const $el = $(el);
    const tag = (el.name || el.tagName || '').toLowerCase();
    const itype = tag === 'input' ? ($el.attr('type') || 'text').toLowerCase() : tag;

    // Check parent form
    let parentFormObj = null;
    const formAttr = $el.attr('form');
    if (formAttr && formMap.has(formAttr)) {
      parentFormObj = formMap.get(formAttr);
    } else {
      const parentForm = $el.closest('form').get(0);
      if (parentForm && formMap.has(parentForm)) {
        parentFormObj = formMap.get(parentForm);
      }
    }

    // Button
    if (tag === 'button' || (tag === 'input' && ['submit', 'reset', 'button', 'image'].includes(itype))) {
      let bType = 'button';
      if (tag === 'button') {
        const declaredType = ($el.attr('type') || '').toLowerCase();
        if (!declaredType && parentFormObj) bType = 'submit';
        else if (declaredType === 'submit') bType = 'submit';
        else if (declaredType === 'reset') bType = 'reset';
        else bType = 'button';
      } else {
        if (itype === 'submit' || itype === 'image') bType = 'submit';
        else if (itype === 'reset') bType = 'reset';
        else bType = 'button';
      }

      const btnText = innerClean($el.text() || $el.attr('value') || '');
      const ariaLabel = $el.attr('aria-label');
      const accessibleName = ariaLabel ? innerClean(ariaLabel) : (btnText || bType);
      const isDisabled = Boolean($el.attr('disabled') !== undefined || $el.attr('aria-disabled') === 'true');

      const buttonRecord = {
        buttonId: `btn_${buttonCounter++}`,
        type: bType,
        text: btnText || undefined,
        accessibleName: accessibleName || undefined,
        disabled: isDisabled ? true : undefined,
        formId: parentFormObj ? parentFormObj.formId : undefined
      };

      if (parentFormObj) {
        parentFormObj.buttons.push(buttonRecord);
      }
      return;
    }

    const fieldId = `fld_${fieldCounter++}`;
    const name = $el.attr('name');
    const id = $el.attr('id');
    const placeholder = $el.attr('placeholder');
    const ariaLabel = $el.attr('aria-label');
    const ariaLabelledby = $el.attr('aria-labelledby');

    // Label resolution
    let label = undefined;
    if (ariaLabelledby) {
      const labEl = $(`#${ariaLabelledby}`);
      if (labEl.length) label = innerClean(labEl.text());
    }
    if (!label && id) {
      const forLab = $(`label[for="${id}"]`);
      if (forLab.length) {
        const clone = forLab.clone();
        clone.find('select, input, textarea, button').remove();
        label = innerClean(clone.text());
      }
    }
    if (!label) {
      const parentLabel = $el.closest('label');
      if (parentLabel.length) {
        const clone = parentLabel.clone();
        clone.find('select, input, textarea, button').remove();
        label = innerClean(clone.text());
      }
    }
    if (!label && placeholder) {
      label = innerClean(placeholder);
    }

    let accessibleName = ariaLabel ? innerClean(ariaLabel) : (label || name || id || '');
    const isRequired = Boolean($el.attr('required') !== undefined || $el.attr('aria-required') === 'true');
    const isDisabled = Boolean($el.attr('disabled') !== undefined || $el.attr('aria-disabled') === 'true');
    const isReadonly = Boolean($el.attr('readonly') !== undefined || $el.attr('aria-readonly') === 'true');
    const groupLegend = innerClean($el.closest('fieldset').find('legend').first().text()) || undefined;

    const baseRecord = {
      fieldId,
      kind: tag === 'select' ? 'select' : (tag === 'textarea' ? 'textarea' : itype),
      type: itype,
      name: name || undefined,
      id: id || undefined,
      label: label || undefined,
      accessibleName: accessibleName || undefined,
      placeholder: placeholder ? innerClean(placeholder) : undefined,
      required: isRequired ? true : undefined,
      disabled: isDisabled ? true : undefined,
      readonly: isReadonly ? true : undefined,
      formId: parentFormObj ? parentFormObj.formId : undefined
    };

    if (itype === 'password') {
      baseRecord.sensitive = true;
    } else if (itype === 'file') {
      baseRecord.isFile = true;
    } else if (itype === 'hidden') {
      baseRecord.isHidden = true;
    }

    if (itype === 'checkbox') {
      baseRecord.checked = Boolean($el.attr('checked') !== undefined);
      if (groupLegend) baseRecord.groupLabel = groupLegend;
    } else if (itype === 'radio') {
      baseRecord.checked = Boolean($el.attr('checked') !== undefined);
      baseRecord.group = name || undefined;
      baseRecord.value = $el.attr('value') || '';
      if (groupLegend) baseRecord.groupLabel = groupLegend;
    } else if (tag === 'select') {
      const optionsArr = [];
      let selectedOption = null;
      $el.find('option').each((oIdx, optEl) => {
        const $opt = $(optEl);
        const optText = innerClean($opt.text());
        const optVal = $opt.attr('value') ?? optText;
        const optDisabled = Boolean($opt.attr('disabled') !== undefined);
        const isSel = Boolean($opt.attr('selected') !== undefined);
        const optRecord = {
          label: optText,
          value: optVal,
          selected: isSel ? true : undefined,
          disabled: optDisabled ? true : undefined
        };
        optionsArr.push(optRecord);
        if (isSel && !selectedOption) {
          selectedOption = { label: optText, value: optVal };
        }
      });
      baseRecord.options = optionsArr;
      if (selectedOption) baseRecord.selectedOption = selectedOption;
      baseRecord.multiple = Boolean($el.attr('multiple') !== undefined);
    } else if (['text', 'email', 'tel', 'url', 'number', 'search', 'textarea'].includes(itype)) {
      const val = tag === 'textarea' ? $el.text() : ($el.attr('value') || '');
      baseRecord.hasValue = Boolean(val && val.trim().length > 0);
    }

    if (parentFormObj) {
      parentFormObj.fields.push(baseRecord);
    } else {
      unassociatedFields.push(baseRecord);
    }
  });

  // Aggregate radio groups
  for (const form of forms) {
    const radioMap = new Map();
    for (const f of form.fields) {
      if (f.type === 'radio' && f.group) {
        if (!radioMap.has(f.group)) {
          radioMap.set(f.group, {
            groupName: f.group,
            label: f.groupLabel || f.group,
            required: f.required,
            options: []
          });
        }
        const grp = radioMap.get(f.group);
        grp.options.push({
          label: f.label || f.accessibleName || f.value,
          value: f.value,
          checked: Boolean(f.checked),
          disabled: Boolean(f.disabled)
        });
        if (f.checked) {
          grp.selected = f.label || f.accessibleName || f.value;
        }
      }
    }
    form.radioGroups = Array.from(radioMap.values());
  }

  return {
    forms,
    unassociatedFields,
    totalFormsCount: forms.length,
    totalFieldsCount: forms.reduce((sum, f) => sum + f.fields.length, 0) + unassociatedFields.length
  };
}

/**
 * Inspects forms on a real Playwright page instance or mock page.
 *
 * @param {Object} page - Playwright page
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
export async function inspectForms(page, options = {}) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    throw new FormInspectionError('Page is closed or unavailable.', 'PAGE_CLOSED');
  }

  const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  let snapshot;
  if (typeof options.evaluator === 'function') {
    snapshot = await options.evaluator(page, options);
  } else if (typeof page.evaluate === 'function') {
    snapshot = await page.evaluate(extractFormsSnapshot, options);
  } else {
    throw new FormInspectionError('Page evaluate method not available.', 'BROWSER_ERROR');
  }

  const endTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

  return {
    forms: snapshot?.forms || [],
    unassociatedFields: snapshot?.unassociatedFields || [],
    totalFormsCount: snapshot?.totalFormsCount || 0,
    totalFieldsCount: snapshot?.totalFieldsCount || 0,
    inspectionDurationMs: Math.max(0.001, Number((endTime - startTime).toFixed(3)))
  };
}
