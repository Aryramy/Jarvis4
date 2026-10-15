/**
 * Contract Tests for DOM Context Endpoints and Scoped Operations (Brick 39).
 *
 * Validates HTTP route contract for:
 * - GET /api/browser/contexts
 * - POST /api/browser/contexts
 * - POST /api/browser/inspect-contexts
 * - Scoped POST /api/browser/inspect-page & POST /api/browser/inspect
 * - Scoped POST /api/browser/resolve-target
 * - Scoped POST /api/browser/action
 * - Subcontext form submit rejection
 * - Human handoff exclusion in subcontexts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../../src/web/server.js';
import { DomContextError, CONTEXT_TYPES } from '../../src/browser/domContextManager.js';
import { BrowserManagerError } from '../../src/browser/browserManager.js';

describe('DOM Context Endpoints Contract Tests (Brick 39)', () => {
  let server;
  let port;
  let baseUrl;
  let mockBrowserManager;

  before(async () => {
    mockBrowserManager = {
      inspectContexts: async (pageId) => {
        if (pageId === 'invalid-page') {
          throw new DomContextError('Page "invalid-page" not found or closed.', 'PAGE_NOT_FOUND', { pageId });
        }
        if (pageId === 'handoff-page') {
          throw new DomContextError('A human authentication handoff is active.', 'HUMAN_HANDOFF_ACTIVE', { pageId });
        }

        return {
          success: true,
          pageId: pageId || 'page_active_1',
          contextCount: 2,
          contexts: [
            {
              contextId: 'ctx_main_page_active_1',
              type: CONTEXT_TYPES.MAIN,
              parentContextId: null,
              depth: 0,
              url: 'http://127.0.0.1/main.html',
              attached: true
            },
            {
              contextId: 'ctx_frame_123',
              type: CONTEXT_TYPES.FRAME,
              parentContextId: 'ctx_main_page_active_1',
              depth: 1,
              url: 'http://127.0.0.1/child.html',
              name: 'child-frame',
              sameOrigin: true,
              attached: true
            }
          ],
          contextLimitReached: false,
          maxDepthReached: false,
          closedShadowRootDetected: false
        };
      },

      inspectPage: async (options = {}) => {
        if (options.contextId === 'ctx_closed_shadow') {
          throw new DomContextError('Closed shadow roots are not supported.', 'CLOSED_SHADOW_ROOT_UNSUPPORTED');
        }
        if (options.contextId === 'ctx_stale') {
          throw new DomContextError('Context is stale.', 'CONTEXT_STALE');
        }
        return {
          success: true,
          pageId: options.pageId || 'page_active_1',
          contextId: options.contextId || 'ctx_main_page_active_1',
          url: 'http://127.0.0.1/test.html',
          title: 'Test',
          returnedElementCount: 5,
          totalEligibleElementCount: 5
        };
      },

      resolveTarget: async (targetQuery, options = {}) => {
        if (options.contextId === 'ctx_bad') {
          throw new DomContextError('Context not found.', 'CONTEXT_NOT_FOUND');
        }
        return {
          success: true,
          resolution: 'unique',
          confidence: 'high',
          contextId: options.contextId || 'ctx_main_page_active_1',
          match: {
            targetId: 't_1',
            kind: targetQuery.kind || 'button',
            name: targetQuery.name || 'Test'
          }
        };
      },

      executeAction: async (request = {}) => {
        if (request.contextId === 'ctx_handoff') {
          throw new BrowserManagerError('Action blocked: human handoff active.', 'HUMAN_HANDOFF_ACTIVE');
        }
        if (request.contextId === 'ctx_detached') {
          throw new DomContextError('Context detached.', 'FRAME_DETACHED');
        }
        return {
          success: true,
          action: request.action,
          contextId: request.contextId || 'ctx_main_page_active_1',
          topLevelNavigationOccurred: false,
          frameNavigationOccurred: request.contextId === 'ctx_frame_123'
        };
      },

      submitForm: async (request = {}) => {
        if (request.contextId && request.contextId !== 'ctx_main_page_active_1') {
          throw new BrowserManagerError(
            'Confirmed submission inside subcontexts is not supported in Brick 39.',
            'SUBCONTEXT_SUBMISSION_NOT_SUPPORTED',
            { contextId: request.contextId }
          );
        }
        return { success: true, submitted: true };
      }
    };

    server = createServer({ browserManager: mockBrowserManager });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('GET & POST /api/browser/contexts (Section 8)', () => {
    it('returns contexts list for default active page on GET', async () => {
      const res = await fetch(`${baseUrl}/api/browser/contexts`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.contextCount, 2);
      assert.equal(data.contexts[0].type, 'main');
      assert.equal(data.contexts[1].type, 'frame');
    });

    it('returns contexts list on POST with pageId in body', async () => {
      const res = await fetch(`${baseUrl}/api/browser/contexts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: 'page_custom' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.pageId, 'page_custom');
    });

    it('returns 404 if pageId is not found', async () => {
      const res = await fetch(`${baseUrl}/api/browser/contexts?pageId=invalid-page`);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'PAGE_NOT_FOUND');
    });

    it('returns 409 if handoff is active', async () => {
      const res = await fetch(`${baseUrl}/api/browser/contexts?pageId=handoff-page`);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, 'HUMAN_HANDOFF_ACTIVE');
    });
  });

  describe('Scoped Inspection & Resolution (Section 9, 24)', () => {
    it('passes contextId to inspect-page and returns 200', async () => {
      const res = await fetch(`${baseUrl}/api/browser/inspect-page?contextId=ctx_frame_123`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.contextId, 'ctx_frame_123');
    });

    it('returns 400 when inspect target has closed shadow root', async () => {
      const res = await fetch(`${baseUrl}/api/browser/inspect-page?contextId=ctx_closed_shadow`);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'CLOSED_SHADOW_ROOT_UNSUPPORTED');
    });

    it('returns 409 when inspecting a stale context', async () => {
      const res = await fetch(`${baseUrl}/api/browser/inspect-page?contextId=ctx_stale`);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.code, 'CONTEXT_STALE');
    });

    it('passes contextId to resolve-target', async () => {
      const res = await fetch(`${baseUrl}/api/browser/resolve-target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: { kind: 'button', name: 'Submit' },
          contextId: 'ctx_frame_123'
        })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.contextId, 'ctx_frame_123');
    });
  });

  describe('Scoped Action & Boundaries (Sections 27, 28, 39)', () => {
    it('executes action in subcontext and distinguishes frame navigation', async () => {
      const res = await fetch(`${baseUrl}/api/browser/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { kind: 'button', name: 'Submit' },
          expectedSnapshotToken: 'snap_1',
          contextId: 'ctx_frame_123'
        })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.frameNavigationOccurred, true);
      assert.equal(data.topLevelNavigationOccurred, false);
    });

    it('returns 409 when action executed in detached context', async () => {
      const res = await fetch(`${baseUrl}/api/browser/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { kind: 'button', name: 'Submit' },
          expectedSnapshotToken: 'snap_1',
          contextId: 'ctx_detached'
        })
      });
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.code, 'FRAME_DETACHED');
    });

    it('returns 409 when action executed while human handoff is active', async () => {
      const res = await fetch(`${baseUrl}/api/browser/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'click',
          target: { kind: 'button', name: 'Submit' },
          expectedSnapshotToken: 'snap_1',
          contextId: 'ctx_handoff'
        })
      });
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.code, 'HUMAN_HANDOFF_ACTIVE');
    });

    it('rejects subcontext form submission with SUBCONTEXT_SUBMISSION_NOT_SUPPORTED', async () => {
      const res = await fetch(`${baseUrl}/api/browser/submit-form`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmationToken: 'tok_sub_123',
          contextId: 'ctx_frame_123'
        })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'SUBCONTEXT_SUBMISSION_NOT_SUPPORTED');
    });
  });
});
