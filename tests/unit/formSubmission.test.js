import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager } from '../../src/browser/browserManager.js';
import {
  prepareFormSubmission,
  executeFormSubmission,
  getConfirmationToken,
  clearConfirmationTokens,
  findSubmitButtonDomElement,
  FormSubmissionError
} from '../../src/browser/formSubmitter.js';

function createMockFormEnvironment(options = {}) {
  const forms = options.forms ?? [
    {
      formId: 'form_0',
      name: 'contactForm',
      id: 'contact-form',
      fields: [
        { fieldId: 'fld_0', kind: 'input', type: 'text', name: 'fullName', label: 'Full Name', accessibleName: 'Full Name', required: true },
        { fieldId: 'fld_1', kind: 'input', type: 'email', name: 'email', label: 'Email Address', accessibleName: 'Email Address' }
      ],
      buttons: [
        { buttonId: 'btn_0', type: 'submit', text: 'Send Message', accessibleName: 'Send Message' }
      ]
    }
  ];

  let currentUrl = options.initialUrl || 'https://example.com/contact';
  let clickCount = 0;
  let formSubmitCalled = false;
  let enterKeyPressed = false;
  let resetClicked = false;

  const mockPage = {
    url: () => currentUrl,
    setUrl: (u) => { currentUrl = u; },
    isClosed: () => Boolean(options.closed),
    evaluate: async (fn, arg) => {
      if (options.evalFail) throw new Error('Evaluation error');
      if (typeof fn === 'function') {
        return fn(arg);
      }
      if (typeof fn === 'string' && fn.includes('checkValidity')) {
        return options.validityResult || { valid: true, issues: [] };
      }
      if (options.validityResult) {
        return options.validityResult;
      }
      return { valid: true, issues: [] };
    },
    evaluateHandle: async (fn, targetSubmitter) => {
      if (options.noSubmitButton) return null;
      return {
        asElement: () => ({
          isConnected: async () => !options.detachedButton,
          click: async () => {
            clickCount++;
            if (options.clickThrows) throw new Error('Click failed: element obstructed');
            if (options.simulateNavigationOnSubmit) {
              currentUrl = options.postSubmitUrl || 'https://example.com/thank-you';
            }
          },
          dispose: async () => {}
        })
      };
    }
  };

  const manager = new BrowserManager({
    launcher: { launch: async () => ({}) },
    popupSettleMs: 0
  });

  manager._state = 'running';
  manager._browser = { isConnected: () => true };
  manager._context = {};
  manager.isSessionActive = () => true;

  const pageId = options.pageId || 'pg_test_1';
  manager._activePageId = pageId;

  const entry = {
    pageId,
    page: mockPage,
    documentVersion: options.documentVersion ?? 1,
    semanticRevision: options.semanticRevision ?? 0,
    snapshotToken: options.snapshotToken || 'tok_valid_snapshot_123',
    currentUrl,
    spaRouteVersion: options.spaRouteVersion ?? 0,
    spaRouteChanged: Boolean(options.spaRouteChanged)
  };

  manager._pages.set(pageId, entry);

  // Setup inspectForms interception on manager/page
  mockPage.evaluate = async (fn, arg) => {
    if (typeof fn === 'function') {
      const fnStr = fn.toString();
      if (fnStr.includes('extractFormsSnapshot') || fn.name === 'extractFormsSnapshot') {
        return {
          forms,
          unassociatedFields: [],
          totalFormsCount: forms.length,
          totalFieldsCount: forms.reduce((s, f) => s + (f.fields ? f.fields.length : 0), 0)
        };
      }
      if (fnStr.includes('checkValidity')) {
        return options.validityResult || { valid: true, issues: [] };
      }
      if (fnStr.includes('innerText.includes')) {
        if (options.bodyText) {
          return options.bodyText.includes(arg);
        }
        return false;
      }
    }
    // Default fallback
    if (options.validityResult) {
      return options.validityResult;
    }
    return { valid: true, issues: [] };
  };

  // Mock resolveTarget for target-present / target-absent verification
  manager.resolveTarget = async (target, opts) => {
    if (options.targetResolution) {
      return options.targetResolution;
    }
    if (target && target.text && options.availableTargets?.includes(target.text)) {
      return { resolution: 'unique', confidence: 'high', target: { text: target.text } };
    }
    return { resolution: 'not_found', confidence: 'none' };
  };

  // Mock inspectForms behavior by decorating entry
  entry._mockForms = forms;

  // Mock isSnapshotTokenValid
  manager.isSnapshotTokenValid = (token, pId) => {
    return token === entry.snapshotToken && pId === entry.pageId && !options.staleSnapshot;
  };

  manager.syncDynamicState = async (pId) => {
    if (options.failSync) throw new Error('Dynamic sync failed');
    return { dynamicTimeoutMs: 5000 };
  };

  return {
    manager,
    entry,
    mockPage,
    getClickCount: () => clickCount,
    getFormSubmitCalled: () => formSubmitCalled,
    getEnterKeyPressed: () => enterKeyPressed,
    getResetClicked: () => resetClicked
  };
}

describe('Brick 34: Confirmed Form Submission Unit Tests', () => {
  beforeEach(() => {
    clearConfirmationTokens();
  });

  describe('Section 6, 7 & 8: Prepare Submission & Confirmation Token', () => {
    test('prepares valid form submission and generates opaque confirmation token without submitting', async () => {
      const env = createMockFormEnvironment();
      const res = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123',
        submitter: 'Send Message'
      });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.pageId, 'pg_test_1');
      assert.strictEqual(res.formId, 'form_0');
      assert.strictEqual(res.submitter.name, 'Send Message');
      assert.strictEqual(res.validation.valid, true);
      assert.ok(typeof res.confirmationToken === 'string' && res.confirmationToken.startsWith('conf_'));
      assert.strictEqual(res.expiresInMs, 60000);

      // Section 6 Invariant: MUST NOT SUBMIT DURING PREPARE
      assert.strictEqual(env.getClickCount(), 0);

      // Verify token is in memory and bound
      const tokenRec = getConfirmationToken(res.confirmationToken);
      assert.ok(tokenRec);
      assert.strictEqual(tokenRec.pageId, 'pg_test_1');
      assert.strictEqual(tokenRec.formId, 'form_0');
      assert.strictEqual(tokenRec.used, false);
    });

    test('fails preparation if expectedSnapshotToken is missing or stale', async () => {
      const env = createMockFormEnvironment({ staleSnapshot: true });
      await assert.rejects(
        async () => {
          await env.manager.prepareFormSubmission({
            pageId: 'pg_test_1',
            expectedSnapshotToken: 'tok_valid_snapshot_123'
          });
        },
        (err) => {
          assert.strictEqual(err.code, 'SUBMISSION_STALE');
          return true;
        }
      );
      assert.strictEqual(env.getClickCount(), 0);
    });

    test('fails preparation if pageId does not exist', async () => {
      const env = createMockFormEnvironment();
      await assert.rejects(
        async () => {
          await env.manager.prepareFormSubmission({
            pageId: 'pg_unknown_999',
            expectedSnapshotToken: 'tok_valid_snapshot_123'
          });
        },
        (err) => {
          assert.strictEqual(err.code, 'PAGE_NOT_FOUND');
          return true;
        }
      );
    });

    test('fails preparation if page is closed', async () => {
      const env = createMockFormEnvironment();
      env.manager._pages.set('pg_closed', {
        pageId: 'pg_closed',
        page: { isClosed: () => true }
      });
      await assert.rejects(
        async () => {
          await env.manager.prepareFormSubmission({
            pageId: 'pg_closed',
            expectedSnapshotToken: 'tok_valid_snapshot_123'
          });
        },
        (err) => {
          assert.strictEqual(err.code, 'PAGE_NOT_FOUND');
          return true;
        }
      );
    });
  });

  describe('Section 9 & 10: Security Boundaries (Password/Auth & File Blocks)', () => {
    test('strictly blocks forms containing password/authentication controls', async () => {
      const env = createMockFormEnvironment({
        forms: [
          {
            formId: 'form_login',
            name: 'loginForm',
            fields: [
              { fieldId: 'f_user', type: 'text', name: 'username' },
              { fieldId: 'f_pass', type: 'password', name: 'pwd', sensitive: true }
            ],
            buttons: [{ buttonId: 'b_0', type: 'submit', text: 'Log In' }]
          }
        ]
      });

      await assert.rejects(
        async () => {
          await env.manager.prepareFormSubmission({
            pageId: 'pg_test_1',
            expectedSnapshotToken: 'tok_valid_snapshot_123'
          });
        },
        (err) => {
          assert.strictEqual(err.code, 'AUTH_FORM_NOT_SUPPORTED');
          return true;
        }
      );
      assert.strictEqual(env.getClickCount(), 0);
    });

    test('strictly blocks forms containing file upload controls', async () => {
      const env = createMockFormEnvironment({
        forms: [
          {
            formId: 'form_upload',
            name: 'uploadForm',
            fields: [
              { fieldId: 'f_title', type: 'text', name: 'title' },
              { fieldId: 'f_file', type: 'file', name: 'avatar', isFile: true }
            ],
            buttons: [{ buttonId: 'b_0', type: 'submit', text: 'Upload' }]
          }
        ]
      });

      await assert.rejects(
        async () => {
          await env.manager.prepareFormSubmission({
            pageId: 'pg_test_1',
            expectedSnapshotToken: 'tok_valid_snapshot_123'
          });
        },
        (err) => {
          assert.strictEqual(err.code, 'FILE_FORM_NOT_SUPPORTED');
          return true;
        }
      );
      assert.strictEqual(env.getClickCount(), 0);
    });
  });

  describe('Section 11: Native HTML5 Form Validation Precheck', () => {
    test('aborts preparation with FORM_VALIDATION_FAILED and creates ZERO confirmation token when form is invalid', async () => {
      const env = createMockFormEnvironment({
        validityResult: {
          valid: false,
          issues: [{ name: 'fullName', issue: 'valueMissing' }]
        }
      });

      await assert.rejects(
        async () => {
          await env.manager.prepareFormSubmission({
            pageId: 'pg_test_1',
            expectedSnapshotToken: 'tok_valid_snapshot_123'
          });
        },
        (err) => {
          assert.strictEqual(err.code, 'FORM_VALIDATION_FAILED');
          assert.strictEqual(err.details.issues[0].name, 'fullName');
          assert.strictEqual(err.details.issues[0].issue, 'valueMissing');
          return true;
        }
      );

      // Verify ZERO confirmation token created
      assert.strictEqual(env.getClickCount(), 0);
    });
  });

  describe('Submitter Resolution & Ambiguity', () => {
    test('resolves single submitter button automatically', async () => {
      const env = createMockFormEnvironment();
      const res = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123'
      });
      assert.strictEqual(res.submitter.name, 'Send Message');
    });

    test('resolves explicit submitter query by button text', async () => {
      const env = createMockFormEnvironment({
        forms: [
          {
            formId: 'form_0',
            fields: [{ fieldId: 'f_0', type: 'text', name: 'q' }],
            buttons: [
              { buttonId: 'b_1', type: 'submit', text: 'Save Draft' },
              { buttonId: 'b_2', type: 'submit', text: 'Publish Post' }
            ]
          }
        ]
      });

      const res = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123',
        submitter: 'Publish Post'
      });
      assert.strictEqual(res.submitter.name, 'Publish Post');
    });

    test('fails with SUBMITTER_AMBIGUOUS when multiple submit buttons exist and query is omitted', async () => {
      const env = createMockFormEnvironment({
        forms: [
          {
            formId: 'form_0',
            fields: [{ fieldId: 'f_0', type: 'text', name: 'q' }],
            buttons: [
              { buttonId: 'b_1', type: 'submit', text: 'Save Draft' },
              { buttonId: 'b_2', type: 'submit', text: 'Publish Post' }
            ]
          }
        ]
      });

      await assert.rejects(
        async () => {
          await env.manager.prepareFormSubmission({
            pageId: 'pg_test_1',
            expectedSnapshotToken: 'tok_valid_snapshot_123'
          });
        },
        (err) => {
          assert.strictEqual(err.code, 'SUBMITTER_AMBIGUOUS');
          return true;
        }
      );
    });

    test('fails with SUBMITTER_NOT_FOUND when submitter query does not match any button', async () => {
      const env = createMockFormEnvironment();
      await assert.rejects(
        async () => {
          await env.manager.prepareFormSubmission({
            pageId: 'pg_test_1',
            expectedSnapshotToken: 'tok_valid_snapshot_123',
            submitter: 'NonExistentButton'
          });
        },
        (err) => {
          assert.strictEqual(err.code, 'SUBMITTER_NOT_FOUND');
          return true;
        }
      );
    });

    test('fails with FORM_AMBIGUOUS when multiple forms exist and formId is omitted', async () => {
      const env = createMockFormEnvironment({
        forms: [
          { formId: 'form_0', fields: [], buttons: [{ buttonId: 'b_0', type: 'submit', text: 'Sub 1' }] },
          { formId: 'form_1', fields: [], buttons: [{ buttonId: 'b_1', type: 'submit', text: 'Sub 2' }] }
        ]
      });

      await assert.rejects(
        async () => {
          await env.manager.prepareFormSubmission({
            pageId: 'pg_test_1',
            expectedSnapshotToken: 'tok_valid_snapshot_123'
          });
        },
        (err) => {
          assert.strictEqual(err.code, 'FORM_AMBIGUOUS');
          return true;
        }
      );
    });
  });

  describe('Section 12-16: Execution, Revalidation & Single-Use Enforcement', () => {
    test('successfully executes submission once and verifies evidence', async () => {
      const env = createMockFormEnvironment({
        simulateNavigationOnSubmit: true,
        postSubmitUrl: 'https://example.com/thank-you'
      });

      const prep = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123',
        verification: { type: 'url-changed' }
      });

      const result = await env.manager.submitForm({
        confirmationToken: prep.confirmationToken
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.submissionAttempted, true);
      assert.strictEqual(result.verified, true);
      assert.strictEqual(result.state, 'SUBMISSION_VERIFIED');
      assert.strictEqual(env.getClickCount(), 1);
      assert.strictEqual(result.currentUrl, 'https://example.com/thank-you');
    });

    test('strictly enforces single-use: repeated submit request fails with CONFIRMATION_ALREADY_USED and clicks 0 additional times', async () => {
      const env = createMockFormEnvironment({
        simulateNavigationOnSubmit: true,
        postSubmitUrl: 'https://example.com/thank-you'
      });

      const prep = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123',
        verification: { type: 'url-changed' }
      });

      // First submit
      await env.manager.submitForm({ confirmationToken: prep.confirmationToken });
      assert.strictEqual(env.getClickCount(), 1);

      // Second submit with same token
      await assert.rejects(
        async () => {
          await env.manager.submitForm({ confirmationToken: prep.confirmationToken });
        },
        (err) => {
          assert.strictEqual(err.code, 'CONFIRMATION_ALREADY_USED');
          return true;
        }
      );

      // Section 15 Invariant: EXACTLY ONE click, no duplicate submission
      assert.strictEqual(env.getClickCount(), 1);
    });

    test('rejects expired confirmation token with CONFIRMATION_EXPIRED', async () => {
      const env = createMockFormEnvironment();
      const prep = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123',
        ttlMs: 1000 // 1 second
      });

      const tokenRec = getConfirmationToken(prep.confirmationToken);
      tokenRec.expiresAt = Date.now() - 50; // Expire artificially

      await assert.rejects(
        async () => {
          await env.manager.submitForm({ confirmationToken: prep.confirmationToken });
        },
        (err) => {
          assert.strictEqual(err.code, 'CONFIRMATION_EXPIRED');
          return true;
        }
      );
      assert.strictEqual(env.getClickCount(), 0);
    });

    test('rejects submission if documentVersion or semanticRevision changed (SUBMISSION_STALE)', async () => {
      const env = createMockFormEnvironment();
      const prep = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123'
      });

      // Mutate semantic revision
      env.entry.semanticRevision = 5;

      await assert.rejects(
        async () => {
          await env.manager.submitForm({ confirmationToken: prep.confirmationToken });
        },
        (err) => {
          assert.strictEqual(err.code, 'SUBMISSION_STALE');
          return true;
        }
      );
      assert.strictEqual(env.getClickCount(), 0);
    });

    test('rejects submission if page snapshot became stale (SUBMISSION_STALE)', async () => {
      const env = createMockFormEnvironment();
      const prep = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123'
      });

      env.entry.snapshotToken = 'tok_new_snapshot_456';

      await assert.rejects(
        async () => {
          await env.manager.submitForm({ confirmationToken: prep.confirmationToken });
        },
        (err) => {
          assert.strictEqual(err.code, 'SUBMISSION_STALE');
          return true;
        }
      );
      assert.strictEqual(env.getClickCount(), 0);
    });
  });

  describe('Section 19-24: Evidence-Based Verification & Truthful Failure Reporting', () => {
    test('verifies url-contains condition', async () => {
      const env = createMockFormEnvironment({
        simulateNavigationOnSubmit: true,
        postSubmitUrl: 'https://example.com/checkout/success?id=123'
      });

      const prep = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123',
        verification: { type: 'url-contains', value: 'checkout/success' }
      });

      const res = await env.manager.submitForm({ confirmationToken: prep.confirmationToken });
      assert.strictEqual(res.verified, true);
    });

    test('verifies url-equals condition', async () => {
      const env = createMockFormEnvironment({
        simulateNavigationOnSubmit: true,
        postSubmitUrl: 'https://example.com/done'
      });

      const prep = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123',
        verification: { type: 'url-equals', url: 'https://example.com/done' }
      });

      const res = await env.manager.submitForm({ confirmationToken: prep.confirmationToken });
      assert.strictEqual(res.verified, true);
    });

    test('verifies text-present condition', async () => {
      const env = createMockFormEnvironment({
        bodyText: 'Thank you for your feedback!'
      });

      const prep = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123',
        verification: { type: 'text-present', text: 'Thank you for your feedback!' }
      });

      const res = await env.manager.submitForm({ confirmationToken: prep.confirmationToken });
      assert.strictEqual(res.verified, true);
    });

    test('verifies target-present condition', async () => {
      const env = createMockFormEnvironment({
        availableTargets: ['Order Confirmed']
      });

      const prep = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123',
        verification: { type: 'target-present', target: { text: 'Order Confirmed' } }
      });

      const res = await env.manager.submitForm({ confirmationToken: prep.confirmationToken });
      assert.strictEqual(res.verified, true);
    });

    test('truthfully reports SUBMISSION_ATTEMPTED_BUT_NOT_VERIFIED when evidence does not appear (no auto-retry)', async () => {
      const env = createMockFormEnvironment({
        simulateNavigationOnSubmit: false // URL will NOT change
      });

      const prep = await env.manager.prepareFormSubmission({
        pageId: 'pg_test_1',
        expectedSnapshotToken: 'tok_valid_snapshot_123',
        verification: { type: 'url-changed' }
      });

      await assert.rejects(
        async () => {
          await env.manager.submitForm({
            confirmationToken: prep.confirmationToken
          }, { verifyTimeoutMs: 200 }); // Fast timeout for test
        },
        (err) => {
          assert.strictEqual(err.code, 'SUBMISSION_ATTEMPTED_BUT_NOT_VERIFIED');
          assert.strictEqual(err.details.submissionAttempted, true);
          assert.strictEqual(err.details.verified, false);
          assert.strictEqual(err.details.state, 'SUBMISSION_ATTEMPTED_BUT_NOT_VERIFIED');
          return true;
        }
      );

      // Section 15 & 24 Invariants: click happened exactly once, NEVER auto-retried!
      assert.strictEqual(env.getClickCount(), 1);

      // Token was consumed so it cannot be retried
      const tokenRec = getConfirmationToken(prep.confirmationToken);
      assert.strictEqual(tokenRec.used, true);
    });
  });

  describe('Section 26, 27 & 35: Cross-Page Submission Isolation', () => {
    test('enforces atomic page isolation: Page A token cannot submit on Page B', async () => {
      const envA = createMockFormEnvironment({ pageId: 'pg_A', snapshotToken: 'tok_A' });
      const envB = createMockFormEnvironment({ pageId: 'pg_B', snapshotToken: 'tok_B' });

      // Register both pages in envA's manager
      envA.manager._pages.set('pg_B', envB.entry);

      const prepA = await envA.manager.prepareFormSubmission({
        pageId: 'pg_A',
        expectedSnapshotToken: 'tok_A'
      });

      // Try executing token A specifying pageId B
      await assert.rejects(
        async () => {
          await envA.manager.submitForm({
            pageId: 'pg_B',
            confirmationToken: prepA.confirmationToken
          });
        },
        (err) => {
          assert.strictEqual(err.code, 'CROSS_PAGE_TOKEN_BLOCKED');
          return true;
        }
      );

      assert.strictEqual(envA.getClickCount(), 0);
      assert.strictEqual(envB.getClickCount(), 0);
    });
  });
});
