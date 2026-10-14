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
import { BrowserManager } from '../src/browser/browserManager.js';
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
  console.log(`Exit Code:\n${passed === total && total >= 25 ? 0 : 1}`);
  console.log('==================================================');

  if (passed !== total || total < 25) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal verify-browser runner error:', err);
  process.exit(1);
});
