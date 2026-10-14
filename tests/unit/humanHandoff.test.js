import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  HumanHandoffManager,
  HumanHandoffError,
  HANDOFF_REASONS,
  HANDOFF_STATES,
  generateHandoffId,
  isValidHandoffId,
  clampHandoffTtl,
  toSafeHandoffMetadata,
  evaluateVerificationCondition
} from '../../src/browser/humanHandoff.js';
import { BrowserManager, BrowserManagerError, BROWSER_STATES } from '../../src/browser/browserManager.js';
import { registerTestConfirmationToken, getConfirmationToken } from '../../src/browser/formSubmitter.js';

describe('Human Handoff Subsystem Unit Tests (Brick 36)', () => {
  let mockBrowserManager;
  let handoffManager;

  function createMockPageEntry(pageId, options = {}) {
    const closed = options.closed || false;
    const entry = {
      pageId,
      currentUrl: options.url || 'https://example.com/login',
      title: options.title || 'Login Barrier',
      documentVersion: options.documentVersion || 1,
      semanticRevision: options.semanticRevision || 1,
      spaRouteVersion: options.spaRouteVersion || 1,
      snapshotToken: options.snapshotToken || 'snap_token_1'
    };

    entry.page = {
      isClosed: () => closed,
      close: async () => {},
      url: () => entry.currentUrl,
      title: async () => entry.title,
      evaluate: async (fn, arg) => {
        if (typeof fn === 'function') {
          return fn(arg);
        }
        return null;
      }
    };

    return entry;
  }

  function setupMockBrowserManager(pages = {}) {
    const pageEntries = new Map(Object.entries(pages));
    const activePageId = Object.keys(pages)[0] || 'page_default';

    return {
      activePageId,
      context: { id: 'ctx_mock_1' },
      loadedSessionId: null,
      pageCount: pageEntries.size,
      isBrowserConnected: () => true,
      getPageEntry: (id) => pageEntries.get(id) || null,
      getSnapshotToken: (id) => pageEntries.get(id)?.snapshotToken || null,
      syncDynamicState: async () => {},
      _invalidateSnapshot: (id) => {
        const entry = pageEntries.get(id);
        if (entry) {
          entry.snapshotToken = `snap_token_fresh_${Date.now()}`;
          return entry.snapshotToken;
        }
        return 'snap_token_fresh';
      },
      inspectPage: async ({ pageId }) => {
        const entry = pageEntries.get(pageId);
        return {
          success: true,
          url: entry?.currentUrl || 'https://example.com/login',
          title: entry?.title || 'Login Barrier',
          visibleText: optionsText,
          elements: optionsElements,
          snapshotToken: entry?.snapshotToken || 'snap_token_fresh'
        };
      }
    };
  }

  let optionsText = 'Sign in to access your account.';
  let optionsElements = [{ id: 'signin-btn', role: 'button', text: 'Sign in' }];

  beforeEach(() => {
    optionsText = 'Sign in to access your account.';
    optionsElements = [{ id: 'signin-btn', role: 'button', text: 'Sign in' }];
    const defaultPage = createMockPageEntry('page_1');
    mockBrowserManager = setupMockBrowserManager({ page_1: defaultPage });
    handoffManager = new HumanHandoffManager({
      browserManager: mockBrowserManager,
      defaultTtlMs: 300000
    });
  });

  describe('Opaque IDs and TTL Handling', () => {
    it('generates opaque handoff IDs matching handoff_<timestamp>_<hex>', () => {
      const id = generateHandoffId();
      assert.strictEqual(typeof id, 'string');
      assert.match(id, /^handoff_\d+_[a-f0-9]{16}$/);
      assert.strictEqual(isValidHandoffId(id), true);
    });

    it('rejects malformed handoff IDs', () => {
      assert.strictEqual(isValidHandoffId(''), false);
      assert.strictEqual(isValidHandoffId(null), false);
      assert.strictEqual(isValidHandoffId('handoff_user_123'), false);
      assert.strictEqual(isValidHandoffId('handoff_123_xyz'), false);
      assert.strictEqual(isValidHandoffId('sess_123456_abcdef12'), false);
    });

    it('clamps handoff TTL to bounded range [1000, 1800000] with default 300000', () => {
      assert.strictEqual(clampHandoffTtl(300000), 300000);
      assert.strictEqual(clampHandoffTtl(50), 1000);
      assert.strictEqual(clampHandoffTtl(-100), 1000);
      assert.strictEqual(clampHandoffTtl(5000000), 1800000);
      assert.strictEqual(clampHandoffTtl(null), 300000);
      assert.strictEqual(clampHandoffTtl('not-a-number'), 300000);
    });
  });

  describe('Reason Codes and Initialization', () => {
    it('supports all authorized reason codes with sensible safe guidance', async () => {
      const reasons = [
        HANDOFF_REASONS.LOGIN_REQUIRED,
        HANDOFF_REASONS.MFA_REQUIRED,
        HANDOFF_REASONS.CAPTCHA_REQUIRED,
        HANDOFF_REASONS.USER_INTERACTION_REQUIRED,
        HANDOFF_REASONS.CONSENT_REQUIRED,
        HANDOFF_REASONS.SESSION_EXPIRED
      ];

      for (const reason of reasons) {
        handoffManager.clear();
        const res = await handoffManager.startHandoff({ reason, pageId: 'page_1' });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.reason, reason);
        assert.strictEqual(res.status, HANDOFF_STATES.PAUSED_FOR_HUMAN);
        assert.strictEqual(typeof res.guidance, 'string');
        assert.ok(res.guidance.length > 0);
        assert.strictEqual(isValidHandoffId(res.handoffId), true);
      }
    });

    it('rejects unsupported reason codes with INVALID_HANDOFF_REASON', async () => {
      await assert.rejects(
        () => handoffManager.startHandoff({ reason: 'AUTO_SOLVE_CAPTCHA', pageId: 'page_1' }),
        (err) => err instanceof HumanHandoffError && err.code === 'INVALID_HANDOFF_REASON'
      );
    });

    it('rejects startHandoff when browser is not running', async () => {
      mockBrowserManager.isBrowserConnected = () => false;
      await assert.rejects(
        () => handoffManager.startHandoff({ reason: HANDOFF_REASONS.LOGIN_REQUIRED }),
        (err) => err instanceof HumanHandoffError && err.code === 'BROWSER_NOT_RUNNING'
      );
    });

    it('rejects startHandoff when target page is not found or closed', async () => {
      await assert.rejects(
        () => handoffManager.startHandoff({ reason: HANDOFF_REASONS.LOGIN_REQUIRED, pageId: 'non_existent' }),
        (err) => err instanceof HumanHandoffError && err.code === 'PAGE_NOT_FOUND'
      );
    });

    it('rejects startHandoff when snapshot token is stale', async () => {
      await assert.rejects(
        () => handoffManager.startHandoff({
          reason: HANDOFF_REASONS.LOGIN_REQUIRED,
          pageId: 'page_1',
          expectedSnapshotToken: 'snap_token_obsolete'
        }),
        (err) => err instanceof HumanHandoffError && err.code === 'TARGET_STALE'
      );
    });

    it('enforces single active handoff per page/context', async () => {
      await handoffManager.startHandoff({ reason: HANDOFF_REASONS.LOGIN_REQUIRED, pageId: 'page_1' });
      await assert.rejects(
        () => handoffManager.startHandoff({ reason: HANDOFF_REASONS.MFA_REQUIRED, pageId: 'page_1' }),
        (err) => err instanceof HumanHandoffError && err.code === 'HANDOFF_ALREADY_ACTIVE'
      );
    });

    it('invalidates pre-auth form confirmation tokens on handoff start', async () => {
      registerTestConfirmationToken('confirm_pre_auth_123', 'page_1');
      assert.ok(getConfirmationToken('confirm_pre_auth_123'));

      await handoffManager.startHandoff({ reason: HANDOFF_REASONS.LOGIN_REQUIRED, pageId: 'page_1' });
      assert.strictEqual(getConfirmationToken('confirm_pre_auth_123'), undefined);
    });
  });

  describe('Sensitive Observation and Diagnostic Screenshots Policy', () => {
    it('identifies sensitive handoff states correctly', async () => {
      assert.strictEqual(handoffManager.isSensitiveHandoffActive('page_1'), false);

      await handoffManager.startHandoff({ reason: HANDOFF_REASONS.LOGIN_REQUIRED, pageId: 'page_1' });
      assert.strictEqual(handoffManager.isSensitiveHandoffActive('page_1'), true);

      // Screenshot policy suppresses automatic screenshots
      const policy = handoffManager.canCaptureScreenshot('page_1');
      assert.strictEqual(policy.allowed, false);
      assert.strictEqual(policy.reason, 'SCREENSHOT_SUPPRESSED_DURING_AUTH');

      // Explicit user diagnostics are permitted
      const explicitPolicy = handoffManager.canCaptureScreenshot('page_1', { explicitUserRequest: true });
      assert.strictEqual(explicitPolicy.allowed, true);
    });

    it('resumes normal screenshot policy after handoff is cancelled or verified', async () => {
      const started = await handoffManager.startHandoff({ reason: HANDOFF_REASONS.CAPTCHA_REQUIRED, pageId: 'page_1' });
      assert.strictEqual(handoffManager.canCaptureScreenshot('page_1').allowed, false);

      await handoffManager.cancelHandoff(started.handoffId);
      assert.strictEqual(handoffManager.canCaptureScreenshot('page_1').allowed, true);
    });
  });

  describe('Lifecycle and Invalidation', () => {
    it('cancels active handoff when bound page is closed', async () => {
      const started = await handoffManager.startHandoff({ reason: HANDOFF_REASONS.LOGIN_REQUIRED, pageId: 'page_1' });
      assert.strictEqual(handoffManager.isHandoffActive('page_1'), true);

      handoffManager.onPageClosed('page_1');
      assert.strictEqual(handoffManager.isHandoffActive('page_1'), false);

      const status = handoffManager.getHandoff(started.handoffId);
      assert.strictEqual(status.status, HANDOFF_STATES.CANCELLED);
    });

    it('cancels active handoff when browser context is closed or replaced', async () => {
      const started = await handoffManager.startHandoff({ reason: HANDOFF_REASONS.MFA_REQUIRED, pageId: 'page_1' });
      assert.strictEqual(handoffManager.isHandoffActive('page_1'), true);

      handoffManager.onContextClosed();
      assert.strictEqual(handoffManager.isHandoffActive('page_1'), false);

      const status = handoffManager.getHandoff(started.handoffId);
      assert.strictEqual(status.status, HANDOFF_STATES.CANCELLED);
    });

    it('rejects resume on cancelled handoff with HANDOFF_ALREADY_COMPLETED', async () => {
      const started = await handoffManager.startHandoff({ reason: HANDOFF_REASONS.LOGIN_REQUIRED, pageId: 'page_1' });
      await handoffManager.cancelHandoff(started.handoffId);

      await assert.rejects(
        () => handoffManager.resumeHandoff({ handoffId: started.handoffId }),
        (err) => err instanceof HumanHandoffError && err.code === 'HANDOFF_ALREADY_COMPLETED'
      );
    });

    it('transitions to EXPIRED and rejects resume when TTL elapsed', async () => {
      const started = await handoffManager.startHandoff({
        reason: HANDOFF_REASONS.LOGIN_REQUIRED,
        pageId: 'page_1',
        ttlMs: 1000
      });

      // Advance internal record past expiry
      const record = handoffManager._handoffs.get(started.handoffId);
      record.expiresAtMs = Date.now() - 50;

      await assert.rejects(
        () => handoffManager.resumeHandoff({ handoffId: started.handoffId }),
        (err) => err instanceof HumanHandoffError && err.code === 'HANDOFF_EXPIRED'
      );
    });

    it('detects context change during resume and cancels handoff', async () => {
      const started = await handoffManager.startHandoff({ reason: HANDOFF_REASONS.LOGIN_REQUIRED, pageId: 'page_1' });

      // Simulate context instance replacement
      mockBrowserManager.context = { id: 'ctx_mock_2_replaced' };

      await assert.rejects(
        () => handoffManager.resumeHandoff({ handoffId: started.handoffId }),
        (err) => err instanceof HumanHandoffError && err.code === 'HANDOFF_CONTEXT_CHANGED'
      );
    });
  });

  describe('Resume and Deterministic Verification Contract', () => {
    it('evaluates url-changed verification condition', async () => {
      const started = await handoffManager.startHandoff({
        reason: HANDOFF_REASONS.LOGIN_REQUIRED,
        pageId: 'page_1',
        verification: { type: 'url-changed' }
      });

      // Before human action: url has not changed -> resume returns NOT_CLEARED
      const res1 = await handoffManager.resumeHandoff({ handoffId: started.handoffId });
      assert.strictEqual(res1.verified, false);
      assert.strictEqual(res1.status, HANDOFF_STATES.NOT_CLEARED);
      assert.strictEqual(res1.code, 'HANDOFF_NOT_CLEARED');

      // Human completes login in Edge: page navigates to dashboard
      const entry = mockBrowserManager.getPageEntry('page_1');
      entry.currentUrl = 'https://example.com/dashboard';
      entry.page.url = () => 'https://example.com/dashboard';

      // Explicit resume attempt 2 succeeds
      const res2 = await handoffManager.resumeHandoff({ handoffId: started.handoffId });
      assert.strictEqual(res2.verified, true);
      assert.strictEqual(res2.status, HANDOFF_STATES.VERIFIED);
      assert.strictEqual(res2.success, true);
    });

    it('evaluates target-absent and target-present verification condition', async () => {
      const started = await handoffManager.startHandoff({
        reason: HANDOFF_REASONS.MFA_REQUIRED,
        pageId: 'page_1',
        verification: { type: 'target-absent', targetText: 'Sign in' }
      });

      // Still showing 'Sign in' button -> fails
      const res1 = await handoffManager.resumeHandoff({ handoffId: started.handoffId });
      assert.strictEqual(res1.verified, false);

      // Human completes MFA: 'Sign in' button removed, 'Account' button present
      optionsElements = [{ id: 'account-btn', role: 'button', text: 'Account' }];
      const res2 = await handoffManager.resumeHandoff({ handoffId: started.handoffId });
      assert.strictEqual(res2.verified, true);
      assert.strictEqual(res2.status, HANDOFF_STATES.VERIFIED);
    });

    it('evaluates text-present and text-absent verification condition', async () => {
      const started = await handoffManager.startHandoff({
        reason: HANDOFF_REASONS.CAPTCHA_REQUIRED,
        pageId: 'page_1',
        verification: { type: 'text-present', text: 'Authenticated Fixture' }
      });

      // Not cleared yet
      const res1 = await handoffManager.resumeHandoff({ handoffId: started.handoffId });
      assert.strictEqual(res1.verified, false);

      // Human solves captcha: page text updates
      optionsText = 'Authenticated Fixture: Welcome back!';
      const res2 = await handoffManager.resumeHandoff({ handoffId: started.handoffId });
      assert.strictEqual(res2.verified, true);
    });

    it('does not allow resuming an already verified handoff', async () => {
      const started = await handoffManager.startHandoff({
        reason: HANDOFF_REASONS.LOGIN_REQUIRED,
        pageId: 'page_1',
        verification: { type: 'url-changed' }
      });

      mockBrowserManager.getPageEntry('page_1').currentUrl = 'https://example.com/dashboard';
      const res = await handoffManager.resumeHandoff({ handoffId: started.handoffId });
      assert.strictEqual(res.verified, true);

      // Re-resume must fail
      await assert.rejects(
        () => handoffManager.resumeHandoff({ handoffId: started.handoffId }),
        (err) => err instanceof HumanHandoffError && err.code === 'HANDOFF_ALREADY_COMPLETED'
      );
    });
  });

  describe('Privacy Guarantees and Safe Metadata', () => {
    it('strictly sanitizes and omits credentials, tokens, cookies, and raw DOM from handoff metadata', () => {
      const unsafeRecord = {
        handoffId: generateHandoffId(),
        reason: HANDOFF_REASONS.LOGIN_REQUIRED,
        pageId: 'page_1',
        status: HANDOFF_STATES.PAUSED_FOR_HUMAN,
        guidance: 'Sign in directly in Edge.',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        ttlMs: 300000,
        // Sensitive fields that MUST NOT leak
        password: 'super_secret_password',
        userPassword: 'secret',
        otp: '123456',
        token: 'auth_jwt_token',
        cookies: [{ name: 'sess', value: 'secret' }],
        storage: { key: 'secret_val' },
        rawHtml: '<form><input type="password"></form>'
      };

      const safe = toSafeHandoffMetadata(unsafeRecord);
      assert.strictEqual(safe.handoffId, unsafeRecord.handoffId);
      assert.strictEqual(safe.reason, unsafeRecord.reason);
      assert.strictEqual(safe.pageId, 'page_1');
      assert.strictEqual(safe.status, HANDOFF_STATES.PAUSED_FOR_HUMAN);

      // Assert zero leak of sensitive keys
      const serialized = JSON.stringify(safe);
      assert.strictEqual(serialized.includes('super_secret_password'), false);
      assert.strictEqual(serialized.includes('123456'), false);
      assert.strictEqual(serialized.includes('auth_jwt_token'), false);
      assert.strictEqual(serialized.includes('rawHtml'), false);
      assert.strictEqual(safe.password, undefined);
      assert.strictEqual(safe.otp, undefined);
      assert.strictEqual(safe.cookies, undefined);
      assert.strictEqual(safe.storage, undefined);
    });
  });
});
