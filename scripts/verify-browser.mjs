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
import { BrowserManager, FormInspectionError, FormPopulationError } from '../src/browser/browserManager.js';
import { startFixtureServer } from '../tests/browser-fixtures/server.js';
import { TargetResolutionError } from '../src/browser/targetResolver.js';
import { ActionExecutionError } from '../src/browser/actionExecutor.js';

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
        if (bm.page && typeof bm.page.screenshot === 'function' && !bm.page.isClosed?.()) {
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

    bm = new BrowserManager({
      allowTestLoopback: true,
      headless: process.env.HEADLESS !== 'false'
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

    // 48. Cleanup succeeds
    await runTest(48, 'Real Browser Cleanup Succeeds', 'Cleanup', async () => {
      await bm.close();
      assert.equal(bm.isBrowserConnected(), false);
      assert.equal(bm.pageCount, 0);
      assert.equal(bm.state.toLowerCase(), 'stopped');
    });

  } finally {
    // Strict automatic cleanup: close browser, stop fixture server
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
  console.log(`Exit Code:\n${passed === total && total >= 48 ? 0 : 1}`);
  console.log('==================================================');

  if (passed !== total || total < 48) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal verify-browser runner error:', err);
  process.exit(1);
});
