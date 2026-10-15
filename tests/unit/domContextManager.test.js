import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DomContextManager,
  DomContextError,
  CONTEXT_TYPES,
  generateContextId
} from '../../src/browser/domContextManager.js';

describe('DomContextManager Unit Tests (Brick 39)', () => {
  describe('Context Identity and Formatting (Section 5)', () => {
    test('generateContextId formats main context predictably with pageId', () => {
      const id = generateContextId(CONTEXT_TYPES.MAIN, 'page_123');
      assert.equal(id, 'ctx_main_page_123');
    });

    test('generateContextId generates unique opaque IDs for frames and shadows', () => {
      const id1 = generateContextId(CONTEXT_TYPES.FRAME);
      const id2 = generateContextId(CONTEXT_TYPES.FRAME);
      const id3 = generateContextId(CONTEXT_TYPES.SHADOW_ROOT);

      assert.ok(id1.startsWith('ctx_frame_'));
      assert.ok(id2.startsWith('ctx_frame_'));
      assert.ok(id3.startsWith('ctx_shadow_'));
      assert.notEqual(id1, id2);
      assert.notEqual(id1, id3);
    });
  });

  describe('Registry & Lifecycle Management (Sections 7, 8, 11)', () => {
    test('initializes with main context', () => {
      const mockPageEntry = {
        pageId: 'test_p1',
        documentVersion: 1,
        semanticRevision: 1,
        snapshotVersion: 1,
        snapshotToken: 'snap_main_1',
        currentUrl: 'http://127.0.0.1/test.html',
        page: {
          url: () => 'http://127.0.0.1/test.html',
          mainFrame: () => ({ name: () => '', url: () => 'http://127.0.0.1/test.html' }),
          on: () => {},
          removeListener: () => {}
        }
      };

      const mgr = new DomContextManager({
        pageId: 'test_p1',
        pageEntry: mockPageEntry
      });

      assert.equal(mgr.contextCount, 1);
      assert.equal(mgr.mainContextId, 'ctx_main_test_p1');

      const mainCtx = mgr.resolveContext();
      assert.equal(mainCtx.contextId, 'ctx_main_test_p1');
      assert.equal(mainCtx.type, CONTEXT_TYPES.MAIN);
      assert.equal(mainCtx.depth, 0);
      assert.equal(mainCtx.parentContextId, null);
      assert.equal(mainCtx.attached, true);
    });

    test('handles frame attached, navigated, and detached events', () => {
      const listeners = {};
      const mockPage = {
        url: () => 'http://127.0.0.1/main.html',
        mainFrame: () => mockMainFrame,
        on: (ev, fn) => { listeners[ev] = fn; },
        removeListener: (ev) => { delete listeners[ev]; }
      };
      const mockMainFrame = { name: () => '', url: () => 'http://127.0.0.1/main.html', parentFrame: () => null };

      const mockEntry = {
        pageId: 'p_events',
        page: mockPage
      };

      const mgr = new DomContextManager({ pageId: 'p_events', pageEntry: mockEntry });

      const mockChildFrame = {
        name: () => 'child-frame-1',
        url: () => 'http://127.0.0.1/child.html',
        parentFrame: () => mockMainFrame
      };

      // 1. Frame attached
      listeners.frameattached(mockChildFrame);
      assert.equal(mgr.contextCount, 2);

      const frameCtxId = Array.from(mgr._contexts.keys()).find(k => k !== mgr.mainContextId);
      assert.ok(frameCtxId.startsWith('ctx_frame_'));
      const frameCtx = mgr.resolveContext(frameCtxId);
      assert.equal(frameCtx.type, CONTEXT_TYPES.FRAME);
      assert.equal(frameCtx.depth, 1);
      assert.equal(frameCtx.parentContextId, mgr.mainContextId);
      assert.equal(frameCtx.url, 'http://127.0.0.1/child.html');
      assert.equal(frameCtx.name, 'child-frame-1');

      // 2. Frame navigated
      const oldRev = frameCtx.semanticRevision;
      const oldToken = frameCtx.snapshotToken;
      mockChildFrame.url = () => 'http://127.0.0.1/child-navigated.html';
      listeners.framenavigated(mockChildFrame);

      const navCtx = mgr.resolveContext(frameCtxId);
      assert.equal(navCtx.url, 'http://127.0.0.1/child-navigated.html');
      assert.equal(navCtx.documentVersion, 2);
      assert.equal(navCtx.semanticRevision, 1);
      assert.notEqual(navCtx.snapshotToken, oldToken);

      // 3. Frame detached
      listeners.framedetached(mockChildFrame);
      assert.equal(mgr.contextCount, 1);
      assert.throws(() => mgr.resolveContext(frameCtxId), (err) => err.code === 'CONTEXT_NOT_FOUND');
    });

    test('reconciles nested frames correctly', () => {
      const listeners = {};
      const mockMainFrame = { name: () => '', url: () => 'http://127.0.0.1/main.html', parentFrame: () => null };
      const mockPage = {
        url: () => 'http://127.0.0.1/main.html',
        mainFrame: () => mockMainFrame,
        on: (ev, fn) => { listeners[ev] = fn; },
        removeListener: () => {}
      };

      const mgr = new DomContextManager({ pageId: 'p_nested', pageEntry: { pageId: 'p_nested', page: mockPage } });

      const level1Frame = {
        name: () => 'level1',
        url: () => 'http://127.0.0.1/l1.html',
        parentFrame: () => mockMainFrame
      };
      const level2Frame = {
        name: () => 'level2',
        url: () => 'http://127.0.0.1/l2.html',
        parentFrame: () => level1Frame
      };

      listeners.frameattached(level1Frame);
      listeners.frameattached(level2Frame);

      const l1CtxId = mgr._frameToContextId.get(level1Frame);
      const l2CtxId = mgr._frameToContextId.get(level2Frame);

      const l1Ctx = mgr.resolveContext(l1CtxId);
      const l2Ctx = mgr.resolveContext(l2CtxId);

      assert.equal(l1Ctx.depth, 1);
      assert.equal(l1Ctx.parentContextId, mgr.mainContextId);

      assert.equal(l2Ctx.depth, 2);
      assert.equal(l2Ctx.parentContextId, l1CtxId);
    });
  });

  describe('Shadow DOM Discovery & Limits (Sections 10, 11, 14)', () => {
    test('discoverContexts finds open shadow roots and tracks depth', async () => {
      const mockMainFrame = { name: () => '', url: () => 'http://127.0.0.1/main.html', parentFrame: () => null };
      const mockPage = {
        isClosed: () => false,
        url: () => 'http://127.0.0.1/main.html',
        mainFrame: () => mockMainFrame,
        frames: () => [mockMainFrame],
        on: () => {},
        removeListener: () => {},
        evaluate: async () => {
          return {
            shadowRoots: [
              {
                shadowHandleId: 'sh_outer_1',
                parentShadowHandleId: null,
                depth: 1,
                host: { tag: 'custom-card', accessibleName: 'Card Widget', role: 'region' },
                semanticRevision: 1,
                lastRelevantMutationTime: Date.now()
              },
              {
                shadowHandleId: 'sh_inner_2',
                parentShadowHandleId: 'sh_outer_1',
                depth: 2,
                host: { tag: 'custom-button', accessibleName: 'Inner Action', role: 'button' },
                semanticRevision: 1,
                lastRelevantMutationTime: Date.now()
              }
            ],
            closedShadowRootDetected: false
          };
        }
      };

      const mgr = new DomContextManager({ pageId: 'p_shadow', pageEntry: { pageId: 'p_shadow', page: mockPage } });
      const disc = await mgr.discoverContexts();

      assert.equal(disc.contextCount, 3); // main + outer shadow + inner shadow
      assert.equal(disc.closedShadowRootDetected, false);
      assert.equal(disc.contextLimitReached, false);
      assert.equal(disc.maxDepthReached, false);

      const outerCtx = disc.contexts.find(c => c.type === CONTEXT_TYPES.SHADOW_ROOT && c.depth === 1);
      const innerCtx = disc.contexts.find(c => c.type === CONTEXT_TYPES.SHADOW_ROOT && c.depth === 2);

      assert.ok(outerCtx);
      assert.ok(innerCtx);
      assert.equal(outerCtx.parentContextId, mgr.mainContextId);
      assert.equal(innerCtx.parentContextId, outerCtx.contextId);
      assert.equal(outerCtx.host.tag, 'custom-card');
      assert.equal(innerCtx.host.tag, 'custom-button');
    });

    test('enforces maxDomContexts limit', async () => {
      const mockMainFrame = { name: () => '', url: () => 'http://127.0.0.1/main.html', parentFrame: () => null };
      const mockPage = {
        isClosed: () => false,
        url: () => 'http://127.0.0.1/main.html',
        mainFrame: () => mockMainFrame,
        frames: () => [mockMainFrame],
        on: () => {},
        removeListener: () => {},
        evaluate: async () => {
          const list = [];
          for (let i = 0; i < 10; i++) {
            list.push({
              shadowHandleId: `sh_${i}`,
              parentShadowHandleId: null,
              depth: 1,
              host: { tag: `custom-${i}` },
              semanticRevision: 1,
              lastRelevantMutationTime: Date.now()
            });
          }
          return { shadowRoots: list, closedShadowRootDetected: false };
        }
      };

      const mgr = new DomContextManager({
        pageId: 'p_limit',
        pageEntry: { pageId: 'p_limit', page: mockPage },
        maxDomContexts: 4 // low limit for test
      });

      const disc = await mgr.discoverContexts();
      assert.equal(disc.contextCount, 4);
      assert.equal(disc.contextLimitReached, true);
    });

    test('enforces maxContextDepth limit', async () => {
      const mockMainFrame = { name: () => '', url: () => 'http://127.0.0.1/main.html', parentFrame: () => null };
      const mockPage = {
        isClosed: () => false,
        url: () => 'http://127.0.0.1/main.html',
        mainFrame: () => mockMainFrame,
        frames: () => [mockMainFrame],
        on: () => {},
        removeListener: () => {},
        evaluate: async () => {
          return {
            shadowRoots: [
              {
                shadowHandleId: 'sh_deep',
                parentShadowHandleId: null,
                depth: 5,
                host: { tag: 'too-deep' },
                semanticRevision: 1,
                lastRelevantMutationTime: Date.now()
              }
            ],
            closedShadowRootDetected: false
          };
        }
      };

      const mgr = new DomContextManager({
        pageId: 'p_depth',
        pageEntry: { pageId: 'p_depth', page: mockPage },
        maxContextDepth: 3
      });

      const disc = await mgr.discoverContexts();
      assert.equal(disc.maxDepthReached, true);
      assert.equal(disc.contexts.some(c => c.host?.tag === 'too-deep'), false);
    });

    test('reports closedShadowRootDetected when closed shadow root exists', async () => {
      const mockMainFrame = { name: () => '', url: () => 'http://127.0.0.1/main.html', parentFrame: () => null };
      const mockPage = {
        isClosed: () => false,
        url: () => 'http://127.0.0.1/main.html',
        mainFrame: () => mockMainFrame,
        frames: () => [mockMainFrame],
        on: () => {},
        removeListener: () => {},
        evaluate: async () => ({ shadowRoots: [], closedShadowRootDetected: true })
      };

      const mgr = new DomContextManager({ pageId: 'p_closed', pageEntry: { pageId: 'p_closed', page: mockPage } });
      const disc = await mgr.discoverContexts();
      assert.equal(disc.closedShadowRootDetected, true);
    });
  });

  describe('Snapshot Tokens & Dynamic Isolation (Sections 21, 22, 23, 31)', () => {
    test('validates snapshot token strictly within its own context', () => {
      const mockMainFrame = { name: () => '', url: () => 'http://127.0.0.1/main.html', parentFrame: () => null };
      const mockPage = {
        url: () => 'http://127.0.0.1/main.html',
        mainFrame: () => mockMainFrame,
        on: () => {},
        removeListener: () => {}
      };

      const mgr = new DomContextManager({ pageId: 'p_snap', pageEntry: { pageId: 'p_snap', page: mockPage } });
      const mainCtx = mgr.resolveContext();
      const mainToken = mainCtx.snapshotToken;

      assert.equal(mgr.isSnapshotValid(mainToken), true);
      assert.equal(mgr.isSnapshotValid(mainToken, mainCtx.contextId), true);
      assert.equal(mgr.isSnapshotValid('invalid_token', mainCtx.contextId), false);

      // Create a subcontext
      const frame = { name: () => 'subframe', url: () => 'http://127.0.0.1/sub.html', parentFrame: () => mockMainFrame };
      mgr._handleFrameAttached(frame);

      const frameCtxId = mgr._frameToContextId.get(frame);
      const frameCtx = mgr.resolveContext(frameCtxId);
      const frameToken = frameCtx.snapshotToken;

      assert.ok(frameToken);
      assert.notEqual(mainToken, frameToken);

      // Main token cannot validate subcontext (cross-context rejection)
      assert.equal(mgr.isSnapshotValid(mainToken, frameCtxId), false);
      // Frame token cannot validate main context
      assert.equal(mgr.isSnapshotValid(frameToken, mainCtx.contextId), false);
      // Frame token validates its own context
      assert.equal(mgr.isSnapshotValid(frameToken, frameCtxId), true);
    });

    test('dynamic mutation in subcontext isolates from main context', () => {
      const mockMainFrame = { name: () => '', url: () => 'http://127.0.0.1/main.html', parentFrame: () => null };
      const mockPage = {
        url: () => 'http://127.0.0.1/main.html',
        mainFrame: () => mockMainFrame,
        on: () => {},
        removeListener: () => {}
      };

      const mgr = new DomContextManager({ pageId: 'p_iso', pageEntry: { pageId: 'p_iso', page: mockPage } });
      const mainCtx = mgr.resolveContext();
      const mainRevBefore = mainCtx.semanticRevision;

      const frame = { name: () => 'subframe', url: () => 'http://127.0.0.1/sub.html', parentFrame: () => mockMainFrame };
      mgr._handleFrameAttached(frame);
      const frameCtxId = mgr._frameToContextId.get(frame);
      const frameCtx = mgr.resolveContext(frameCtxId);
      const frameRevBefore = frameCtx.semanticRevision;

      // Touch mutation in frame context only
      mgr.touchMutation(frameCtxId);

      assert.equal(mainCtx.semanticRevision, mainRevBefore); // Main unchanged
      assert.equal(frameCtx.semanticRevision, frameRevBefore + 1); // Frame updated
    });

    test('destroy clears all contexts and invalidates tokens', () => {
      const mockMainFrame = { name: () => '', url: () => 'http://127.0.0.1/main.html', parentFrame: () => null };
      const mockPage = {
        url: () => 'http://127.0.0.1/main.html',
        mainFrame: () => mockMainFrame,
        on: () => {},
        removeListener: () => {}
      };

      const mgr = new DomContextManager({ pageId: 'p_destroy', pageEntry: { pageId: 'p_destroy', page: mockPage } });
      const mainId = mgr.mainContextId;
      mgr.destroy();

      assert.equal(mgr.contextCount, 0);
      assert.throws(() => mgr.resolveContext(mainId), (err) => err.code === 'CONTEXT_NOT_FOUND');
    });
  });
});
