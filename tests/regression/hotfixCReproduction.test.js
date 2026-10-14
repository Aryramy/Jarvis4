/**
 * Deterministic Offline Regression Test: Hotfix C Atomic Page Context.
 * 
 * Invariants:
 * - Deterministic, offline, no browser launch, no network dependency (Level 1).
 * - Exercises exact Hotfix C cross-page snapshot contamination sequence:
 *   1. Open Page A (contains semantic link: 'Explicit waits')
 *   2. Open Page B (contains semantic link: 'Learn more')
 *   3. Wait for stable on Page B (generates new snapshot on Page B)
 *   4. Switch to Page A
 *   5. Resolve target: link / 'Explicit waits'
 * 
 * Required assertions:
 * - resolved.pageId == Page A pageId (NEVER Page B)
 * - resolved.snapshotToken == Page A snapshot identity (NEVER Page B)
 * - resolved.semanticRevision == Page A revision
 * - resolved.documentVersion == Page A document
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager } from '../../src/browser/browserManager.js';

function createMockEnvironment() {
  const pages = [];
  const contextListeners = new Map();

  function createMockPage(initialUrl = 'about:blank', initialTitle = 'Page') {
    const pageListeners = new Map();
    let currentUrl = initialUrl;
    let currentTitle = initialTitle;
    let closed = false;

    const p = {
      bringToFrontCalls: 0,
      bringToFront: async () => { p.bringToFrontCalls++; },
      addInitScript: async () => {},
      evaluate: async (fn, ...args) => {
        // Return semantic snapshot elements depending on URL
        if (currentUrl.includes('page=B') || currentUrl.includes('page-b')) {
          return {
            visibleText: 'Learn more',
            textTruncated: false,
            elements: [
              {
                index: 0,
                tag: 'a',
                tagName: 'a',
                kind: 'link',
                role: 'link',
                text: 'Learn more',
                visibleText: 'Learn more',
                href: '#learn',
                eligible: true,
                disabled: false
              }
            ],
            returnedElementCount: 1,
            totalEligibleElementCount: 1
          };
        }
        return {
          visibleText: 'Explicit waits',
          textTruncated: false,
          elements: [
            {
              index: 0,
              tag: 'a',
              tagName: 'a',
              kind: 'link',
              role: 'link',
              text: 'Explicit waits',
              visibleText: 'Explicit waits',
              href: '#explicit',
              eligible: true,
              disabled: false
            }
          ],
          returnedElementCount: 1,
          totalEligibleElementCount: 1
        };
      },
      goto: async (url) => {
        currentUrl = url;
        return { status: () => 200, request: () => ({ url: () => url, redirectedFrom: () => null }) };
      },
      url: () => currentUrl,
      title: async () => currentTitle,
      isClosed: () => closed,
      close: async () => {
        closed = true;
        const cbs = pageListeners.get('close') || [];
        for (const cb of cbs) try { cb(); } catch {}
      },
      on: (event, handler) => {
        if (!pageListeners.has(event)) pageListeners.set(event, []);
        pageListeners.get(event).push(handler);
      }
    };
    pages.push(p);
    return p;
  }

  const mockContext = {
    newPage: async () => {
      const p = createMockPage();
      const cbs = contextListeners.get('page') || [];
      for (const cb of cbs) try { cb(p); } catch {}
      return p;
    },
    on: (event, handler) => {
      if (!contextListeners.has(event)) contextListeners.set(event, []);
      contextListeners.get(event).push(handler);
    },
    close: async () => {}
  };

  const mockBrowser = {
    newContext: async () => mockContext,
    on: () => {},
    close: async () => {}
  };

  const launcher = async () => mockBrowser;

  return { launcher, pages };
}

test('Hotfix C Regression: Atomic Page Context & Cross-page snapshot isolation', async (t) => {
  const { launcher } = createMockEnvironment();
  const browserManager = new BrowserManager({ launcher });

  await browserManager.launch();

  // 1. Open Page A
  const pageARes = await browserManager.openPage('https://example.com/page?page=A');
  const pageAId = pageARes.pageId;
  assert.ok(pageAId, 'Page A should have pageId');
  const pageASnapshotBefore = browserManager.getSnapshotToken(pageAId);

  // 2. Open Page B
  const pageBRes = await browserManager.openPage('https://example.com/page?page=B');
  const pageBId = pageBRes.pageId;
  assert.ok(pageBId, 'Page B should have pageId');
  assert.notEqual(pageAId, pageBId, 'Page A and Page B must have distinct pageIds');

  // 3. Wait for stable on Page B (invalidates and generates fresh snapshot for B)
  const stableB = await browserManager.waitForStable({
    pageId: pageBId,
    sleeper: async () => {}
  });
  const pageBSnapshot = stableB.snapshotToken;
  assert.ok(pageBSnapshot, 'Page B should have fresh snapshotToken');

  // 4. Switch back to Page A
  await browserManager.switchPage(pageAId);
  assert.equal(browserManager.activePageId, pageAId, 'Active page must be Page A');

  // 5. Resolve link 'Explicit waits' on Page A
  const resolved = await browserManager.resolveTarget({
    kind: 'link',
    text: 'Explicit waits'
  });

  // Assertions strictly per specification:
  // 1. resolved pageId == Page A pageId (NEVER Page B)
  assert.equal(resolved.pageId, pageAId, `Expected resolved.pageId to be Page A (${pageAId}) but was ${resolved.pageId}`);

  // 2. snapshotToken == Page A snapshot identity (NEVER Page B)
  const pageACurrentSnapshot = browserManager.getSnapshotToken(pageAId);
  assert.notEqual(resolved.snapshotToken, pageBSnapshot, `Defect! resolved.snapshotToken (${resolved.snapshotToken}) is Page B snapshot (${pageBSnapshot})!`);
  assert.equal(resolved.snapshotToken, pageACurrentSnapshot, `Expected resolved.snapshotToken to match Page A snapshot`);

  // 3. semanticRevision == Page A revision
  const pageAEntry = browserManager._pages.get(pageAId);
  assert.equal(resolved.semanticRevision, pageAEntry.semanticRevision, `Expected semanticRevision to match Page A`);

  // 4. documentVersion == Page A document
  assert.equal(resolved.documentVersion, pageAEntry.documentVersion, `Expected documentVersion to match Page A`);

  await browserManager.close();
});
