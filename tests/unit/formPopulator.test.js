import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager } from '../../src/browser/browserManager.js';
import { populateForm, FormPopulationError } from '../../src/browser/formPopulator.js';

function createMockFormEnvironment(options = {}) {
  const forms = options.forms ?? [
    {
      formId: 'form_0',
      name: 'orderForm',
      id: 'order-form',
      fields: [
        { fieldId: 'fld_0', kind: 'input', type: 'text', name: 'fullName', label: 'Full Name', accessibleName: 'Full Name' },
        { fieldId: 'fld_1', kind: 'input', type: 'email', name: 'email', label: 'Email Address', accessibleName: 'Email Address', required: true },
        { fieldId: 'fld_2', kind: 'textarea', type: 'textarea', name: 'comments', label: 'Comments', accessibleName: 'Comments' },
        {
          fieldId: 'fld_3',
          kind: 'select',
          type: 'select',
          name: 'country',
          label: 'Country',
          accessibleName: 'Country',
          options: [
            { label: 'Select Country', value: '' },
            { label: 'Qatar', value: 'QA' },
            { label: 'United States', value: 'US' }
          ]
        },
        { fieldId: 'fld_4', kind: 'input', type: 'checkbox', name: 'subscribe', label: 'Subscribe', accessibleName: 'Subscribe', checked: false },
        { fieldId: 'fld_5', kind: 'input', type: 'radio', name: 'payment', group: 'payment', value: 'visa', label: 'Visa', accessibleName: 'Visa', checked: false },
        { fieldId: 'fld_6', kind: 'input', type: 'radio', name: 'payment', group: 'payment', value: 'cash', label: 'Cash', accessibleName: 'Cash', checked: true },
        { fieldId: 'fld_7', kind: 'input', type: 'password', name: 'pwd', label: 'Password', accessibleName: 'Password', sensitive: true },
        { fieldId: 'fld_8', kind: 'input', type: 'file', name: 'doc', label: 'Upload Document', accessibleName: 'Upload Document', isFile: true },
        { fieldId: 'fld_9', kind: 'input', type: 'hidden', name: 'csrf', isHidden: true },
        { fieldId: 'fld_10', kind: 'input', type: 'text', name: 'disabledField', label: 'Disabled Field', accessibleName: 'Disabled Field', disabled: true },
        { fieldId: 'fld_11', kind: 'input', type: 'text', name: 'readonlyField', label: 'Readonly Field', accessibleName: 'Readonly Field', readonly: true }
      ],
      buttons: [
        { buttonId: 'btn_0', type: 'submit', text: 'Submit Order' }
      ]
    }
  ];

  const fieldState = {
    fullName: '',
    email: '',
    comments: '',
    country: 'Select Country',
    subscribe: false,
    payment: 'cash'
  };

  const mutationsLog = [];

  const mockPage = {
    url: () => 'https://example.com/form',
    evaluate: async (fn, args) => {
      if (typeof fn === 'function') {
        return fn(args);
      }
      return null;
    },
    evaluateHandle: async (fn, targetField) => {
      return {
        asElement: () => ({
          isConnected: async () => true,
          isDisabled: async () => Boolean(targetField.disabled),
          inputValue: async () => fieldState[targetField.name] ?? '',
          isChecked: async () => Boolean(fieldState[targetField.name]),
          fill: async (val) => {
            if (options.failOnField && targetField.name === options.failOnField) {
              throw new Error(`Synthetic mid-mutation failure on ${targetField.name}`);
            }
            mutationsLog.push({ action: 'fill', field: targetField.name, val });
            fieldState[targetField.name] = val;
          },
          check: async () => {
            if (options.failOnField && targetField.name === options.failOnField) {
              throw new Error(`Synthetic mid-mutation failure on ${targetField.name}`);
            }
            mutationsLog.push({ action: 'check', field: targetField.name });
            if (targetField.type === 'radio') {
              fieldState[targetField.group || targetField.name] = targetField.value;
            } else {
              fieldState[targetField.name] = true;
            }
          },
          uncheck: async () => {
            if (options.failOnField && targetField.name === options.failOnField) {
              throw new Error(`Synthetic mid-mutation failure on ${targetField.name}`);
            }
            mutationsLog.push({ action: 'uncheck', field: targetField.name });
            fieldState[targetField.name] = false;
          },
          selectOption: async (opt) => {
            if (options.failOnField && targetField.name === options.failOnField) {
              throw new Error(`Synthetic mid-mutation failure on ${targetField.name}`);
            }
            mutationsLog.push({ action: 'select', field: targetField.name, option: opt.label });
            fieldState[targetField.name] = opt.label;
          },
          evaluate: async (fn, args) => {
            if (targetField.kind === 'select') {
              return fieldState[targetField.name];
            }
            return null;
          },
          dispose: async () => {}
        })
      };
    }
  };

  const bm = new BrowserManager({ launcher: () => {} });
  bm._state = 'running';
  const pageId = 'pg_test_forms';
  bm._activePageId = pageId;
  const snapshotToken = 'snap_v1_valid';

  bm._pages.set(pageId, {
    pageId,
    page: mockPage,
    snapshotToken,
    semanticRevision: 1,
    snapshotSemanticRevision: 1,
    spaRouteVersion: 1,
    snapshotRouteVersion: 1,
    documentVersion: 1
  });

  bm.inspectForms = async () => ({
    forms,
    unassociatedFields: [],
    totalFormsCount: forms.length,
    totalFieldsCount: forms[0].fields.length
  });

  return { bm, mockPage, fieldState, mutationsLog, snapshotToken, pageId };
}

describe('Form Populator Unit Tests (Brick 33)', () => {
  test('successfully fills text, textarea, select, checkbox, and radio fields', async () => {
    const { bm, mockPage, fieldState, snapshotToken } = createMockFormEnvironment();

    const result = await populateForm(mockPage, bm, {
      expectedSnapshotToken: snapshotToken,
      formId: 'form_0',
      fields: [
        { name: 'Full Name', value: 'John Smith' },
        { name: 'Comments', value: 'Fast shipping please' },
        { name: 'Country', value: 'Qatar' },
        { name: 'Subscribe', checked: true },
        { name: 'Visa', checked: true }
      ]
    });

    assert.equal(result.success, true);
    assert.equal(result.populatedFields.length, 5);
    assert.equal(fieldState.fullName, 'John Smith');
    assert.equal(fieldState.comments, 'Fast shipping please');
    assert.equal(fieldState.country, 'Qatar');
    assert.equal(fieldState.subscribe, true);
    assert.equal(fieldState.payment, 'visa');
    assert.ok(result.snapshotChanged);
  });

  test('preflight fails and causes ZERO mutations when snapshot token is stale', async () => {
    const { bm, mockPage, mutationsLog } = createMockFormEnvironment();

    let threw = false;
    try {
      await populateForm(mockPage, bm, {
        expectedSnapshotToken: 'snap_v999_stale',
        fields: [{ name: 'Full Name', value: 'John' }]
      });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'TARGET_STALE');
    }

    assert.equal(threw, true);
    assert.equal(mutationsLog.length, 0, 'Zero DOM mutations must occur when snapshot is stale');
  });

  test('preflight fails and causes ZERO mutations when a requested field does not exist', async () => {
    const { bm, mockPage, mutationsLog, snapshotToken } = createMockFormEnvironment();

    let threw = false;
    try {
      await populateForm(mockPage, bm, {
        expectedSnapshotToken: snapshotToken,
        fields: [
          { name: 'Full Name', value: 'John' },
          { name: 'Nonexistent Field', value: '123' }
        ]
      });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'FIELD_NOT_FOUND');
    }

    assert.equal(threw, true);
    assert.equal(mutationsLog.length, 0, 'Zero DOM mutations must occur when any field is missing');
  });

  test('preflight blocks password fill with SENSITIVE_FIELD_NOT_ALLOWED and zero mutations', async () => {
    const { bm, mockPage, mutationsLog, snapshotToken } = createMockFormEnvironment();

    let threw = false;
    try {
      await populateForm(mockPage, bm, {
        expectedSnapshotToken: snapshotToken,
        fields: [
          { name: 'Full Name', value: 'John' },
          { name: 'Password', value: 'Secret123' }
        ]
      });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'SENSITIVE_FIELD_NOT_ALLOWED');
    }

    assert.equal(threw, true);
    assert.equal(mutationsLog.length, 0, 'Zero mutations when password fill is attempted');
  });

  test('preflight blocks file input fill with FILE_INPUT_NOT_ALLOWED and zero mutations', async () => {
    const { bm, mockPage, mutationsLog, snapshotToken } = createMockFormEnvironment();

    let threw = false;
    try {
      await populateForm(mockPage, bm, {
        expectedSnapshotToken: snapshotToken,
        fields: [
          { name: 'Upload Document', value: 'resume.pdf' }
        ]
      });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'FILE_INPUT_NOT_ALLOWED');
    }

    assert.equal(threw, true);
    assert.equal(mutationsLog.length, 0, 'Zero mutations when file fill is attempted');
  });

  test('preflight blocks hidden input with ACTION_NOT_SUPPORTED_FOR_TARGET and zero mutations', async () => {
    const { bm, mockPage, mutationsLog, snapshotToken } = createMockFormEnvironment();

    let threw = false;
    try {
      await populateForm(mockPage, bm, {
        expectedSnapshotToken: snapshotToken,
        fields: [
          { name: 'csrf', value: 'fake' }
        ]
      });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'ACTION_NOT_SUPPORTED_FOR_TARGET');
    }

    assert.equal(threw, true);
    assert.equal(mutationsLog.length, 0, 'Zero mutations when hidden input fill is attempted');
  });

  test('preflight blocks disabled field with TARGET_DISABLED and zero mutations', async () => {
    const { bm, mockPage, mutationsLog, snapshotToken } = createMockFormEnvironment();

    let threw = false;
    try {
      await populateForm(mockPage, bm, {
        expectedSnapshotToken: snapshotToken,
        fields: [
          { name: 'Disabled Field', value: 'test' }
        ]
      });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'TARGET_DISABLED');
    }

    assert.equal(threw, true);
    assert.equal(mutationsLog.length, 0, 'Zero mutations when disabled field fill is attempted');
  });

  test('preflight blocks readonly field with FIELD_READONLY and zero mutations', async () => {
    const { bm, mockPage, mutationsLog, snapshotToken } = createMockFormEnvironment();

    let threw = false;
    try {
      await populateForm(mockPage, bm, {
        expectedSnapshotToken: snapshotToken,
        fields: [
          { name: 'Readonly Field', value: 'test' }
        ]
      });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'FIELD_READONLY');
    }

    assert.equal(threw, true);
    assert.equal(mutationsLog.length, 0, 'Zero mutations when readonly field fill is attempted');
  });

  test('preflight blocks invalid select option with OPTION_NOT_FOUND and zero mutations', async () => {
    const { bm, mockPage, mutationsLog, snapshotToken } = createMockFormEnvironment();

    let threw = false;
    try {
      await populateForm(mockPage, bm, {
        expectedSnapshotToken: snapshotToken,
        fields: [
          { name: 'Country', value: 'Atlantis' }
        ]
      });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'OPTION_NOT_FOUND');
    }

    assert.equal(threw, true);
    assert.equal(mutationsLog.length, 0, 'Zero mutations when select option is invalid');
  });

  test('multiple forms without formId returns FORM_AMBIGUOUS when fields are shared or ambiguous', async () => {
    const { bm, mockPage, snapshotToken } = createMockFormEnvironment({
      forms: [
        {
          formId: 'form_A',
          name: 'shipping',
          fields: [{ fieldId: 'fld_a1', kind: 'input', type: 'text', name: 'city', label: 'City' }]
        },
        {
          formId: 'form_B',
          name: 'billing',
          fields: [{ fieldId: 'fld_b1', kind: 'input', type: 'text', name: 'city', label: 'City' }]
        }
      ]
    });

    let threw = false;
    try {
      await populateForm(mockPage, bm, {
        expectedSnapshotToken: snapshotToken,
        fields: [{ name: 'City', value: 'Doha' }]
      });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'FORM_AMBIGUOUS');
    }

    assert.equal(threw, true);
  });

  test('truthfully reports remaining required empty fields without submitting', async () => {
    const { bm, mockPage, snapshotToken } = createMockFormEnvironment();

    // Population request omits required 'email'
    const result = await populateForm(mockPage, bm, {
      expectedSnapshotToken: snapshotToken,
      fields: [
        { name: 'Full Name', value: 'John Smith' }
      ]
    });

    assert.equal(result.success, true);
    assert.ok(Array.isArray(result.remainingRequiredFields));
    assert.equal(result.remainingRequiredFields.some(f => f.name === 'email'), true);
    assert.equal(result.validation.valid, false);
  });

  test('safe rollback on mid-operation mutation failure restores prior state', async () => {
    const { bm, mockPage, fieldState, snapshotToken } = createMockFormEnvironment({
      failOnField: 'comments'
    });

    fieldState.fullName = 'Initial';

    let threw = false;
    try {
      await populateForm(mockPage, bm, {
        expectedSnapshotToken: snapshotToken,
        fields: [
          { name: 'Full Name', value: 'Changed Name' },
          { name: 'Comments', value: 'Fail on comments' }
        ]
      });
    } catch (err) {
      threw = true;
    }

    assert.equal(threw, true);
    // Rolled back to initial value
    assert.equal(fieldState.fullName, 'Initial');
  });

  test('privacy: response does not echo raw input values', async () => {
    const { bm, mockPage, snapshotToken } = createMockFormEnvironment();

    const sensitiveString = 'PRIVATE_CONFIDENTIAL_ADDRESS_123';
    const result = await populateForm(mockPage, bm, {
      expectedSnapshotToken: snapshotToken,
      fields: [
        { name: 'Full Name', value: sensitiveString }
      ]
    });

    const json = JSON.stringify(result);
    assert.equal(json.includes(sensitiveString), false, 'Response must not unnecessarily echo the supplied form value');
  });

  test('reports PARTIAL_FORM_UPDATE when rollback cannot restore prior state', async () => {
    const { bm, snapshotToken } = createMockFormEnvironment();

    // Custom mock page where fill succeeds on field 1, fails on field 2, and rollback on field 1 throws
    let fillCount = 0;
    let field1Val = '';
    const failingPage = {
      url: () => 'https://example.com/form',
      evaluate: async () => null,
      evaluateHandle: async (fn, targetField) => {
        return {
          asElement: () => ({
            isConnected: async () => true,
            isDisabled: async () => false,
            inputValue: async () => field1Val,
            isChecked: async () => false,
            fill: async (val) => {
              fillCount++;
              if (fillCount === 1) {
                // First fill succeeds and verifies
                field1Val = val;
                return;
              }
              if (fillCount === 2) {
                // Second fill fails
                throw new Error('Mid-mutation failure on second field');
              }
              // Rollback attempt throws
              throw new Error('Rollback failure on first field');
            }
          })
        };
      }
    };

    let error = null;
    try {
      await populateForm(failingPage, bm, {
        expectedSnapshotToken: snapshotToken,
        fields: [
          { name: 'Full Name', value: 'First Name' },
          { name: 'Email Address', value: 'email@example.com' }
        ]
      });
    } catch (err) {
      error = err;
    }

    assert.ok(error);
    assert.equal(error.code, 'PARTIAL_FORM_UPDATE');
    assert.ok(error.details.mutatedFields.length > 0);
  });

  test('preflight rejects invalid radio choice without modifying state', async () => {
    const { bm, mockPage, snapshotToken, fieldState } = createMockFormEnvironment();

    let error = null;
    try {
      await populateForm(mockPage, bm, {
        expectedSnapshotToken: snapshotToken,
        fields: [
          { name: 'payment', value: 'Cryptocurrency' } // not among ['visa', 'cash']
        ]
      });
    } catch (err) {
      error = err;
    }

    assert.ok(error);
    assert.equal(error.code, 'OPTION_NOT_FOUND');
    assert.equal(fieldState.payment, 'cash', 'Radio state must remain unchanged');
  });

  test('targets specific form by formId when multiple forms exist', async () => {
    const { bm, mockPage, snapshotToken } = createMockFormEnvironment({
      forms: [
        {
          formId: 'form_shipping',
          name: 'shippingForm',
          fields: [
            { fieldId: 'f1', kind: 'input', type: 'text', name: 'address', label: 'Street Address' }
          ]
        },
        {
          formId: 'form_billing',
          name: 'billingForm',
          fields: [
            { fieldId: 'f2', kind: 'input', type: 'text', name: 'address', label: 'Street Address' }
          ]
        }
      ]
    });

    const result = await populateForm(mockPage, bm, {
      formId: 'form_billing',
      expectedSnapshotToken: snapshotToken,
      fields: [
        { name: 'Street Address', value: '456 Billing Ave' }
      ]
    });

    assert.equal(result.success, true);
    assert.equal(result.formId, 'form_billing');
  });

  test('form submission remains strictly prohibited during form population', async () => {
    const { bm, mockPage, snapshotToken } = createMockFormEnvironment();

    let error = null;
    try {
      await populateForm(mockPage, bm, {
        expectedSnapshotToken: snapshotToken,
        fields: [
          { name: 'Submit Order', value: 'click' }
        ]
      });
    } catch (err) {
      error = err;
    }

    assert.ok(error);
    assert.ok(['FIELD_NOT_FOUND', 'TARGET_NOT_FOUND', 'ACTION_NOT_SUPPORTED_FOR_TARGET', 'FORM_SUBMISSION_NOT_AUTHORIZED'].includes(error.code));
  });
});
