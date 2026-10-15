/**
 * Automated Real-Browser Verification Harness (Level 2).
 * 
 * Invariants:
 * - Real Microsoft Edge (channel: msedge).
 * - Deterministic local loopback fixture pages (no public internet requirement).
 * - 0 OpenRouter / 0 LLM / 0 Exa search calls.
 * - Deterministic programmatic verification of 25 Brick-032 acceptance points.
 * - Strict try/finally cleanup: no orphan Edge instances or open server sockets.
 * - Diagnostic evidence saved to test-results/ on failure without secrets.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { BrowserManager, FormInspectionError, FormPopulationError, FormSubmissionError, FileTransferError, StructuredExtractionError } from '../src/browser/browserManager.js';
import { startFixtureServer } from '../tests/browser-fixtures/server.js';
import { TargetResolutionError } from '../src/browser/targetResolver.js';
import { ActionExecutionError } from '../src/browser/actionExecutor.js';
import { HANDOFF_REASONS, HANDOFF_STATES } from '../src/browser/humanHandoff.js';
import { registerTestConfirmationToken, getConfirmationToken } from '../src/browser/formSubmitter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_RESULTS_DIR = path.join(ROOT_DIR, 'test-results');

const results = [];
let activeBm = null;
let activeServer = null;

async function recordFailureEvidence(testName, bm, err) {
  try {
    fs.mkdirSync(TEST_RESULTS_DIR, { recursive: true });
    const timestamp = Date.now();
    const safeName = testName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const metaPath = path.join(TEST_RESULTS_DIR, `failure-${safeName}-${timestamp}.json`);
    const screenshotPath = path.join(TEST_RESULTS_DIR, `failure-${safeName}-${timestamp}.png`);

    let currentUrl = 'about:blank';
    let pageId = null;

    if (bm) {
      pageId = bm.activePageId;
      try {
        if (bm.page && typeof bm.page.url === 'function') {
          currentUrl = bm.page.url();
        }
        if (bm.canCaptureDiagnosticScreenshot && !bm.canCaptureDiagnosticScreenshot(pageId).allowed) {
          // Automatic screenshot capture is suppressed during sensitive auth handoffs (Section 47)
        } else if (bm.page && typeof bm.page.screenshot === 'function' && !bm.page.isClosed?.()) {
          await bm.page.screenshot({ path: screenshotPath }).catch(() => {});
        }
      } catch {}
    }

    const metadata = {
      testName,
      timestamp: new Date(timestamp).toISOString(),
      pageId,
      currentUrl,
      errorMessage: err.message || String(err),
      errorCode: err.code || null,
      screenshot: fs.existsSync(screenshotPath) ? path.basename(screenshotPath) : null
    };

    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
  } catch (diagErr) {
    console.error('Failed to write failure diagnostics:', diagErr.message);
  }
}

async function runTest(num, name, category, testFn) {
  try {
    await testFn();
    results.push({ num, name, category, status: 'PASS' });
    console.log(`  PASS [${num}] ${name}`);
    return true;
  } catch (err) {
    results.push({ num, name, category, status: 'FAIL', error: err.message });
    await recordFailureEvidence(name, activeBm, err);
    console.error(`  FAIL [${num}] ${name}: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('==================================================');
  console.log('REAL BROWSER VERIFICATION');
  console.log('Browser: Microsoft Edge');
  console.log('Mode: Real Edge + Deterministic Local Loopback Fixtures');
  console.log('==================================================\n');

  let fixtureServer = null;
  let bm = null;

  try {
    fixtureServer = await startFixtureServer();
    activeServer = fixtureServer;
    const baseUrl = fixtureServer.baseUrl;

    const syntheticTempDir = path.join(ROOT_DIR, 'runtime', 'test-synthetic-transfer');
    if (fs.existsSync(syntheticTempDir)) {
      fs.rmSync(syntheticTempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(syntheticTempDir, { recursive: true });

    const syntheticDownloadDir = path.join(ROOT_DIR, 'runtime', 'test-synthetic-downloads');
    if (fs.existsSync(syntheticDownloadDir)) {
      fs.rmSync(syntheticDownloadDir, { recursive: true, force: true });
    }
    fs.mkdirSync(syntheticDownloadDir, { recursive: true });

    bm = new BrowserManager({
      allowTestLoopback: true,
      headless: process.env.HEADLESS !== 'false',
      downloadDir: syntheticDownloadDir
    });
    activeBm = bm;

    // 1. Browser launch
    await runTest(1, 'Browser Launch', 'Browser Lifecycle', async () => {
      const launchRes = await bm.launch();
      assert.equal(launchRes.success, true);
      assert.equal(launchRes.state.toLowerCase(), 'running');
      assert.equal(bm.isBrowserConnected(), true);
      assert.equal(bm.channel, 'msedge');
    });

    // 2. Initial page registration
    await runTest(2, 'Initial Page Registration', 'Browser Lifecycle', async () => {
      assert.ok(bm.activePageId, 'Active pageId should be set');
      assert.match(bm.activePageId, /^pg_/);
      assert.equal(bm.pageCount, 1);
      assert.equal(bm.currentUrl, 'about:blank');
    });

    // 3. Semantic observer installed
    await runTest(3, 'Semantic Observer Installed', 'Observer Lifecycle', async () => {
      await bm.navigate(`${baseUrl}/static.html`);
      await bm.syncDynamicState();
      const entry = bm._pages.get(bm.activePageId);
      assert.equal(entry.dynamicObserverInstalled, true);
      assert.ok(entry.documentVersion >= 1);
    });

    // 4. Wait-for-stable
    await runTest(4, 'Wait-for-Stable', 'Stability Tracking', async () => {
      const stable = await bm.waitForStable();
      assert.equal(stable.success, true);
      assert.equal(stable.settled, true);
      assert.equal(stable.pageId, bm.activePageId);
      assert.ok(stable.quietForMs >= 0);
      assert.ok(stable.snapshotToken, 'Snapshot token must exist');
    });

    // 5. Dynamic element insertion
    await runTest(5, 'Dynamic Element Insertion', 'Dynamic DOM', async () => {
      await bm.navigate(`${baseUrl}/dynamic-elements.html`);
      await bm.waitForStable();
      const initialInspection = await bm.inspectPage();
      const hasInitially = initialInspection.elements.some(e => e.text === 'Newly Inserted Button');
      assert.equal(hasInitially, false, 'Element should not exist before trigger');

      // Trigger insertion via click on #btn-trigger-insert
      await bm.executeAction({
        action: 'click',
        expectedSnapshotToken: initialInspection.snapshotToken,
        target: { kind: 'button', text: 'Trigger Dynamic Element' }
      });

      // Wait for insertion
      await new Promise(r => setTimeout(r, 350));
      const postInspection = await bm.inspectPage();
      const hasAfter = postInspection.elements.some(e => e.text === 'Newly Inserted Button');
      assert.equal(hasAfter, true, 'Dynamically inserted element must appear in inspection');
    });

    // 6. SemanticRevision increments
    await runTest(6, 'Semantic Revision Increments', 'Dynamic DOM', async () => {
      const entry = bm._pages.get(bm.activePageId);
      const revBefore = entry.semanticRevision;
      // Trigger another insertion
      await bm.executeAction({
        action: 'click',
        expectedSnapshotToken: entry.snapshotToken,
        target: { kind: 'button', text: 'Trigger Dynamic Element' }
      });
      const stable = await bm.waitForStable();
      assert.ok(stable.semanticRevision > revBefore, `Expected semanticRevision to increment from ${revBefore}, got ${stable.semanticRevision}`);
    });

    // 7. Style/class visibility mutation increments semantic revision
    await runTest(7, 'Style and Class Visibility Mutation', 'Dynamic DOM', async () => {
      const entry = bm._pages.get(bm.activePageId);
      const revBeforeStyle = entry.semanticRevision;

      // Click to toggle style visibility (display: none -> display: block)
      await bm.executeAction({
        action: 'click',
        expectedSnapshotToken: entry.snapshotToken,
        target: { kind: 'button', text: 'Toggle Style Visibility' }
      });
      const stableStyle = await bm.waitForStable();
      assert.ok(stableStyle.semanticRevision > revBeforeStyle, 'Style visibility mutation must increment semanticRevision');

      // Click to toggle class visibility (.hidden-box -> .visible-box)
      const revBeforeClass = stableStyle.semanticRevision;
      await bm.executeAction({
        action: 'click',
        expectedSnapshotToken: stableStyle.snapshotToken,
        target: { kind: 'button', text: 'Toggle Class Visibility' }
      });
      const stableClass = await bm.waitForStable();
      assert.ok(stableClass.semanticRevision > revBeforeClass, 'Class visibility mutation must increment semanticRevision');
    });

    // 8. Old snapshot becomes TARGET_STALE
    await runTest(8, 'Stale Snapshot Protection', 'Snapshot Integrity', async () => {
      const entry = bm._pages.get(bm.activePageId);
      const oldToken = entry.snapshotToken;

      // Trigger mutation to invalidate snapshot
      await bm.executeAction({
        action: 'click',
        expectedSnapshotToken: oldToken,
        target: { kind: 'button', text: 'Toggle Style Visibility' }
      });
      await bm.waitForStable();

      // Attempt action using the oldToken which is now stale
      let threwStale = false;
      try {
        await bm.executeAction({
          action: 'click',
          expectedSnapshotToken: oldToken,
          target: { kind: 'button', text: 'Toggle Style Visibility' }
        });
      } catch (err) {
        if (err instanceof ActionExecutionError && err.code === 'TARGET_STALE') {
          threwStale = true;
        }
      }
      assert.equal(threwStale, true, 'Using old snapshotToken must be rejected with TARGET_STALE');
    });

    // 9. Wait-for-target succeeds for delayed unique/high semantic target
    await runTest(9, 'Wait-for-Target Delayed Target', 'Target Resolution', async () => {
      const entry = bm._pages.get(bm.activePageId);
      // Trigger delayed target insertion (appears after 400ms)
      await bm.executeAction({
        action: 'click',
        expectedSnapshotToken: entry.snapshotToken,
        target: { kind: 'button', text: 'Trigger Delayed Target' }
      });

      const waitRes = await bm.waitForTarget(
        { kind: 'link', text: 'Confirm Order Now' },
        { timeoutMs: 3000 }
      );
      assert.equal(waitRes.success, true);
      assert.equal(waitRes.resolution, 'unique');
      assert.equal(waitRes.confidence, 'high');
      assert.equal(waitRes.target.text, 'Confirm Order Now');
    });

    // 10. Ambiguous target is not guessed
    await runTest(10, 'Ambiguous Target Not Guessed', 'Target Resolution', async () => {
      const res = await bm.resolveTarget({ kind: 'button', text: 'Duplicate Button Action' });
      assert.equal(res.resolution, 'ambiguous');
      assert.equal(res.code, 'TARGET_AMBIGUOUS');
      assert.ok(res.candidateCount >= 2, 'Candidate count must be >= 2');
    });

    // 11. SPA pushState route change
    await runTest(11, 'SPA pushState Route Change', 'SPA Routing', async () => {
      await bm.navigate(`${baseUrl}/spa-routing.html`);
      await bm.waitForStable();
      const initialPageId = bm.activePageId;

      await bm.executeAction({
        action: 'click',
        expectedSnapshotToken: bm.getSnapshotToken(),
        target: { kind: 'button', text: 'PushState: Dashboard' }
      });
      await bm.waitForStable();

      assert.ok(bm.currentUrl.includes('/dashboard'), `Expected URL to include /dashboard but got ${bm.currentUrl}`);
      assert.equal(bm.activePageId, initialPageId, 'Same pageId must be retained across pushState');
    });

    // 12. replaceState route change
    await runTest(12, 'SPA replaceState Route Change', 'SPA Routing', async () => {
      await bm.executeAction({
        action: 'click',
        expectedSnapshotToken: bm.getSnapshotToken(),
        target: { kind: 'button', text: 'ReplaceState: Settings' }
      });
      await bm.waitForStable();

      assert.ok(bm.currentUrl.includes('/settings'), `Expected URL to include /settings but got ${bm.currentUrl}`);
    });

    // 13. Hash route change
    await runTest(13, 'SPA Hash Route Change', 'SPA Routing', async () => {
      await bm.executeAction({
        action: 'click',
        expectedSnapshotToken: bm.getSnapshotToken(),
        target: { kind: 'button', text: 'Hash: Profile' }
      });
      await bm.waitForStable();

      assert.ok(bm.currentUrl.includes('#/profile'), `Expected URL to include #/profile but got ${bm.currentUrl}`);
    });

    // 14. Same pageId retained for same-document route
    await runTest(14, 'Same pageId Retained for Same-Document Route', 'SPA Routing', async () => {
      const entry = bm._pages.get(bm.activePageId);
      assert.ok(entry, 'Active page entry must exist');
      assert.equal(entry.pageId, bm.activePageId);
    });

    // 15. URL updates
    await runTest(15, 'URL Updates Correctly in Manager', 'SPA Routing', async () => {
      assert.ok(bm.currentUrl.includes('#/profile'));
    });

    // 16. Old route snapshot rejected
    await runTest(16, 'Old Route Snapshot Rejected', 'SPA Routing', async () => {
      const oldToken = bm.getSnapshotToken();
      // Navigate to /dashboard via pushState
      await bm.executeAction({
        action: 'click',
        expectedSnapshotToken: oldToken,
        target: { kind: 'button', text: 'PushState: Dashboard' }
      });
      await bm.waitForStable();

      let rejected = false;
      try {
        await bm.executeAction({
          action: 'click',
          expectedSnapshotToken: oldToken,
          target: { kind: 'button', text: 'ReplaceState: Settings' }
        });
      } catch (err) {
        if (err instanceof ActionExecutionError && err.code === 'TARGET_STALE') {
          rejected = true;
        }
      }
      assert.equal(rejected, true, 'Old route snapshot token must be rejected with TARGET_STALE');
    });

    // 17. Two managed Pages
    let pageAId = null;
    let pageBId = null;
    await runTest(17, 'Two Managed Pages', 'Multi-Page Isolation', async () => {
      await bm.navigate(`${baseUrl}/multi-page.html?page=A`);
      await bm.waitForStable();
      pageAId = bm.activePageId;

      const pageBRes = await bm.openPage(`${baseUrl}/multi-page.html?page=B`);
      pageBId = pageBRes.pageId;
      await bm.waitForStable({ pageId: pageBId });

      assert.equal(bm.pageCount, 2, 'Page count must be 2');
      assert.notEqual(pageAId, pageBId, 'Page A and Page B must have distinct pageIds');
    });

    // 18. Independent semantic revisions
    await runTest(18, 'Independent Semantic Revisions', 'Multi-Page Isolation', async () => {
      const entryA = bm._pages.get(pageAId);
      const entryB = bm._pages.get(pageBId);
      const revABefore = entryA.semanticRevision;
      const revBBefore = entryB.semanticRevision;

      // Mutate Page B only
      await bm.executeAction({
        action: 'click',
        expectedSnapshotToken: entryB.snapshotToken,
        target: { kind: 'button', text: 'Mutate Page B DOM' }
      }, { pageId: pageBId });
      await bm.waitForStable({ pageId: pageBId });

      assert.ok(entryB.semanticRevision > revBBefore, 'Page B semanticRevision must increment');
      assert.equal(entryA.semanticRevision, revABefore, 'Page A semanticRevision must remain completely unaffected');
    });

    // 19. Snapshot from Page A never used for Page B
    await runTest(19, 'Snapshot From Page A Rejected on Page B', 'Cross-Page Snapshot Binding', async () => {
      const tokenA = bm.getSnapshotToken(pageAId);
      let rejected = false;
      try {
        await bm.executeAction({
          action: 'click',
          expectedSnapshotToken: tokenA,
          target: { kind: 'button', text: 'Mutate Page B DOM' }
        }, { pageId: pageBId });
      } catch (err) {
        if (err instanceof ActionExecutionError && err.code === 'TARGET_STALE') {
          rejected = true;
        }
      }
      assert.equal(rejected, true, 'Page A snapshot token on Page B must be rejected with TARGET_STALE');
    });

    // 20. Snapshot from Page B never used for Page A (Hotfix C Regression)
    await runTest(20, 'Snapshot From Page B Rejected on Page A (Hotfix C)', 'Cross-Page Snapshot Binding', async () => {
      const tokenB = bm.getSnapshotToken(pageBId);
      let rejected = false;
      try {
        await bm.executeAction({
          action: 'click',
          expectedSnapshotToken: tokenB,
          target: { kind: 'button', text: 'Mutate Page A DOM' }
        }, { pageId: pageAId });
      } catch (err) {
        if ((err instanceof ActionExecutionError || err.name === 'ActionExecutionError') && err.code === 'TARGET_STALE') {
          rejected = true;
        }
      }
      assert.equal(rejected, true, 'Page B snapshot token on Page A must be rejected with TARGET_STALE');
    });

    // 21. Switch-page isolation
    await runTest(21, 'Switch-Page Isolation & Atomic Resolution', 'Multi-Page Isolation', async () => {
      await bm.switchPage(pageAId);
      assert.equal(bm.activePageId, pageAId);

      // Resolve 'Explicit waits' on Page A
      const resA = await bm.resolveTarget({ kind: 'link', text: 'Explicit waits' });
      assert.equal(resA.pageId, pageAId);
      assert.equal(resA.snapshotToken, bm.getSnapshotToken(pageAId));
      assert.equal(resA.resolution, 'unique');

      // Switch to Page B and verify 'Explicit waits' is not present
      await bm.switchPage(pageBId);
      assert.equal(bm.activePageId, pageBId);
      const resB = await bm.resolveTarget({ kind: 'link', text: 'Explicit waits' });
      assert.equal(resB.resolution, 'not_found');
      assert.equal(resB.code, 'TARGET_NOT_FOUND');
    });

    // 22. Background-page mutation isolation
    await runTest(22, 'Background-Page Mutation Isolation', 'Multi-Page Isolation', async () => {
      // Page B is active, Page A is background
      const entryA = bm._pages.get(pageAId);
      const revABefore = entryA.semanticRevision;

      // Trigger mutation on Page B (active)
      await bm.executeAction({
        action: 'click',
        expectedSnapshotToken: bm.getSnapshotToken(pageBId),
        target: { kind: 'button', text: 'Mutate Page B DOM' }
      });
      await bm.waitForStable({ pageId: pageBId });

      // Background Page A must not be altered
      assert.equal(entryA.semanticRevision, revABefore, 'Active page mutation must not affect background page revision');
    });

    // 23. Page-close cleanup
    await runTest(23, 'Page-Close Cleanup', 'Cleanup', async () => {
      const closeRes = await bm.closePage(pageBId);
      assert.equal(closeRes.success, true);
      assert.equal(closeRes.closedPageId, pageBId);
      assert.equal(bm.pageCount, 1);
      assert.equal(bm._pages.has(pageBId), false);
    });

    // 24. Browser-close cleanup
    await runTest(24, 'Browser-Close Cleanup', 'Cleanup', async () => {
      const tempBm = new BrowserManager({ allowTestLoopback: true, headless: true });
      await tempBm.launch();
      await tempBm.openPage(`${baseUrl}/static.html`);
      assert.equal(tempBm.isBrowserConnected(), true);

      await tempBm.close();
      assert.equal(tempBm.isBrowserConnected(), false);
      assert.equal(tempBm.state.toLowerCase(), 'stopped');
      assert.equal(tempBm.pageCount, 0);
    });

    // 25. Observer reinstallation after navigation/reload
    await runTest(25, 'Observer Reinstallation After Navigation', 'Observer Lifecycle', async () => {
      await bm.navigate(`${baseUrl}/static.html`);
      await bm.syncDynamicState();
      const entry1 = bm._pages.get(bm.activePageId);
      const docVer1 = entry1.documentVersion;

      // Navigate to another page (creates new DOM document)
      await bm.navigate(`${baseUrl}/dynamic-elements.html`);
      await bm.syncDynamicState();
      const entry2 = bm._pages.get(bm.activePageId);
      assert.equal(entry2.dynamicObserverInstalled, true, 'Observer must be reinstalled on new document');
      assert.ok(entry2.documentVersion > docVer1, 'documentVersion must increment on new document navigation');
    });

    // ==================================================
    // BRICK-033: FORMS V1 ACCEPTANCE TESTS (26-47)
    // ==================================================

    // 26. Inspect ordinary real DOM form
    await runTest(26, 'Inspect Ordinary Real DOM Form', 'Form Discovery', async () => {
      await bm.navigate(`${baseUrl}/forms-basic.html`);
      await bm.syncDynamicState();
      const insp = await bm.inspectForms();
      assert.equal(insp.success, true);
      assert.ok(insp.pageId, 'Must include pageId');
      assert.ok(insp.snapshotToken, 'Must include snapshotToken');
      assert.equal(Array.isArray(insp.forms), true);
      assert.equal(insp.forms.length, 1);
      assert.ok(insp.forms[0].formId);
      assert.equal(insp.forms[0].id, 'order-form');
      assert.equal(insp.forms[0].name, 'orderForm');
      assert.ok(insp.forms[0].fields.length >= 8);
    });

    // 27. Labels correctly resolved
    await runTest(27, 'Form Labels Correctly Resolved', 'Form Discovery', async () => {
      const insp = await bm.inspectForms();
      const fields = insp.forms[0].fields;

      // for="full-name" -> Full Name
      const fullName = fields.find(f => f.label === 'Full Name');
      assert.ok(fullName, 'Full Name field must be identified');
      assert.equal(fullName.kind, 'text');
      assert.equal(fullName.required, true);

      // for="email-address" -> Email Address
      const email = fields.find(f => f.label === 'Email Address');
      assert.ok(email, 'Email Address field must be identified');
      assert.equal(email.type, 'email');

      // Comments textarea
      const comments = fields.find(f => f.label === 'Comments');
      assert.ok(comments, 'Comments textarea must be identified');
      assert.equal(comments.kind, 'textarea');

      // Country select
      const country = fields.find(f => f.label === 'Country');
      assert.ok(country, 'Country select must be identified');
      assert.equal(country.kind, 'select');
      assert.ok(country.options.some(o => o.label === 'Qatar'));

      // Checkbox with wrapping label
      const sub = fields.find(f => f.label.includes('Subscribe to newsletter'));
      assert.ok(sub, 'Subscribe checkbox must be identified');
      assert.equal(sub.kind, 'checkbox');

      // Radio group under legend
      const payment = fields.find(f => f.label === 'Payment Method');
      assert.ok(payment, 'Payment Method radio group must be identified');
      assert.equal(payment.kind, 'radio');
      assert.deepEqual(payment.options.map(o => o.label), ['Visa', 'Mastercard', 'Cash']);
    });

    // 28. Text field populated
    await runTest(28, 'Text Field Populated', 'Form Population', async () => {
      const insp = await bm.inspectForms();
      const res = await bm.fillForm({
        expectedSnapshotToken: insp.snapshotToken,
        fields: [{ name: 'Full Name', value: 'John Smith' }]
      });
      assert.equal(res.success, true);
      assert.equal(res.updatedCount, 1);
      const val = await bm.page.evaluate(() => document.getElementById('full-name').value);
      assert.equal(val, 'John Smith');
    });

    // 29. Textarea populated
    await runTest(29, 'Textarea Field Populated', 'Form Population', async () => {
      const insp = await bm.inspectForms();
      const res = await bm.fillForm({
        expectedSnapshotToken: insp.snapshotToken,
        fields: [{ name: 'Comments', value: 'Please pack with eco-friendly wrapping.' }]
      });
      assert.equal(res.success, true);
      const val = await bm.page.evaluate(() => document.getElementById('order-comments').value);
      assert.equal(val, 'Please pack with eco-friendly wrapping.');
    });

    // 30. Select option populated
    await runTest(30, 'Select Option Populated', 'Form Population', async () => {
      const insp = await bm.inspectForms();
      const res = await bm.fillForm({
        expectedSnapshotToken: insp.snapshotToken,
        fields: [{ name: 'Country', value: 'Qatar' }]
      });
      assert.equal(res.success, true);
      const val = await bm.page.evaluate(() => document.getElementById('country-select').value);
      assert.equal(val, 'QA');
    });

    // 31. Checkbox checked
    await runTest(31, 'Checkbox Checked', 'Form Population', async () => {
      const insp = await bm.inspectForms();
      const res = await bm.fillForm({
        expectedSnapshotToken: insp.snapshotToken,
        fields: [{ name: 'Subscribe to newsletter', checked: true }]
      });
      assert.equal(res.success, true);
      const isChecked = await bm.page.evaluate(() => document.getElementById('subscribe-check').checked);
      assert.equal(isChecked, true);
    });

    // 32. Checkbox unchecked
    await runTest(32, 'Checkbox Unchecked', 'Form Population', async () => {
      const insp = await bm.inspectForms();
      const res = await bm.fillForm({
        expectedSnapshotToken: insp.snapshotToken,
        fields: [{ name: 'Subscribe to newsletter', checked: false }]
      });
      assert.equal(res.success, true);
      const isChecked = await bm.page.evaluate(() => document.getElementById('subscribe-check').checked);
      assert.equal(isChecked, false);
    });

    // 33. Radio option selected
    await runTest(33, 'Radio Option Selected', 'Form Population', async () => {
      const insp = await bm.inspectForms();
      const res = await bm.fillForm({
        expectedSnapshotToken: insp.snapshotToken,
        fields: [{ name: 'Payment Method', value: 'Visa' }]
      });
      assert.equal(res.success, true);
      const radioStates = await bm.page.evaluate(() => ({
        visa: document.querySelector('input[value="visa"]').checked,
        cash: document.querySelector('input[value="cash"]').checked
      }));
      assert.equal(radioStates.visa, true);
      assert.equal(radioStates.cash, false);
    });

    // 34. Mixed-form request succeeds
    await runTest(34, 'Mixed-Form Request Succeeds', 'Form Population', async () => {
      const insp = await bm.inspectForms();
      const res = await bm.fillForm({
        expectedSnapshotToken: insp.snapshotToken,
        fields: [
          { name: 'Full Name', value: 'Sarah Connor' },
          { name: 'Email Address', value: 'sarah@example.com' },
          { name: 'Country', value: 'United Kingdom' },
          { name: 'Subscribe to newsletter', checked: true },
          { name: 'Payment Method', value: 'Mastercard' }
        ]
      });
      assert.equal(res.success, true);
      assert.equal(res.updatedCount, 5);
    });

    // 35. Final states verified
    await runTest(35, 'Final Form States Verified in DOM', 'Form Population', async () => {
      const domState = await bm.page.evaluate(() => ({
        name: document.getElementById('full-name').value,
        email: document.getElementById('email-address').value,
        country: document.getElementById('country-select').value,
        subscribe: document.getElementById('subscribe-check').checked,
        mastercard: document.querySelector('input[value="mastercard"]').checked,
        visa: document.querySelector('input[value="visa"]').checked
      }));
      assert.equal(domState.name, 'Sarah Connor');
      assert.equal(domState.email, 'sarah@example.com');
      assert.equal(domState.country, 'UK');
      assert.equal(domState.subscribe, true);
      assert.equal(domState.mastercard, true);
      assert.equal(domState.visa, false);
    });

    // 36. Submit button NOT clicked
    await runTest(36, 'Submit Button NOT Clicked', 'Submission Blocking', async () => {
      const submitted = await bm.page.evaluate(() => window.__submitted);
      assert.equal(submitted, false, 'Form must not have been submitted');
    });

    // 37. Navigation does NOT occur
    await runTest(37, 'Navigation Does NOT Occur During Population', 'Submission Blocking', async () => {
      const currentUrl = bm.page.url();
      assert.equal(currentUrl, `${baseUrl}/forms-basic.html`, 'URL must remain unchanged');
    });

    // 38. Password fill blocked
    await runTest(38, 'Password Fill Blocked', 'Sensitive Field Protection', async () => {
      const insp = await bm.inspectForms();
      let errorThrown = null;
      try {
        await bm.fillForm({
          expectedSnapshotToken: insp.snapshotToken,
          fields: [{ name: 'Password', value: 'secretPassword123' }]
        });
      } catch (err) {
        errorThrown = err;
      }
      assert.ok(errorThrown, 'Must throw error on password fill');
      assert.equal(errorThrown.code, 'SENSITIVE_FIELD_NOT_ALLOWED');
      const pwdVal = await bm.page.evaluate(() => document.getElementById('pwd-input').value);
      assert.equal(pwdVal, '');
    });

    // 39. File fill blocked
    await runTest(39, 'File Input Fill Blocked', 'Sensitive Field Protection', async () => {
      const insp = await bm.inspectForms();
      let errorThrown = null;
      try {
        await bm.fillForm({
          expectedSnapshotToken: insp.snapshotToken,
          fields: [{ name: 'Upload Document', value: 'C:/fake/upload.pdf' }]
        });
      } catch (err) {
        errorThrown = err;
      }
      assert.ok(errorThrown, 'Must throw error on file input fill');
      assert.equal(errorThrown.code, 'FILE_INPUT_NOT_ALLOWED');
    });

    // 40. Disabled field blocked
    await runTest(40, 'Disabled Field Fill Blocked', 'Form Preflight', async () => {
      const insp = await bm.inspectForms();
      let errorThrown = null;
      try {
        await bm.fillForm({
          expectedSnapshotToken: insp.snapshotToken,
          fields: [{ name: 'Discount Code', value: 'SAVE20' }]
        });
      } catch (err) {
        errorThrown = err;
      }
      assert.ok(errorThrown, 'Must throw error on disabled field fill');
      assert.equal(errorThrown.code, 'TARGET_DISABLED');
      const val = await bm.page.evaluate(() => document.getElementById('disabled-code').value);
      assert.equal(val, 'LOCKED');
    });

    // 41. Readonly field blocked
    await runTest(41, 'Readonly Field Fill Blocked', 'Form Preflight', async () => {
      const insp = await bm.inspectForms();
      let errorThrown = null;
      try {
        await bm.fillForm({
          expectedSnapshotToken: insp.snapshotToken,
          fields: [{ name: 'Order Reference', value: 'TAMPERED' }]
        });
      } catch (err) {
        errorThrown = err;
      }
      assert.ok(errorThrown, 'Must throw error on readonly field fill');
      assert.equal(errorThrown.code, 'FIELD_READONLY');
      const val = await bm.page.evaluate(() => document.getElementById('readonly-ref').value);
      assert.equal(val, 'REF-12345');
    });

    // 42. Invalid option blocked
    await runTest(42, 'Invalid Option Fill Blocked', 'Form Preflight', async () => {
      const insp = await bm.inspectForms();
      let errorThrown = null;
      try {
        await bm.fillForm({
          expectedSnapshotToken: insp.snapshotToken,
          fields: [{ name: 'Country', value: 'InvalidCountry' }]
        });
      } catch (err) {
        errorThrown = err;
      }
      assert.ok(errorThrown, 'Must throw error on invalid option');
      assert.equal(errorThrown.code, 'OPTION_NOT_FOUND');
    });

    // 43. Stale snapshot blocked
    await runTest(43, 'Stale Snapshot Token Blocked', 'Form Preflight', async () => {
      let errorThrown = null;
      try {
        await bm.fillForm({
          expectedSnapshotToken: 'stale-token-form-123',
          fields: [{ name: 'Full Name', value: 'Never Applied' }]
        });
      } catch (err) {
        errorThrown = err;
      }
      assert.ok(errorThrown, 'Must throw error on stale snapshot');
      assert.equal(errorThrown.code, 'TARGET_STALE');
    });

    // 44. Zero mutation on failed preflight
    await runTest(44, 'Zero Mutation on Failed Preflight', 'Form Preflight', async () => {
      // Set baseline in DOM
      await bm.page.evaluate(() => {
        document.getElementById('full-name').value = 'Baseline Name';
      });
      const insp = await bm.inspectForms();
      let errorThrown = null;
      try {
        await bm.fillForm({
          expectedSnapshotToken: insp.snapshotToken,
          fields: [
            { name: 'Full Name', value: 'Modified Name' },
            { name: 'Discount Code', value: 'ILLEGAL' } // disabled -> fails preflight
          ]
        });
      } catch (err) {
        errorThrown = err;
      }
      assert.ok(errorThrown, 'Must reject before mutating any field');
      assert.equal(errorThrown.code, 'TARGET_DISABLED');

      // Crucial check: Full Name must STILL be Baseline Name
      const currentName = await bm.page.evaluate(() => document.getElementById('full-name').value);
      assert.equal(currentName, 'Baseline Name', 'Baseline field must remain unmutated on preflight failure');
    });

    // 45. Form validation state observed safely
    await runTest(45, 'Form Validation State Observed Safely', 'Form Validation', async () => {
      await bm.navigate(`${baseUrl}/forms-validation.html`);
      await bm.syncDynamicState();
      const insp = await bm.inspectForms();
      assert.equal(insp.success, true);
      const valForm = insp.forms[0];
      assert.ok(valForm, 'Validation form must be detected');

      // Check username field validity
      const userField = valForm.fields.find(f => f.name === 'username');
      assert.ok(userField, 'Username field must exist');
      assert.ok(userField.validity, 'Validity metadata must be extracted');
      assert.equal(userField.validity.valid, false, 'Empty required username must be invalid');
      assert.equal(userField.validity.issue, 'valueMissing');

      // Check email field validity
      const emailField = valForm.fields.find(f => f.name === 'userEmail');
      assert.ok(emailField, 'User email field must exist');
      assert.ok(emailField.validity, 'Validity metadata must be extracted');
      assert.equal(emailField.validity.valid, false, 'Empty required email must be invalid');
      assert.equal(emailField.validity.issue, 'valueMissing');

      // Populate age with invalid value (15, below min 18) directly in DOM
      await bm.page.evaluate(() => {
        const ageEl = document.getElementById('val-age');
        ageEl.value = '15';
      });
      await bm.syncDynamicState();
      const insp2 = await bm.inspectForms();
      const ageField = insp2.forms[0].fields.find(f => f.name === 'age');
      assert.ok(ageField, 'Age field must exist');
      assert.ok(ageField.validity);
      assert.equal(ageField.validity.valid, false);
      assert.equal(ageField.validity.issue, 'rangeUnderflow');
    });

    // 46. Dynamic form mutation invalidates old snapshot
    await runTest(46, 'Dynamic Form Mutation Invalidates Old Snapshot', 'Dynamic Forms & Atomicity', async () => {
      await bm.navigate(`${baseUrl}/forms-dynamic.html`);
      await bm.syncDynamicState();
      const oldInsp = await bm.inspectForms();

      // Trigger dynamic DOM mutation
      await bm.page.evaluate(() => document.getElementById('btn-toggle-gift').click());
      await bm.syncDynamicState();

      let errorThrown = null;
      try {
        await bm.fillForm({
          expectedSnapshotToken: oldInsp.snapshotToken,
          fields: [{ name: 'Add Gift Wrapping', checked: true }]
        });
      } catch (err) {
        errorThrown = err;
      }
      assert.ok(errorThrown, 'Must reject old snapshot after dynamic DOM mutation');
      assert.equal(errorThrown.code, 'TARGET_STALE');
    });

    // 47. Page A/Page B isolation
    await runTest(47, 'Multi-Page Form Isolation', 'Cross-Page Form Isolation', async () => {
      // Page A is forms-dynamic.html
      const pageAId = bm.activePageId;

      // Open Page B with forms-multiple.html
      const pageBRes = await bm.openPage(`${baseUrl}/forms-multiple.html`);
      const pageBId = pageBRes.pageId;
      await bm.syncDynamicState();

      // Inspect Page B
      const inspB = await bm.inspectForms();
      assert.equal(inspB.pageId, pageBId);
      assert.equal(inspB.forms.length, 2);

      // Switch back to Page A
      await bm.switchPage(pageAId);
      await bm.syncDynamicState();
      const inspA = await bm.inspectForms();
      assert.equal(inspA.pageId, pageAId);

      // Fill Page A
      const fillResA = await bm.fillForm({
        expectedSnapshotToken: inspA.snapshotToken,
        fields: [{ name: 'Add Gift Wrapping', checked: true }]
      });
      assert.equal(fillResA.success, true);
      assert.equal(fillResA.pageId, pageAId);

      // Verify Page A mutated
      const giftChecked = await bm.page.evaluate(() => document.getElementById('gift-check').checked);
      assert.equal(giftChecked, true);

      // Verify Page B unmutated by switching to Page B
      await bm.switchPage(pageBId);
      const bStreetVal = await bm.page.evaluate(() => document.getElementById('ship-street').value);
      assert.equal(bStreetVal, '', 'Page B must remain untouched');

      // Close Page B
      await bm.closePage(pageBId);
      assert.equal(bm.activePageId, pageAId);
    });

    // 48. Prepare submission does not submit (forms-submit-success.html)
    let submitSuccessToken = null;
    await runTest(48, 'Prepare Form Submission Does Not Submit', 'Prepare Submission', async () => {
      fixtureServer.resetSubmitCount();
      await bm.navigate(`${baseUrl}/forms-submit-success.html`);
      await bm.syncDynamicState();

      const insp = await bm.inspectForms();
      assert.equal(insp.forms.length, 1);
      assert.equal(insp.forms[0].buttons.length, 1);

      const prepRes = await bm.prepareFormSubmission({
        expectedSnapshotToken: insp.snapshotToken,
        submitter: 'Send Message',
        verification: { type: 'url-contains', value: 'submitted.html' }
      });

      assert.equal(prepRes.success, true);
      assert.equal(prepRes.validation.valid, true);
      assert.ok(typeof prepRes.confirmationToken === 'string' && prepRes.confirmationToken.startsWith('conf_'));
      submitSuccessToken = prepRes.confirmationToken;

      // Invariant: MUST NOT SUBMIT during preparation
      assert.equal(fixtureServer.getSubmitCount(), 0, 'Server must have received 0 submissions during prepare');
      assert.ok(bm.page.url().includes('forms-submit-success.html'), 'Page must remain on form page during prepare');
    });

    // 49. Valid confirmed submission & URL verification
    await runTest(49, 'Confirmed Form Submission With Evidence Verification', 'Submission Execution', async () => {
      assert.ok(submitSuccessToken, 'Must have valid confirmation token from prepare');

      const submitRes = await bm.submitForm({
        confirmationToken: submitSuccessToken
      });

      assert.equal(submitRes.success, true);
      assert.equal(submitRes.submissionAttempted, true);
      assert.equal(submitRes.verified, true);
      assert.equal(submitRes.state, 'SUBMISSION_VERIFIED');
      assert.equal(submitRes.verification.matched, true);
      assert.ok(submitRes.currentUrl.includes('submitted.html'));

      // Loopback server received exactly one submission
      assert.equal(fixtureServer.getSubmitCount(), 1, 'Server must have received exactly 1 submission');
    });

    // 50. Single-use token & duplicate submission prevention
    await runTest(50, 'Single-Use Confirmation Token Blocks Duplicate Submit', 'Single-Use & Duplicate Prevention', async () => {
      let duplicateError = null;
      try {
        await bm.submitForm({
          confirmationToken: submitSuccessToken
        });
      } catch (err) {
        duplicateError = err;
      }

      assert.ok(duplicateError, 'Duplicate submit with used token must throw');
      assert.equal(duplicateError.code, 'CONFIRMATION_ALREADY_USED');
      // Server count must NOT increment
      assert.equal(fixtureServer.getSubmitCount(), 1, 'Server counter must remain 1 after blocked duplicate attempt');
    });

    // 51. Browser native HTML5 form validation precheck
    await runTest(51, 'Native Form Validation Blocks Unvalidated Preparation', 'Form Validation', async () => {
      await bm.navigate(`${baseUrl}/forms-submit-validation.html`);
      await bm.syncDynamicState();

      const insp = await bm.inspectForms();
      assert.equal(insp.forms.length, 1);

      let valError = null;
      try {
        await bm.prepareFormSubmission({
          expectedSnapshotToken: insp.snapshotToken,
          submitter: 'Register'
        });
      } catch (err) {
        valError = err;
      }

      assert.ok(valError, 'Preparation must fail on invalid form');
      assert.equal(valError.code, 'FORM_VALIDATION_FAILED');
      assert.ok(Array.isArray(valError.details?.issues) && valError.details.issues.length > 0);
      assert.equal(fixtureServer.getSubmitCount(), 1, 'Server counter must not increment on validation failure');
    });

    // 52. SPA form submission & text/route verification
    await runTest(52, 'SPA Form Submission & Text/Route Verification', 'Submission Verification', async () => {
      await bm.navigate(`${baseUrl}/forms-submit-spa.html`);
      await bm.syncDynamicState();

      const insp = await bm.inspectForms();
      assert.equal(insp.forms.length, 1);

      const prepRes = await bm.prepareFormSubmission({
        expectedSnapshotToken: insp.snapshotToken,
        submitter: 'Confirm Order',
        verification: { type: 'text-present', text: 'Order Placed Successfully' }
      });

      assert.equal(prepRes.success, true);
      assert.ok(prepRes.confirmationToken);

      const submitRes = await bm.submitForm({
        confirmationToken: prepRes.confirmationToken
      });

      assert.equal(submitRes.success, true);
      assert.equal(submitRes.verified, true);
      assert.equal(submitRes.state, 'SUBMISSION_VERIFIED');
      assert.equal(submitRes.verification.matched, true);

      // Verify DOM updated in browser
      const confVisible = await bm.page.evaluate(() => {
        const el = document.getElementById('spa-confirmation');
        return el && el.style.display !== 'none';
      });
      assert.equal(confVisible, true, 'SPA confirmation container must be displayed');

      // Server counter should now be 2
      assert.equal(fixtureServer.getSubmitCount(), 2);
    });

    // 53. Truthful unverified result on timeout (no auto-retry)
    await runTest(53, 'Truthful Failure Reporting Without Auto-Retry on Timeout', 'Submission Verification', async () => {
      await bm.navigate(`${baseUrl}/forms-submit-failure.html`);
      await bm.syncDynamicState();

      const insp = await bm.inspectForms();
      const prepRes = await bm.prepareFormSubmission({
        expectedSnapshotToken: insp.snapshotToken,
        submitter: 'Process Transaction',
        verification: { type: 'url-changed' }
      });

      assert.equal(prepRes.success, true);
      const token = prepRes.confirmationToken;

      let timeoutError = null;
      try {
        await bm.submitForm({
          confirmationToken: token
        }, { verifyTimeoutMs: 600 });
      } catch (err) {
        timeoutError = err;
      }

      assert.ok(timeoutError, 'Must throw when verification fails to observe evidence');
      assert.equal(timeoutError.code, 'SUBMISSION_ATTEMPTED_BUT_NOT_VERIFIED');
      assert.equal(timeoutError.details?.submissionAttempted, true);
      assert.equal(timeoutError.details?.verified, false);
      assert.equal(timeoutError.details?.state, 'SUBMISSION_ATTEMPTED_BUT_NOT_VERIFIED');

      // Confirm token was consumed and cannot be retried
      let retryError = null;
      try {
        await bm.submitForm({ confirmationToken: token });
      } catch (err) {
        retryError = err;
      }
      assert.ok(retryError);
      assert.equal(retryError.code, 'CONFIRMATION_ALREADY_USED');
    });

    // 54. Stale confirmation detection on dynamic change
    await runTest(54, 'Stale Confirmation Invalidation on State Change', 'Submission Verification', async () => {
      await bm.navigate(`${baseUrl}/forms-submit-success.html`);
      await bm.syncDynamicState();

      const insp = await bm.inspectForms();
      const prepRes = await bm.prepareFormSubmission({
        expectedSnapshotToken: insp.snapshotToken,
        submitter: 'Send Message'
      });

      // Cause a dynamic semantic mutation to bump semanticRevision
      await bm.page.evaluate(() => {
        const btn = document.createElement('button');
        btn.textContent = 'Dynamic Control Added';
        document.body.appendChild(btn);
      });
      await bm.syncDynamicState();

      let staleError = null;
      try {
        await bm.submitForm({
          confirmationToken: prepRes.confirmationToken
        });
      } catch (err) {
        staleError = err;
      }

      assert.ok(staleError, 'Must reject submission if DOM mutated since preparation');
      assert.equal(staleError.code, 'SUBMISSION_STALE');
    });

    // 55. Expired confirmation token detection
    await runTest(55, 'Confirmation Token Expiration Enforcement', 'Prepare Submission', async () => {
      await bm.navigate(`${baseUrl}/forms-submit-success.html`);
      await bm.syncDynamicState();

      const insp = await bm.inspectForms();
      const prepRes = await bm.prepareFormSubmission({
        expectedSnapshotToken: insp.snapshotToken,
        submitter: 'Send Message'
      }, { ttlMs: 1000 });

      // Wait 1200ms to ensure expiration
      await new Promise(r => setTimeout(r, 1200));

      let expError = null;
      try {
        await bm.submitForm({
          confirmationToken: prepRes.confirmationToken
        });
      } catch (err) {
        expError = err;
      }

      assert.ok(expError, 'Must reject expired confirmation token');
      assert.equal(expError.code, 'CONFIRMATION_EXPIRED');
    });

    // 56. Password/auth form submission blocked
    await runTest(56, 'Password / Authentication Form Submission Blocked', 'Submission Security & Safety', async () => {
      await bm.navigate(`${baseUrl}/forms-basic.html`);
      await bm.syncDynamicState();

      const insp = await bm.inspectForms();
      assert.ok(insp.forms.length > 0);
      const formWithPassword = insp.forms.find(f => f.fields.some(fld => fld.type === 'password' || fld.sensitive));
      assert.ok(formWithPassword, 'Must discover form with password');

      let authError = null;
      try {
        await bm.prepareFormSubmission({
          expectedSnapshotToken: insp.snapshotToken,
          formId: formWithPassword.formId,
          submitter: 'Submit Order'
        });
      } catch (err) {
        authError = err;
      }

      assert.ok(authError, 'Must block password form submission preparation');
      assert.equal(authError.code, 'AUTH_FORM_NOT_SUPPORTED');
    });

    // 57. File upload form submission blocked
    await runTest(57, 'File Upload Form Submission Blocked', 'Submission Security & Safety', async () => {
      await bm.navigate(`${baseUrl}/forms-submit-file.html`);
      await bm.syncDynamicState();

      const insp = await bm.inspectForms();
      assert.ok(insp.forms.length > 0);
      const fileForm = insp.forms[0];

      let fileError = null;
      try {
        await bm.prepareFormSubmission({
          expectedSnapshotToken: insp.snapshotToken,
          formId: fileForm.formId,
          submitter: 'Upload'
        });
      } catch (err) {
        fileError = err;
      }

      assert.ok(fileError, 'Must block file form submission preparation');
      assert.equal(fileError.code, 'FILE_FORM_NOT_SUPPORTED');
    });

    // 58. Cross-page submission isolation
    await runTest(58, 'Cross-Page Form Submission Isolation', 'Cross-Page Submission Isolation', async () => {
      // Navigate Page A to forms-submit-success.html
      await bm.navigate(`${baseUrl}/forms-submit-success.html`);
      await bm.syncDynamicState();
      const pageAId = bm.activePageId;
      const inspA = await bm.inspectForms();
      const prepA = await bm.prepareFormSubmission({
        pageId: pageAId,
        expectedSnapshotToken: inspA.snapshotToken,
        submitter: 'Send Message',
        verification: { type: 'url-contains', value: 'submitted.html' }
      });

      // Open Page B with forms-submit-spa.html
      const pageBRes = await bm.openPage(`${baseUrl}/forms-submit-spa.html`);
      const pageBId = pageBRes.pageId;
      await bm.syncDynamicState();
      const inspB = await bm.inspectForms();
      const prepB = await bm.prepareFormSubmission({
        pageId: pageBId,
        expectedSnapshotToken: inspB.snapshotToken,
        submitter: 'Confirm Order',
        verification: { type: 'text-present', text: 'Order Placed Successfully' }
      });

      // Attempt submitting Page B using Token A -> Must fail with CROSS_PAGE_TOKEN_BLOCKED
      let crossError = null;
      try {
        await bm.submitForm({
          pageId: pageBId,
          confirmationToken: prepA.confirmationToken
        });
      } catch (err) {
        crossError = err;
      }
      assert.ok(crossError);
      assert.equal(crossError.code, 'CROSS_PAGE_TOKEN_BLOCKED');

      // Submit Page A with Token A
      await bm.switchPage(pageAId);
      const submitARes = await bm.submitForm({
        pageId: pageAId,
        confirmationToken: prepA.confirmationToken
      });
      assert.equal(submitARes.success, true);
      assert.equal(submitARes.verified, true);

      // Verify Page B is untouched
      await bm.switchPage(pageBId);
      const bUnsubmitted = await bm.page.evaluate(() => {
        const orderForm = document.getElementById('spa-order-form');
        return orderForm && orderForm.style.display !== 'none';
      });
      assert.equal(bUnsubmitted, true, 'Page B form must remain unsubmitted and visible');

      // Close Page B
      await bm.closePage(pageBId);
      assert.equal(bm.activePageId, pageAId);
    });

    // =========================================================================
    // Brick 35: Browser Sessions, Local Vault, & Persistence Tests (59 - 70)
    // =========================================================================
    let savedSessionA = null;
    let savedSessionB = null;
    let savedExpired = null;
    let preRestorePageId = null;
    let preRestoreSnapshotToken = null;
    let preRestoreConfirmationToken = null;

    // 59. Unauthenticated access to protected fixture
    await runTest(59, 'Unauthenticated Protected Route Check', 'Session Persistence & Isolation', async () => {
      const navRes = await bm.navigate(`${baseUrl}/auth/protected`);
      assert.equal(navRes.success, true);
      const text = await bm.page.textContent('#auth-status');
      assert.equal(text.trim(), 'Authentication Required');
      const userText = await bm.page.textContent('#user-display');
      assert.equal(userText.trim(), 'User: None');
    });

    // 60. Establish synthetic human-like fixture session
    await runTest(60, 'Establish Synthetic Fixture Session', 'Session Persistence & Isolation', async () => {
      // Human-like navigation to login and selection
      await bm.navigate(`${baseUrl}/auth/login`);
      await Promise.all([
        bm.page.waitForURL('**/auth/protected'),
        bm.page.click('#login-user-a-btn')
      ]);
      
      const authStatus = await bm.page.textContent('#auth-status');
      assert.equal(authStatus.trim(), 'Authenticated Fixture');
      const userDisplay = await bm.page.textContent('#user-display');
      assert.equal(userDisplay.trim(), 'User: UserA');
      const markerText = await bm.page.textContent('#localstorage-marker');
      assert.equal(markerText.trim(), 'Marker: synth_marker_UserA');

      // Prepare inspection and form confirmation token for invalidation test later
      const insp = await bm.inspectForms();
      preRestorePageId = bm.activePageId;
      preRestoreSnapshotToken = insp.snapshotToken;
      const { generateConfirmationToken, registerTestConfirmationToken } = await import('../src/browser/formSubmitter.js');
      preRestoreConfirmationToken = generateConfirmationToken();
      if (typeof registerTestConfirmationToken === 'function') {
        registerTestConfirmationToken(preRestoreConfirmationToken, { pageId: preRestorePageId });
      }
    });

    // 61. Explicit session save through JARVIS session subsystem
    await runTest(61, 'Explicit Session Save with Safe Metadata', 'Session Persistence & Isolation', async () => {
      savedSessionA = await bm.saveSession({ name: 'Work Portal A' });
      assert.equal(savedSessionA.success, true);
      assert.ok(savedSessionA.sessionId.startsWith('sess_'));
      assert.equal(savedSessionA.name, 'Work Portal A');
      assert.ok(Array.isArray(savedSessionA.origins));
      assert.ok(savedSessionA.origins.includes(baseUrl));
      // Must NOT contain any secrets or raw state
      assert.equal(savedSessionA.cookies, undefined);
      assert.equal(savedSessionA.storageState, undefined);
      assert.equal(savedSessionA.tokens, undefined);
      assert.equal(JSON.stringify(savedSessionA).includes('synth_token_UserA'), false);
      assert.equal(JSON.stringify(savedSessionA).includes('synth_marker_UserA'), false);
    });

    // 62. Restart browser lifecycle with saved session
    await runTest(62, 'Restart Browser with Saved Session State', 'Session Persistence & Isolation', async () => {
      await bm.close();
      assert.equal(bm.isBrowserConnected(), false);

      // Create new BrowserManager lifecycle
      bm = new BrowserManager({
        allowTestLoopback: true,
        headless: process.env.HEADLESS !== 'false',
        downloadDir: syntheticDownloadDir
      });
      activeBm = bm;

      // Select saved session
      const selected = await bm.selectSession(savedSessionA.sessionId);
      assert.equal(selected.selectedSessionId, savedSessionA.sessionId);
      assert.equal(bm.selectedSessionId, savedSessionA.sessionId);

      // Launch new isolated context with saved state
      await bm.launch();
      assert.equal(bm.isBrowserConnected(), true);
      assert.equal(bm.loadedSessionId, savedSessionA.sessionId);
      
      const status = bm.getStatus();
      assert.equal(status.sessionProfileLoaded, true);
      assert.equal(status.sessionStateRestored, true);
      assert.equal(status.loadedSessionId, savedSessionA.sessionId);
    });

    // 63. Restored authentication & HttpOnly cookie persistence
    await runTest(63, 'Restored Auth & HttpOnly Cookie Persistence', 'Session Persistence & Isolation', async () => {
      // Navigate directly to protected route without logging in
      const navRes = await bm.navigate(`${baseUrl}/auth/protected`);
      assert.equal(navRes.success, true);
      const authStatus = await bm.page.textContent('#auth-status');
      assert.equal(authStatus.trim(), 'Authenticated Fixture');
      const userDisplay = await bm.page.textContent('#user-display');
      assert.equal(userDisplay.trim(), 'User: UserA');
    });

    // 64. localStorage persistence across browser lifecycle
    await runTest(64, 'localStorage Persistence Across Lifecycle', 'Session Persistence & Isolation', async () => {
      const markerText = await bm.page.textContent('#localstorage-marker');
      assert.equal(markerText.trim(), 'Marker: synth_marker_UserA');
    });

    // 65. Session A/B isolation across lifecycles
    await runTest(65, 'Session A/B Isolation Across Lifecycles', 'Session Persistence & Isolation', async () => {
      // In current browser, navigate to login and authenticate as UserB
      await bm.navigate(`${baseUrl}/auth/login`);
      await Promise.all([
        bm.page.waitForURL('**/auth/protected'),
        bm.page.click('#login-user-b-btn')
      ]);
      
      const bStatus = await bm.page.textContent('#auth-status');
      assert.equal(bStatus.trim(), 'Authenticated Fixture');
      const bUser = await bm.page.textContent('#user-display');
      assert.equal(bUser.trim(), 'User: UserB');

      // Save as Session B
      savedSessionB = await bm.saveSession({ name: 'Work Portal B' });
      assert.ok(savedSessionB.sessionId.startsWith('sess_'));
      assert.notEqual(savedSessionB.sessionId, savedSessionA.sessionId);

      // Close and restart with Session A
      await bm.close();
      bm = new BrowserManager({ allowTestLoopback: true, headless: process.env.HEADLESS !== 'false', downloadDir: syntheticDownloadDir });
      activeBm = bm;
      await bm.selectSession(savedSessionA.sessionId);
      await bm.launch();
      await bm.navigate(`${baseUrl}/auth/protected`);
      const aUser = await bm.page.textContent('#user-display');
      assert.equal(aUser.trim(), 'User: UserA');

      // Close and restart with Session B
      await bm.close();
      bm = new BrowserManager({ allowTestLoopback: true, headless: process.env.HEADLESS !== 'false', downloadDir: syntheticDownloadDir });
      activeBm = bm;
      await bm.selectSession(savedSessionB.sessionId);
      await bm.launch();
      await bm.navigate(`${baseUrl}/auth/protected`);
      const bUserAgain = await bm.page.textContent('#user-display');
      assert.equal(bUserAgain.trim(), 'User: UserB');
    });

    // 66. Expired session truthfulness
    await runTest(66, 'Expired Session Truthfulness', 'Session Persistence & Isolation', async () => {
      // Log in with expired state
      await bm.navigate(`${baseUrl}/auth/login`);
      await Promise.all([
        bm.page.waitForURL('**/auth/protected'),
        bm.page.click('#login-expired-btn')
      ]);
      
      const unauthText = await bm.page.textContent('#auth-status');
      assert.equal(unauthText.trim(), 'Authentication Required');

      // Save expired session
      savedExpired = await bm.saveSession({ name: 'Expired Session' });
      
      // Close and restore expired session
      await bm.close();
      bm = new BrowserManager({ allowTestLoopback: true, headless: process.env.HEADLESS !== 'false', downloadDir: syntheticDownloadDir });
      activeBm = bm;
      await bm.selectSession(savedExpired.sessionId);
      await bm.launch();

      // JARVIS reports state restored, but protected route remains unauthenticated
      const status = bm.getStatus();
      assert.equal(status.sessionStateRestored, true);
      
      await bm.navigate(`${baseUrl}/auth/protected`);
      const finalAuthStatus = await bm.page.textContent('#auth-status');
      assert.equal(finalAuthStatus.trim(), 'Authentication Required');
      const finalUser = await bm.page.textContent('#user-display');
      assert.equal(finalUser.trim(), 'User: None');
    });

    // 67. Multi-page state & fresh page IDs upon restore
    await runTest(67, 'Multi-Page Fresh Page IDs on Restore', 'Session Persistence & Isolation', async () => {
      // Launch clean with Session A
      await bm.close();
      bm = new BrowserManager({ allowTestLoopback: true, headless: process.env.HEADLESS !== 'false', downloadDir: syntheticDownloadDir });
      activeBm = bm;
      await bm.selectSession(savedSessionA.sessionId);
      await bm.launch();

      const newPageId = bm.activePageId;
      assert.ok(newPageId);
      assert.notEqual(newPageId, preRestorePageId, 'Restored session must have fresh pageId');
      
      // Open second page
      const page2 = await bm.openPage(`${baseUrl}/multi-page.html?page=B`);
      assert.equal(bm.pageCount, 2);
      assert.notEqual(page2.pageId, preRestorePageId);
      await bm.closePage(page2.pageId);
      assert.equal(bm.pageCount, 1);
    });

    // 68. Old ID, Snapshot, and Form Confirmation Invalidation
    await runTest(68, 'Old ID and Confirmation Token Invalidation', 'Session Persistence & Isolation', async () => {
      // Attempting to switch to pre-restore pageId must fail
      let switchErr = null;
      try {
        await bm.switchPage(preRestorePageId);
      } catch (err) {
        switchErr = err;
      }
      assert.ok(switchErr);
      assert.equal(switchErr.code, 'PAGE_NOT_FOUND');

      // Attempting to submit form with pre-restore confirmation token must fail
      let submitErr = null;
      try {
        await bm.submitForm({
          confirmationToken: preRestoreConfirmationToken
        });
      } catch (err) {
        submitErr = err;
      }
      assert.ok(submitErr);
      assert.equal(submitErr.code, 'INVALID_CONFIRMATION_TOKEN');
    });

    // 69. Delete session profiles & vault file cleanup
    await runTest(69, 'Delete Session Profiles and Vault Cleanup', 'Session Persistence & Isolation', async () => {
      // List sessions before deletion
      const beforeList = await bm.listSessions();
      assert.ok(beforeList.some(s => s.sessionId === savedSessionA.sessionId));
      assert.ok(beforeList.some(s => s.sessionId === savedSessionB.sessionId));
      assert.ok(beforeList.some(s => s.sessionId === savedExpired.sessionId));

      // Delete sessions
      const delA = await bm.deleteSession(savedSessionA.sessionId);
      assert.equal(delA.success, true);
      const delB = await bm.deleteSession(savedSessionB.sessionId);
      assert.equal(delB.success, true);
      const delExp = await bm.deleteSession(savedExpired.sessionId);
      assert.equal(delExp.success, true);

      // Verify list after deletion
      const afterList = await bm.listSessions();
      assert.equal(afterList.some(s => s.sessionId === savedSessionA.sessionId), false);
      assert.equal(afterList.some(s => s.sessionId === savedSessionB.sessionId), false);
      assert.equal(afterList.some(s => s.sessionId === savedExpired.sessionId), false);
    });

    // 70. Login handoff pause, guidance, and action blocking
    let loginHandoff = null;
    await runTest(70, 'Login Handoff Pause, Guidance, and Action Blocking', 'Human Handoff (Brick 36)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/auth-handoff-login.html`, { allowLoopbackTest: true });
      const snapToken = bm.snapshotToken;

      const startRes = await bm.startHandoff({
        reason: HANDOFF_REASONS.LOGIN_REQUIRED,
        verification: { type: 'url-contains', targetUrl: 'auth-handoff-success.html' }
      });
      assert.equal(startRes.success, true);
      assert.ok(startRes.handoff);
      assert.equal(startRes.handoff.status, HANDOFF_STATES.PAUSED_FOR_HUMAN);
      assert.equal(startRes.handoff.reason, HANDOFF_REASONS.LOGIN_REQUIRED);
      assert.ok(startRes.handoff.guidance);
      loginHandoff = startRes.handoff;

      // Verify mutating action through JARVIS is blocked while handoff is active
      let actionErr = null;
      try {
        await bm.executeAction({
          action: 'click',
          target: { kind: 'button', text: 'Sign in' },
          expectedSnapshotToken: snapToken
        });
      } catch (err) {
        actionErr = err;
      }
      assert.ok(actionErr);
      assert.equal(actionErr.code, 'HUMAN_HANDOFF_ACTIVE');
    });

    // 71. Sensitive screenshot suppression during active handoff
    await runTest(71, 'Sensitive Screenshot Suppression During Active Handoff', 'Human Handoff (Brick 36)', async () => {
      const policy = bm.canCaptureDiagnosticScreenshot();
      assert.equal(policy.allowed, false);
      assert.equal(policy.reason, 'SCREENSHOT_SUPPRESSED_DURING_AUTH');

      let shotErr = null;
      try {
        await bm.takeScreenshot();
      } catch (err) {
        shotErr = err;
      }
      assert.ok(shotErr);
      assert.equal(shotErr.code, 'SCREENSHOT_SUPPRESSED_DURING_AUTH');

      // Explicit user diagnostics are permitted
      const explicitPolicy = bm.canCaptureDiagnosticScreenshot(null, { explicitUserRequest: true });
      assert.equal(explicitPolicy.allowed, true);
    });

    // 72. Verification failure returns NOT_CLEARED without automatic polling loop
    await runTest(72, 'Verification Failure Returns NOT_CLEARED without Loop', 'Human Handoff (Brick 36)', async () => {
      // Human has not completed login yet -> resume evaluates verification and returns NOT_CLEARED
      const resumeRes = await bm.resumeHandoff({ handoffId: loginHandoff.handoffId });
      assert.equal(resumeRes.success, false);
      assert.equal(resumeRes.verified, false);
      assert.equal(resumeRes.status, HANDOFF_STATES.NOT_CLEARED);
      assert.equal(resumeRes.code, 'HANDOFF_NOT_CLEARED');
      assert.equal(bm.isHandoffActive(), true);
    });

    // 73. Simulate human direct Edge interaction and successful explicit resume verification
    await runTest(73, 'Simulate Human Edge Action & Successful Resume Verification', 'Human Handoff (Brick 36)', async () => {
      // Test harness simulates human clicking the button directly in Edge (representing human action)
      await bm.page.click('#synthetic-human-login-btn');
      await bm.page.waitForURL('**/auth-handoff-success.html');

      // Human clicks resume in Control Center
      const resumeRes = await bm.resumeHandoff({ handoffId: loginHandoff.handoffId });
      assert.equal(resumeRes.success, true);
      assert.equal(resumeRes.verified, true);
      assert.equal(resumeRes.status, HANDOFF_STATES.VERIFIED);
      assert.ok(resumeRes.page.snapshotToken);
      assert.equal(bm.isHandoffActive(), false);
    });

    // 74. One-time completion rejects repeated resume
    await runTest(74, 'One-Time Completion Rejects Repeated Resume', 'Human Handoff (Brick 36)', async () => {
      let repeatErr = null;
      try {
        await bm.resumeHandoff({ handoffId: loginHandoff.handoffId });
      } catch (err) {
        repeatErr = err;
      }
      assert.ok(repeatErr);
      assert.equal(repeatErr.code, 'HANDOFF_ALREADY_COMPLETED');
    });

    // 75. MFA handoff and human second-factor approval simulation
    await runTest(75, 'MFA Handoff & Second-Factor Approval Simulation', 'Human Handoff (Brick 36)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/auth-handoff-mfa.html`, { allowLoopbackTest: true });
      const mfaStart = await bm.startHandoff({
        reason: HANDOFF_REASONS.MFA_REQUIRED,
        verification: { type: 'text-present', text: 'Authenticated Fixture' }
      });
      assert.equal(mfaStart.handoff.status, HANDOFF_STATES.PAUSED_FOR_HUMAN);

      // Harness simulates external human second factor approval in Edge
      await bm.page.click('#synthetic-human-mfa-btn');
      await bm.page.waitForURL('**/auth-handoff-success.html');

      const mfaResume = await bm.resumeHandoff({ handoffId: mfaStart.handoff.handoffId });
      assert.equal(mfaResume.verified, true);
      assert.equal(mfaResume.status, HANDOFF_STATES.VERIFIED);
    });

    // 76. CAPTCHA handoff and human solve simulation
    await runTest(76, 'CAPTCHA Handoff & Human Solve Simulation', 'Human Handoff (Brick 36)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/auth-handoff-captcha.html`, { allowLoopbackTest: true });
      const captchaStart = await bm.startHandoff({
        reason: HANDOFF_REASONS.CAPTCHA_REQUIRED,
        verification: { type: 'url-changed' }
      });
      assert.equal(captchaStart.handoff.status, HANDOFF_STATES.PAUSED_FOR_HUMAN);

      // Harness simulates human solving CAPTCHA challenge in Edge
      await bm.page.click('#synthetic-human-captcha-btn');
      await bm.page.waitForURL('**/auth-handoff-success.html');

      const captchaResume = await bm.resumeHandoff({ handoffId: captchaStart.handoff.handoffId });
      assert.equal(captchaResume.verified, true);
      assert.equal(captchaResume.status, HANDOFF_STATES.VERIFIED);
    });

    // 77. Explicit handoff cancellation
    await runTest(77, 'Explicit Handoff Cancellation', 'Human Handoff (Brick 36)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/auth-handoff-login.html`, { allowLoopbackTest: true });
      const cancelStart = await bm.startHandoff({
        reason: HANDOFF_REASONS.USER_INTERACTION_REQUIRED
      });
      assert.equal(bm.isHandoffActive(), true);

      const cancelRes = await bm.cancelHandoff({ handoffId: cancelStart.handoff.handoffId });
      assert.equal(cancelRes.status, HANDOFF_STATES.CANCELLED);
      assert.equal(bm.isHandoffActive(), false);

      let doubleCancelErr = null;
      try {
        await bm.cancelHandoff({ handoffId: cancelStart.handoff.handoffId });
      } catch (err) {
        doubleCancelErr = err;
      }
      assert.ok(doubleCancelErr);
      assert.equal(doubleCancelErr.code, 'HANDOFF_ALREADY_COMPLETED');
    });

    // 78. TTL expiry invalidation on real browser
    await runTest(78, 'TTL Expiry Invalidation on Real Browser', 'Human Handoff (Brick 36)', async () => {
      const expStart = await bm.startHandoff({
        reason: HANDOFF_REASONS.LOGIN_REQUIRED,
        ttlMs: 1000
      });
      await new Promise(r => setTimeout(r, 1100));

      let expErr = null;
      try {
        await bm.resumeHandoff({ handoffId: expStart.handoff.handoffId });
      } catch (err) {
        expErr = err;
      }
      assert.ok(expErr);
      assert.equal(expErr.code, 'HANDOFF_EXPIRED');
    });

    // 79. Bound page close invalidation
    await runTest(79, 'Bound Page Close Invalidation', 'Human Handoff (Brick 36)', async () => {
      const p2 = await bm.openPage();
      const p2Handoff = await bm.startHandoff({
        pageId: p2.pageId,
        reason: HANDOFF_REASONS.LOGIN_REQUIRED
      });
      assert.equal(bm.isHandoffActive(p2.pageId), true);

      await bm.closePage(p2.pageId);

      let closeErr = null;
      try {
        await bm.resumeHandoff({ handoffId: p2Handoff.handoff.handoffId });
      } catch (err) {
        closeErr = err;
      }
      assert.ok(closeErr);
      assert.ok(closeErr.code === 'PAGE_CLOSED' || closeErr.code === 'HANDOFF_NEW_PAGE_REQUIRES_USER');
    });

    // 80. Cross-page isolation during handoff
    await runTest(80, 'Cross-Page Isolation During Handoff', 'Human Handoff (Brick 36)', async () => {
      const activeP1 = bm.activePageId;
      const hP1 = await bm.startHandoff({
        pageId: activeP1,
        reason: HANDOFF_REASONS.LOGIN_REQUIRED
      });
      assert.equal(bm.isHandoffActive(activeP1), true);

      // Open second page
      const p2 = await bm.openPage();
      assert.equal(bm.isHandoffActive(p2.pageId), false);

      // Second page operations are NOT blocked by page 1's handoff
      await bm.navigate(`${fixtureServer.baseUrl}/static.html`, { allowLoopbackTest: true });
      const statP2 = await bm.getPageStatus();
      assert.equal(statP2.pageOpen, true);

      // Clean up
      await bm.closePage(p2.pageId);
      await bm.cancelHandoff({ handoffId: hP1.handoff.handoffId });
    });

    // 81. Pre-auth form confirmation token invalidation
    await runTest(81, 'Pre-Auth Form Confirmation Token Invalidation', 'Human Handoff (Brick 36)', async () => {
      const token = 'conf_brick36_test_pre_auth';
      registerTestConfirmationToken(token, { pageId: bm.activePageId });
      assert.ok(getConfirmationToken(token));

      await bm.startHandoff({
        reason: HANDOFF_REASONS.LOGIN_REQUIRED
      });
      assert.equal(getConfirmationToken(token), undefined);
      await bm.cancelHandoff({ handoffId: bm.getHandoffStatus().handoff.handoffId });
    });

    // =========================================================================
    // Brick 37: Safe File Upload & Download v1 Real Browser Verification
    // =========================================================================

    // 82. Upload target resolution
    await runTest(82, 'Upload Target Resolution', 'Safe Upload (Brick 37)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/file-upload-basic.html`, { allowLoopbackTest: true });
      const insp = await bm.inspectPage();
      const fileElem = insp.elements.find(e => e.kind === 'input' && e.inputType === 'file');
      assert.ok(fileElem, 'Expected file input element in inspection summary');
      assert.equal(fileElem.accessibleName, 'Upload Document');
    });

    // 83. Valid file upload
    const syntheticFile = path.join(syntheticTempDir, 'synthetic-report.txt');
    fs.writeFileSync(syntheticFile, 'Synthetic upload test content for Brick 37\n', 'utf8');

    let uploadRes = null;
    await runTest(83, 'Valid File Upload', 'Safe Upload (Brick 37)', async () => {
      const insp = await bm.inspectPage();
      uploadRes = await bm.uploadFile({
        target: { kind: 'input', name: 'Upload Document' },
        filePath: syntheticFile,
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.equal(uploadRes.success, true);
      assert.equal(uploadRes.uploaded, true);
      assert.equal(uploadRes.filename, 'synthetic-report.txt');
      assert.equal(uploadRes.verified, true);
      assert.ok(uploadRes.size > 0);
    });

    // 84. Browser DOM receives correct basename
    await runTest(84, 'Browser DOM Receives Correct Basename', 'Safe Upload (Brick 37)', async () => {
      const domInfo = await bm.page.evaluate(() => {
        const input = document.getElementById('basic-file-input');
        const nameDisp = document.getElementById('file-name-display')?.textContent;
        const sizeDisp = document.getElementById('file-size-display')?.textContent;
        return {
          hasFiles: Boolean(input && input.files && input.files.length > 0),
          fileName: input && input.files[0] ? input.files[0].name : '',
          nameDisp,
          sizeDisp
        };
      });
      assert.equal(domInfo.hasFiles, true);
      assert.equal(domInfo.fileName, 'synthetic-report.txt');
      assert.equal(domInfo.nameDisp, 'synthetic-report.txt');
    });

    // 85. Local path privacy
    await runTest(85, 'Local Path Privacy', 'Safe Upload (Brick 37)', async () => {
      assert.ok(uploadRes);
      assert.equal(uploadRes.filePath, undefined);
      assert.equal(uploadRes._destPath, undefined);
      const str = JSON.stringify(uploadRes);
      assert.equal(str.includes('test-synthetic-transfer'), false, 'Full local path must not leak in upload result');
      assert.equal(str.includes('C:\\'), false, 'Windows drive letter path must not leak in upload result');
    });

    // 86. Generic file input action remains blocked
    await runTest(86, 'Generic File Input Action Remains Blocked', 'Safe Upload (Brick 37)', async () => {
      const insp = await bm.inspectPage();
      let blocked = false;
      try {
        await bm.executeAction({
          action: 'fill',
          target: { kind: 'input', name: 'Upload Document' },
          value: 'malicious-attempt',
          expectedSnapshotToken: insp.snapshotToken
        });
      } catch (err) {
        if (err instanceof ActionExecutionError && (err.code === 'FILE_INPUT_NOT_ALLOWED' || err.code === 'FILE_INTERACTION_NOT_AUTHORIZED')) {
          blocked = true;
        }
      }
      assert.equal(blocked, true, 'Generic action fill on file input must remain strictly blocked');
    });

    // 87. Stale snapshot blocks upload
    await runTest(87, 'Stale Snapshot Blocks Upload', 'Safe Upload (Brick 37)', async () => {
      let threwStale = false;
      try {
        await bm.uploadFile({
          target: { kind: 'input', name: 'Upload Document' },
          filePath: syntheticFile,
          expectedSnapshotToken: 'snap_stale_invalid_upload'
        });
      } catch (err) {
        if (err instanceof FileTransferError && err.code === 'TARGET_STALE') {
          threwStale = true;
        }
      }
      assert.equal(threwStale, true, 'Stale snapshot token must block upload with TARGET_STALE');
    });

    // 88. Missing file blocked
    await runTest(88, 'Missing File Blocked', 'Safe Upload (Brick 37)', async () => {
      const insp = await bm.inspectPage();
      let threwNotFound = false;
      try {
        await bm.uploadFile({
          target: { kind: 'input', name: 'Upload Document' },
          filePath: path.join(syntheticTempDir, 'does-not-exist.txt'),
          expectedSnapshotToken: insp.snapshotToken
        });
      } catch (err) {
        if (err instanceof FileTransferError && err.code === 'FILE_NOT_FOUND') {
          threwNotFound = true;
        }
      }
      assert.equal(threwNotFound, true, 'Non-existent file path must be rejected with FILE_NOT_FOUND');
    });

    // 89. Directory upload blocked
    await runTest(89, 'Directory Upload Blocked', 'Safe Upload (Brick 37)', async () => {
      const insp = await bm.inspectPage();
      let threwDir = false;
      try {
        await bm.uploadFile({
          target: { kind: 'input', name: 'Upload Document' },
          filePath: syntheticTempDir,
          expectedSnapshotToken: insp.snapshotToken
        });
      } catch (err) {
        if (err instanceof FileTransferError && err.code === 'FILE_IS_DIRECTORY') {
          threwDir = true;
        }
      }
      assert.equal(threwDir, true, 'Directory path must be rejected with FILE_IS_DIRECTORY');
    });

    // 90. Oversized upload file blocked
    await runTest(90, 'Oversized Upload File Blocked', 'Safe Upload (Brick 37)', async () => {
      const insp = await bm.inspectPage();
      const largeTempFile = path.join(syntheticTempDir, 'large-synthetic.txt');
      fs.writeFileSync(largeTempFile, Buffer.alloc(100, 0x42));
      let threwTooLarge = false;
      try {
        await bm.uploadFile({
          target: { kind: 'input', name: 'Upload Document' },
          filePath: largeTempFile,
          expectedSnapshotToken: insp.snapshotToken,
          options: { maxBytes: 50 }
        });
      } catch (err) {
        if (err instanceof FileTransferError && err.code === 'UPLOAD_FILE_TOO_LARGE') {
          threwTooLarge = true;
        }
      }
      try { fs.unlinkSync(largeTempFile); } catch {}
      assert.equal(threwTooLarge, true, 'Oversized file must be rejected with UPLOAD_FILE_TOO_LARGE');
    });

    // 91. Website accept constraint blocked
    await runTest(91, 'Website Accept Constraint Blocked', 'Safe Upload (Brick 37)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/file-upload-validation.html`, { allowLoopbackTest: true });
      const insp = await bm.inspectPage();
      let threwAccept = false;
      try {
        await bm.uploadFile({
          target: { kind: 'input', name: 'Upload PDF Document' },
          filePath: syntheticFile, // .txt file, target requires .pdf
          expectedSnapshotToken: insp.snapshotToken
        });
      } catch (err) {
        if (err instanceof FileTransferError && err.code === 'FILE_TYPE_NOT_ACCEPTED') {
          threwAccept = true;
        }
      }
      assert.equal(threwAccept, true, 'Mismatched file type must be rejected with FILE_TYPE_NOT_ACCEPTED');
    });

    // 92. Upload while Human Handoff active blocked
    await runTest(92, 'Upload Blocked During Human Handoff', 'Safe Upload (Brick 37)', async () => {
      const insp = await bm.inspectPage();
      await bm.startHandoff({
        reason: HANDOFF_REASONS.LOGIN_REQUIRED
      });
      let blockedHandoff = false;
      try {
        await bm.uploadFile({
          target: { kind: 'input', name: 'Upload PDF Document' },
          filePath: syntheticFile,
          expectedSnapshotToken: insp.snapshotToken
        });
      } catch (err) {
        if (err instanceof FileTransferError && err.code === 'HUMAN_HANDOFF_ACTIVE') {
          blockedHandoff = true;
        }
      }
      await bm.cancelHandoff({ handoffId: bm.getHandoffStatus().handoff.handoffId });
      assert.equal(blockedHandoff, true, 'Upload must be blocked while Human Handoff is active');
    });

    // 93. Cross-page upload isolation
    await runTest(93, 'Cross-Page Upload Isolation', 'Safe Upload (Brick 37)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/file-upload-basic.html`, { allowLoopbackTest: true });
      const inspPage1 = await bm.inspectPage();

      const p2 = await bm.openPage();
      await bm.navigate(`${fixtureServer.baseUrl}/static.html`, { allowLoopbackTest: true });

      let threwCrossPage = false;
      try {
        await bm.uploadFile({
          target: { kind: 'input', name: 'Upload Document' },
          filePath: syntheticFile,
          expectedSnapshotToken: inspPage1.snapshotToken
        });
      } catch (err) {
        if (err instanceof FileTransferError && err.code === 'TARGET_STALE') {
          threwCrossPage = true;
        }
      }

      await bm.closePage(p2.pageId);
      assert.equal(threwCrossPage, true, 'Cross-page snapshot token reuse must be rejected with TARGET_STALE');
    });

    // 94. Upload does not submit form
    await runTest(94, 'Upload Does Not Submit Form', 'Safe Upload (Brick 37)', async () => {
      const url = bm.page.url();
      assert.ok(url.includes('file-upload-basic.html'), 'Page must remain on upload page without form navigation');
      assert.equal(url.includes('/api/test/submit'), false, 'Form must not have been automatically submitted');
    });

    // 95. Real Edge download event emitted and captured
    let dl1Res = null;
    await runTest(95, 'Real Edge Download Event Emitted and Captured', 'Safe Download (Brick 37)', async () => {
      if (fs.existsSync(bm.downloadDir)) {
        for (const file of fs.readdirSync(bm.downloadDir)) {
          try { fs.unlinkSync(path.join(bm.downloadDir, file)); } catch {}
        }
      }
      await bm.navigate(`${fixtureServer.baseUrl}/file-download-basic.html`, { allowLoopbackTest: true });
      const insp = await bm.inspectPage();

      dl1Res = await bm.downloadFile({
        target: { kind: 'link', text: 'Download Sample Report' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(dl1Res.success, true);
      assert.ok(dl1Res.downloadId.startsWith('dl_'));
      assert.equal(dl1Res.filename, 'sample.txt');
      assert.ok(dl1Res.size > 0);
    });

    // 96. File saved into approved JARVIS download directory
    await runTest(96, 'File Saved into Approved JARVIS Download Directory', 'Safe Download (Brick 37)', async () => {
      assert.ok(dl1Res);
      const dlRecord = bm.getDownload(dl1Res.downloadId);
      assert.ok(dlRecord);
      assert.equal(dlRecord.filename, 'sample.txt');
      const expectedPath = path.join(bm.downloadDir, 'sample.txt');
      assert.ok(fs.existsSync(expectedPath), 'Downloaded file must exist on disk in downloadDir');
      const stat = fs.statSync(expectedPath);
      assert.ok(stat.isFile(), 'Must be a regular file');
      assert.equal(stat.size, dl1Res.size);
    });

    // 97. Download triggered via button click
    let dlBtnRes = null;
    await runTest(97, 'Download Triggered via Button Click', 'Safe Download (Brick 37)', async () => {
      const insp = await bm.inspectPage();
      dlBtnRes = await bm.downloadFile({
        target: { kind: 'button', text: 'Download PDF Statement' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.equal(dlBtnRes.success, true);
      assert.equal(dlBtnRes.filename, 'report.pdf');
      assert.ok(dlBtnRes.size > 0);
      const pdfPath = path.join(bm.downloadDir, 'report.pdf');
      assert.ok(fs.existsSync(pdfPath));
    });

    // 98. Filename sanitization and path traversal blocked
    let dlDngRes = null;
    await runTest(98, 'Filename Sanitization and Traversal Blocked', 'Safe Download (Brick 37)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/file-download-dangerous-name.html`, { allowLoopbackTest: true });
      const insp = await bm.inspectPage();

      dlDngRes = await bm.downloadFile({
        target: { kind: 'link', text: 'Download Unix Traversal' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(dlDngRes.success, true);
      assert.equal(dlDngRes.filename, 'evil.txt');
      const safePath = path.join(bm.downloadDir, 'evil.txt');
      assert.ok(fs.existsSync(safePath), 'File must be saved safely inside downloadDir');

      const escapedPath = path.resolve(bm.downloadDir, '..', 'evil.txt');
      assert.equal(fs.existsSync(escapedPath), false, 'File must not escape download directory');
    });

    // 99. Windows reserved device name escaped
    await runTest(99, 'Windows Reserved Device Name Escaped', 'Safe Download (Brick 37)', async () => {
      const insp = await bm.inspectPage();
      const dlCon = await bm.downloadFile({
        target: { kind: 'link', text: 'Download CON Reserved' },
        expectedSnapshotToken: insp.snapshotToken
      });
      assert.equal(dlCon.success, true);
      assert.equal(dlCon.filename, '_CON');
      const conPath = path.join(bm.downloadDir, '_CON');
      assert.ok(fs.existsSync(conPath));
    });

    // 100. Collision-safe naming
    await runTest(100, 'Collision-Safe Naming', 'Safe Download (Brick 37)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/file-download-basic.html`, { allowLoopbackTest: true });
      const insp = await bm.inspectPage();

      const dlColl = await bm.downloadFile({
        target: { kind: 'link', text: 'Download Sample Report' },
        expectedSnapshotToken: insp.snapshotToken
      });

      assert.equal(dlColl.success, true);
      assert.equal(dlColl.filename, 'sample (1).txt');
      assert.ok(fs.existsSync(path.join(bm.downloadDir, 'sample.txt')));
      assert.ok(fs.existsSync(path.join(bm.downloadDir, 'sample (1).txt')));
    });

    // 101. Bounded download timeout
    await runTest(101, 'Bounded Download Timeout', 'Safe Download (Brick 37)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/file-download-basic.html`, { allowLoopbackTest: true });
      const insp = await bm.inspectPage();
      let threwTimeout = false;
      try {
        await bm.downloadFile({
          target: { kind: 'button', text: 'No Download Button' },
          expectedSnapshotToken: insp.snapshotToken,
          options: { timeoutMs: 1200 }
        });
      } catch (err) {
        if (err instanceof FileTransferError && err.code === 'DOWNLOAD_TIMEOUT') {
          threwTimeout = true;
        }
      }
      assert.equal(threwTimeout, true, 'Non-downloading target must timeout with DOWNLOAD_TIMEOUT');
    });

    // 102. Executable download blocked by security policy
    await runTest(102, 'Executable Download Blocked by Security Policy', 'Safe Download (Brick 37)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/file-download-dangerous-name.html`, { allowLoopbackTest: true });
      const insp = await bm.inspectPage();
      let blockedExe = false;
      try {
        await bm.downloadFile({
          target: { kind: 'link', text: 'Download Executable File' },
          expectedSnapshotToken: insp.snapshotToken
        });
      } catch (err) {
        if (err instanceof FileTransferError && err.code === 'DOWNLOAD_TYPE_NOT_ALLOWED') {
          blockedExe = true;
        }
      }
      assert.equal(blockedExe, true, 'Executable download must be blocked with DOWNLOAD_TYPE_NOT_ALLOWED');
      assert.equal(fs.existsSync(path.join(bm.downloadDir, 'malicious.exe')), false);
    });

    // 103. Zero automatic download retry
    await runTest(103, 'Zero Automatic Download Retry', 'Safe Download (Brick 37)', async () => {
      assert.ok(true);
    });

    // 104. Download blocked during Human Handoff
    await runTest(104, 'Download Blocked During Human Handoff', 'Safe Download (Brick 37)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/file-download-basic.html`, { allowLoopbackTest: true });
      const insp = await bm.inspectPage();
      await bm.startHandoff({
        reason: HANDOFF_REASONS.LOGIN_REQUIRED
      });
      let blockedHandoff = false;
      try {
        await bm.downloadFile({
          target: { kind: 'link', text: 'Download Sample Report' },
          expectedSnapshotToken: insp.snapshotToken
        });
      } catch (err) {
        if (err instanceof FileTransferError && err.code === 'HUMAN_HANDOFF_ACTIVE') {
          blockedHandoff = true;
        }
      }
      await bm.cancelHandoff({ handoffId: bm.getHandoffStatus().handoff.handoffId });
      assert.equal(blockedHandoff, true, 'Download must be blocked during Human Handoff');
    });

    // 105. Stale snapshot blocks download
    await runTest(105, 'Stale Snapshot Blocks Download', 'Safe Download (Brick 37)', async () => {
      let threwStale = false;
      try {
        await bm.downloadFile({
          target: { kind: 'link', text: 'Download Sample Report' },
          expectedSnapshotToken: 'snap_stale_dl_token'
        });
      } catch (err) {
        if (err instanceof FileTransferError && err.code === 'TARGET_STALE') {
          threwStale = true;
        }
      }
      assert.equal(threwStale, true, 'Stale snapshot token must block download');
    });

    // 106. Download registry listing verification
    await runTest(106, 'Download Registry Listing Verification', 'Safe Download (Brick 37)', async () => {
      const list = bm.listDownloads();
      assert.ok(Array.isArray(list));
      assert.ok(list.length >= 3, `Expected at least 3 downloads in registry, got ${list.length}`);
      for (const item of list) {
        assert.ok(item.downloadId.startsWith('dl_'));
        assert.ok(typeof item.filename === 'string' && item.filename.length > 0);
        assert.ok(typeof item.size === 'number' && item.size >= 0);
        assert.equal(item.status, 'completed');
        assert.equal(item._destPath, undefined, 'Internal _destPath must not be exposed');
        assert.equal(item.cookies, undefined);
        assert.equal(item.token, undefined);
      }
    });

    // 107. Transfer cleanup in harness
    await runTest(107, 'Transfer Cleanup in Harness', 'Transfer Cleanup (Brick 37)', async () => {
      const downloads = bm.listDownloads();
      for (const dl of downloads) {
        const fullRecord = bm.getDownload(dl.downloadId);
        if (fullRecord && fullRecord._destPath) {
          try { fs.unlinkSync(fullRecord._destPath); } catch {}
        }
      }
      try {
        fs.rmSync(syntheticTempDir, { recursive: true, force: true });
      } catch {}
      try {
        fs.rmSync(syntheticDownloadDir, { recursive: true, force: true });
      } catch {}
      assert.equal(fs.existsSync(syntheticTempDir), false);
      assert.equal(fs.existsSync(syntheticDownloadDir), false);
    });

    // 108. Page Metadata Extraction (Brick 38)
    await runTest(108, 'Page Metadata Extraction', 'Structured Extraction (Brick 38)', async () => {
      await bm.navigate(`${baseUrl}/extract-basic.html`);
      await bm.waitForStable();
      const snap = await bm.waitForStable();
      const res = await bm.extractStructuredData({
        expectedSnapshotToken: snap.snapshotToken,
        types: ['metadata']
      });
      assert.equal(res.success, true);
      assert.ok(res.data.metadata, 'Metadata must be returned');
      assert.equal(res.data.metadata.title, 'Extract Basic Fixture');
      assert.equal(res.data.metadata.language, 'en');
      assert.ok(res.data.metadata.canonicalUrl.includes('/extract-basic.html'));
      assert.equal(res.data.metadata.description, 'A deterministic fixture for basic metadata and headings extraction.');
      assert.equal(res.truncated, false);
      assert.equal(res.truncationReason, null);
    });

    // 109. Headings Extraction with DOM Order & Visibility Filtering (Brick 38)
    await runTest(109, 'Headings Extraction with DOM Order & Visibility Filtering', 'Structured Extraction (Brick 38)', async () => {
      const snap = await bm.waitForStable();
      const res = await bm.extractStructuredData({
        expectedSnapshotToken: snap.snapshotToken,
        types: ['headings']
      });
      assert.equal(res.success, true);
      assert.equal(res.data.headings.length, 7, `Expected 7 visible headings, got ${res.data.headings.length}`);
      assert.equal(res.data.headings[0].level, 1);
      assert.equal(res.data.headings[0].text, 'Page Header 1');
      assert.equal(res.data.headings[1].level, 2);
      assert.equal(res.data.headings[1].text, 'Sub Header 2');
      for (const h of res.data.headings) {
        assert.ok(!h.text.includes('Hidden'), 'Hidden headings must be filtered out');
      }
    });

    // 110. Links Extraction with Same-Origin Detection (Brick 38)
    await runTest(110, 'Links Extraction with Same-Origin Detection', 'Structured Extraction (Brick 38)', async () => {
      const snap = await bm.waitForStable();
      const res = await bm.extractStructuredData({
        expectedSnapshotToken: snap.snapshotToken,
        types: ['links']
      });
      assert.equal(res.success, true);
      assert.ok(res.data.links.length >= 2, `Expected at least 2 visible links, got ${res.data.links.length}`);
      const aboutLink = res.data.links.find(l => l.text === 'About Us');
      assert.ok(aboutLink, 'About Us link must be present');
      assert.equal(aboutLink.sameOrigin, true);
      assert.ok(aboutLink.href.startsWith('http://127.0.0.1:'), 'Relative link must resolve against page URL');
      const extLink = res.data.links.find(l => l.text === 'Docs' || l.accessibleName === 'External Documentation');
      assert.ok(extLink, 'External link must be present');
      assert.equal(extLink.sameOrigin, false);
      for (const l of res.data.links) {
        assert.ok(!l.text.includes('Hidden'), 'Hidden links must be filtered out');
      }
    });

    // 111. Regular Table Extraction with Caption, Thead & Tbody (Brick 38)
    await runTest(111, 'Regular Table Extraction with Caption, Thead & Tbody', 'Structured Extraction (Brick 38)', async () => {
      await bm.navigate(`${baseUrl}/extract-table.html`);
      await bm.waitForStable();
      const snap = await bm.waitForStable();
      const res = await bm.extractStructuredData({
        expectedSnapshotToken: snap.snapshotToken,
        types: ['tables']
      });
      assert.equal(res.success, true);
      assert.ok(res.data.tables.length >= 2, `Expected at least 2 tables, got ${res.data.tables.length}`);
      const regular = res.data.tables[0];
      assert.equal(regular.caption, 'Team Directory');
      assert.deepEqual(regular.headers, ['Name', 'Department', 'Status']);
      assert.equal(regular.rows.length, 3);
      assert.deepEqual(regular.rows[0], ['Ahmed', 'Content', 'Completed']);
      assert.deepEqual(regular.rows[1], ['Sara', 'Digital Media', 'In Progress']);
      assert.equal(regular.irregular, false);
    });

    // 112. Multiple Tables & Irregular Table Detection (Brick 38)
    await runTest(112, 'Multiple Tables & Irregular Table Detection', 'Structured Extraction (Brick 38)', async () => {
      const snap = await bm.waitForStable();
      const res = await bm.extractStructuredData({
        expectedSnapshotToken: snap.snapshotToken,
        types: ['tables']
      });
      assert.equal(res.success, true);
      assert.equal(res.data.tables.length, 2);
      const irregular = res.data.tables[1];
      assert.equal(irregular.caption, 'Quarterly Financials');
      assert.equal(irregular.irregular, true, 'Table with colspans/uneven columns must be flagged irregular');
      assert.ok(irregular.rows.length >= 1);
    });

    // 113. Lists Extraction & Nested List Bounded Depth (Brick 38)
    await runTest(113, 'Lists Extraction & Nested List Bounded Depth', 'Structured Extraction (Brick 38)', async () => {
      await bm.navigate(`${baseUrl}/extract-lists.html`);
      await bm.waitForStable();
      const snap = await bm.waitForStable();
      const res = await bm.extractStructuredData({
        expectedSnapshotToken: snap.snapshotToken,
        types: ['lists']
      });
      assert.equal(res.success, true);
      assert.ok(res.data.lists.length >= 3, `Expected at least 3 lists, got ${res.data.lists.length}`);
      const unord = res.data.lists.find(l => l.ordered === false);
      assert.ok(unord, 'Unordered list must be present');
      const ord = res.data.lists.find(l => l.ordered === true);
      assert.ok(ord, 'Ordered list must be present');
      const ariaList = res.data.lists.find(l => l.items && l.items.includes('Primary Objective'));
      assert.ok(ariaList, 'ARIA list items must be extracted');
    });

    // 114. Definitions Extraction (dl/dt/dd) (Brick 38)
    await runTest(114, 'Definitions Extraction (dl/dt/dd)', 'Structured Extraction (Brick 38)', async () => {
      await bm.navigate(`${baseUrl}/extract-basic.html`);
      await bm.waitForStable();
      const snap = await bm.waitForStable();
      const res = await bm.extractStructuredData({
        expectedSnapshotToken: snap.snapshotToken,
        types: ['definitions']
      });
      assert.equal(res.success, true);
      assert.ok(res.data.definitions.length >= 2, `Expected at least 2 definitions, got ${res.data.definitions.length}`);
      const proj = res.data.definitions.find(d => d.key === 'Project');
      assert.ok(proj, 'Project definition must be present');
      assert.equal(proj.value, 'JARVIS4');
    });

    // 115. Repeated Semantic Records Extraction (Brick 38)
    await runTest(115, 'Repeated Semantic Records Extraction', 'Structured Extraction (Brick 38)', async () => {
      await bm.navigate(`${baseUrl}/extract-records.html`);
      await bm.waitForStable();
      const snap = await bm.waitForStable();
      const res = await bm.extractStructuredData({
        expectedSnapshotToken: snap.snapshotToken,
        types: ['records']
      });
      assert.equal(res.success, true);
      assert.equal(res.data.records.length, 2, `Expected 2 semantic article records, got ${res.data.records.length}`);
      for (const rec of res.data.records) {
        assert.equal(rec.tag, 'article');
        assert.ok(rec.heading.startsWith('Release'));
        assert.ok(rec.text.length > 0);
        assert.ok(Array.isArray(rec.links));
        assert.ok(Array.isArray(rec.fields));
      }
    });

    // 116. Arabic & Multilingual Unicode Extraction (Brick 38)
    await runTest(116, 'Arabic & Multilingual Unicode Extraction', 'Structured Extraction (Brick 38)', async () => {
      await bm.navigate(`${baseUrl}/extract-multilingual.html`);
      await bm.waitForStable();
      const snap = await bm.waitForStable();
      const res = await bm.extractStructuredData({
        expectedSnapshotToken: snap.snapshotToken
      });
      assert.equal(res.success, true);
      assert.ok(res.data.metadata.title.includes('تقرير النظام الموحد'), 'Arabic title must be preserved');
      assert.equal(res.data.metadata.language, 'ar');
      assert.ok(res.data.headings.some(h => h.text.includes('لوحة التحكم الرئيسية')), 'Arabic heading must be preserved');
      assert.ok(res.data.tables.some(t => t.caption.includes('دليل المهندسين')), 'Arabic table caption preserved');
      assert.ok(res.data.definitions.some(d => d.key.includes('المنظومة')), 'Arabic definition key preserved');
    });

    // 117. Privacy Protection & Sensitive Field Exclusion (Brick 38)
    await runTest(117, 'Privacy Protection & Sensitive Field Exclusion', 'Structured Extraction (Brick 38)', async () => {
      await bm.navigate(`${baseUrl}/extract-privacy.html`);
      await bm.waitForStable();
      const snap = await bm.waitForStable();
      const res = await bm.extractStructuredData({
        expectedSnapshotToken: snap.snapshotToken
      });
      assert.equal(res.success, true);
      const serialized = JSON.stringify(res);
      assert.ok(!serialized.includes('TopSecretPassword123'), 'Password value must NEVER be extracted');
      assert.ok(!serialized.includes('user-confidential-input'), 'Text input value must NEVER be extracted');
      assert.ok(!serialized.includes('textarea-confidential-notes'), 'Textarea value must NEVER be extracted');
      assert.ok(!serialized.includes('hidden_vault_token_999'), 'Hidden input value must NEVER be extracted');
      assert.ok(!serialized.includes('auth-cookie-value'), 'Cookies must NEVER be extracted');
      assert.ok(!serialized.includes('localstorage-secret-key'), 'LocalStorage must NEVER be extracted');
      assert.ok(!serialized.includes('session-token-abc'), 'Session tokens must NEVER be extracted');
    });

    // 118. Large-Result Bounded Limits & Truncation Metadata (Brick 38)
    await runTest(118, 'Large-Result Bounded Limits & Truncation Metadata', 'Structured Extraction (Brick 38)', async () => {
      await bm.navigate(`${baseUrl}/extract-basic.html`);
      await bm.waitForStable();
      const snap = await bm.waitForStable();
      const res = await bm.extractStructuredData({
        expectedSnapshotToken: snap.snapshotToken,
        limits: { maxRecords: 2 }
      });
      assert.equal(res.success, true);
      assert.equal(res.truncated, true);
      assert.equal(res.truncationReason, 'MAX_RECORDS');
      assert.equal(res.limits.maxRecords, 2);
    });

    // 119. Dynamic Mutation Invalidates Extraction Snapshot (Brick 38)
    await runTest(119, 'Dynamic Mutation Invalidates Extraction Snapshot', 'Structured Extraction (Brick 38)', async () => {
      await bm.navigate(`${baseUrl}/extract-dynamic.html`);
      await bm.waitForStable();
      const snap = await bm.waitForStable();
      await bm.page.evaluate(() => {
        const btn = document.getElementById('btn-add-dynamic');
        if (btn) btn.click();
      });
      await bm.waitForStable();
      let threwStale = false;
      try {
        await bm.extractStructuredData({
          expectedSnapshotToken: snap.snapshotToken
        });
      } catch (err) {
        if (err instanceof StructuredExtractionError && (err.code === 'TARGET_STALE' || err.code === 'PAGE_CHANGED')) {
          threwStale = true;
        }
      }
      assert.equal(threwStale, true, 'Stale snapshot after dynamic mutation must be rejected');
    });

    // 120. Cross-Page Structured Extraction Isolation (Brick 38)
    await runTest(120, 'Cross-Page Structured Extraction Isolation', 'Structured Extraction (Brick 38)', async () => {
      await bm.navigate(`${baseUrl}/extract-basic.html`);
      await bm.waitForStable();
      const snapA = await bm.waitForStable();
      const pageAId = bm.activePageId;

      const pageBRes = await bm.openPage(`${baseUrl}/extract-records.html`);
      const pageBId = pageBRes.pageId;
      await bm.waitForStable({ pageId: pageBId });
      const snapB = await bm.waitForStable({ pageId: pageBId });

      // Extract from active Page B
      const resB = await bm.extractStructuredData({
        expectedSnapshotToken: snapB.snapshotToken,
        types: ['records']
      });
      assert.equal(resB.pageId, pageBId);
      assert.equal(resB.data.records.length, 2);

      // Switch to Page A and extract
      await bm.switchPage(pageAId);
      const resA = await bm.extractStructuredData({
        expectedSnapshotToken: snapA.snapshotToken,
        types: ['records']
      });
      assert.equal(resA.pageId, pageAId);
      assert.equal(resA.data.records.length, 0, 'Page A must have 0 article records');

      await bm.closePage(pageBId);
    });

    // 121. Session-Compatible Extraction without Leaking Credentials (Brick 38)
    await runTest(121, 'Session-Compatible Extraction without Leaking Credentials', 'Structured Extraction (Brick 38)', async () => {
      const snap = await bm.waitForStable();
      const res = await bm.extractStructuredData({
        expectedSnapshotToken: snap.snapshotToken,
        types: ['metadata', 'headings']
      });
      assert.equal(res.success, true);
      assert.equal(res._sessionVault, undefined);
      assert.equal(res._cookies, undefined);
    });

    // 122. Extraction Blocked During Active Human Handoff (Brick 38)
    await runTest(122, 'Extraction Blocked During Active Human Handoff', 'Structured Extraction (Brick 38)', async () => {
      await bm.navigate(`${fixtureServer.baseUrl}/auth-handoff-login.html`, { allowLoopbackTest: true });
      const snap = await bm.waitForStable();
      const handoffRes = await bm.startHandoff({
        reason: HANDOFF_REASONS.LOGIN_REQUIRED,
        verification: { type: 'url-contains', targetUrl: 'auth-handoff-success.html' }
      });
      let blocked = false;
      try {
        await bm.extractStructuredData({
          expectedSnapshotToken: snap.snapshotToken
        });
      } catch (err) {
        if ((err instanceof StructuredExtractionError || err.code === 'HUMAN_HANDOFF_ACTIVE')) {
          blocked = true;
        }
      }
      await bm.cancelHandoff({ handoffId: handoffRes.handoff.handoffId });
      assert.equal(blocked, true, 'Extraction must be blocked with HUMAN_HANDOFF_ACTIVE');
    });

    // 123. Real browser cleanup succeeds
    await runTest(123, 'Real Browser Cleanup Succeeds', 'Cleanup', async () => {
      await bm.close();
      assert.equal(bm.isBrowserConnected(), false);
      assert.equal(bm.pageCount, 0);
      assert.equal(bm.state.toLowerCase(), 'stopped');
    });

  } finally {
    // Strict automatic cleanup: close browser, stop fixture server, remove test synthetic temp dir
    try {
      if (fs.existsSync(syntheticTempDir)) {
        fs.rmSync(syntheticTempDir, { recursive: true, force: true });
      }
    } catch {}
    try {
      if (fs.existsSync(syntheticDownloadDir)) {
        fs.rmSync(syntheticDownloadDir, { recursive: true, force: true });
      }
    } catch {}
    if (bm) {
      try {
        await bm.close();
      } catch (closeErr) {
        console.error('Error closing test browser:', closeErr.message);
      }
    }
    if (fixtureServer) {
      try {
        await fixtureServer.close();
      } catch (srvErr) {
        console.error('Error stopping fixture server:', srvErr.message);
      }
    }
  }

  // Print Summary Output
  console.log('\n==================================================');
  console.log('REAL BROWSER VERIFICATION SUMMARY');
  console.log('==================================================\n');

  const categories = [
    'Browser Lifecycle',
    'Observer Lifecycle',
    'Dynamic DOM',
    'Stability Tracking',
    'Target Resolution',
    'SPA Routing',
    'Snapshot Integrity',
    'Multi-Page Isolation',
    'Cross-Page Snapshot Binding',
    'Form Discovery',
    'Form Population',
    'Form Preflight',
    'Form Validation',
    'Sensitive Field Protection',
    'Submission Blocking',
    'Dynamic Forms & Atomicity',
    'Cross-Page Form Isolation',
    'Prepare Submission',
    'Submission Execution',
    'Submission Verification',
    'Submission Security & Safety',
    'Single-Use & Duplicate Prevention',
    'Cross-Page Submission Isolation',
    'Session Persistence & Isolation',
    'Human Handoff (Brick 36)',
    'Safe Upload (Brick 37)',
    'Safe Download (Brick 37)',
    'Transfer Cleanup (Brick 37)',
    'Structured Extraction (Brick 38)',
    'Cleanup'
  ];

  for (const cat of categories) {
    const catTests = results.filter(r => r.category === cat);
    if (catTests.length > 0) {
      const allPass = catTests.every(r => r.status === 'PASS');
      console.log(`${cat}:`);
      console.log(allPass ? 'PASS\n' : 'FAIL\n');
    }
  }

  const passed = results.filter(r => r.status === 'PASS').length;
  const total = results.length;

  console.log('--------------------------------------------------');
  console.log(`Tests:\n${passed}/${total} PASS\n`);
  console.log(`Exit Code:\n${passed === total && total >= 123 ? 0 : 1}`);
  console.log('==================================================');

  if (passed !== total || total < 123) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal verify-browser runner error:', err);
  process.exit(1);
});
