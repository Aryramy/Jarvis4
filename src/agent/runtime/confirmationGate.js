/**
 * Human Confirmation Gate for JARVIS4 Runtime Agent Harness (PRE-040A).
 * Enforces strict human authorization for consequential actions (R3).
 *
 * Invariants:
 * - The MODEL NEVER receives or presents the internal confirmation token.
 * - Consequential actions pause and yield a safe pendingActionId.
 * - Human operator approves pending action through an explicit trusted boundary.
 * - Pending action is bound to runId, tool, arguments, pageId, contextId, snapshotToken, and TTL.
 * - Single-use consumption: replay strictly rejected with PENDING_ACTION_ALREADY_USED.
 * - Expiration and stale snapshot protection (PENDING_ACTION_EXPIRED, APPROVAL_STALE).
 */

import crypto from 'node:crypto';
import { RuntimeHarnessError, ERROR_CODES } from './runtimeErrors.js';

export class ConfirmationGate {
  constructor(options = {}) {
    this.defaultTtlMs = Math.min(Math.max(Number(options.defaultTtlMs || 60000), 5000), 300000);
    this.pendingActions = new Map();
  }

  /**
   * Generates an opaque pending action ID.
   * Example: 'pending_act_mva1b2_9f8e7d6c5b4a3b2a'
   * @returns {string}
   */
  generatePendingActionId() {
    const rnd = crypto.randomBytes(8).toString('hex');
    return `pending_act_${Date.now().toString(36)}_${rnd}`;
  }

  /**
   * Registers a pending consequential action requiring human approval.
   *
   * @param {Object} params
   * @param {string} params.runId
   * @param {string} params.tool
   * @param {Object} params.arguments
   * @param {string} [params.pageId]
   * @param {string} [params.contextId]
   * @param {string} [params.snapshotToken]
   * @param {number} [params.documentVersion]
   * @param {number} [params.semanticRevision]
   * @param {string} [params.summary]
   * @param {Object} [params.internalPreparationData] - Internal token / prep state NOT exposed to model
   * @param {number} [params.ttlMs]
   * @returns {Object} Safe public pending action metadata (zero secrets)
   */
  createPendingAction(params) {
    const pendingActionId = this.generatePendingActionId();
    const ttlMs = Math.min(Math.max(Number(params.ttlMs || this.defaultTtlMs), 5000), 300000);
    const now = Date.now();

    const record = {
      pendingActionId,
      runId: params.runId,
      tool: params.tool,
      arguments: params.arguments ? { ...params.arguments } : {},
      pageId: params.pageId || null,
      contextId: params.contextId || null,
      snapshotToken: params.snapshotToken || null,
      documentVersion: params.documentVersion ?? null,
      semanticRevision: params.semanticRevision ?? null,
      summary: params.summary || `Human confirmation required before executing ${params.tool}`,
      internalPreparationData: params.internalPreparationData || null,
      createdAt: now,
      expiresAt: now + ttlMs,
      approved: false,
      consumed: false,
      cancelled: false
    };

    this.pendingActions.set(pendingActionId, record);

    // Return safe public metadata only (zero secrets, zero internal tokens)
    return {
      pendingActionId,
      tool: record.tool,
      summary: record.summary,
      pageId: record.pageId,
      contextId: record.contextId,
      snapshotToken: record.snapshotToken,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt
    };
  }

  /**
   * Retrieves a pending action record.
   *
   * @param {string} pendingActionId
   * @returns {Object|null}
   */
  getPendingAction(pendingActionId) {
    if (typeof pendingActionId !== 'string') return null;
    return this.pendingActions.get(pendingActionId.trim()) || null;
  }

  /**
   * Approves a pending action through the trusted human operator boundary.
   *
   * @param {string} pendingActionId
   * @param {Object} [operatorApproval={}]
   * @param {boolean} [operatorApproval.approved=true]
   * @param {Object} [runtimeContext={}]
   * @returns {Object} The complete internal pending action record for execution
   */
  approvePendingAction(pendingActionId, operatorApproval = {}, runtimeContext = {}) {
    const record = this.getPendingAction(pendingActionId);
    if (!record) {
      throw new RuntimeHarnessError(`Pending action "${pendingActionId}" not found.`, ERROR_CODES.PENDING_ACTION_NOT_FOUND);
    }

    if (record.cancelled) {
      throw new RuntimeHarnessError(`Pending action "${pendingActionId}" was cancelled.`, ERROR_CODES.PENDING_ACTION_CANCELLED);
    }

    if (record.consumed) {
      throw new RuntimeHarnessError(`Pending action "${pendingActionId}" has already been used. Replay blocked.`, ERROR_CODES.PENDING_ACTION_ALREADY_USED);
    }

    if (Date.now() > record.expiresAt) {
      throw new RuntimeHarnessError(`Pending action "${pendingActionId}" has expired.`, ERROR_CODES.PENDING_ACTION_EXPIRED);
    }

    if (operatorApproval.approved !== true) {
      throw new RuntimeHarnessError(`Human operator rejected pending action "${pendingActionId}".`, ERROR_CODES.APPROVAL_REJECTED);
    }

    // Snapshot staleness validation: if runtime context shows page or snapshot changed
    if (runtimeContext.currentSnapshotToken && record.snapshotToken) {
      if (runtimeContext.currentSnapshotToken !== record.snapshotToken) {
        throw new RuntimeHarnessError(
          `Page snapshot changed since pending action was prepared (expected: "${record.snapshotToken}", current: "${runtimeContext.currentSnapshotToken}").`,
          ERROR_CODES.APPROVAL_STALE
        );
      }
    }

    record.approved = true;
    record.consumed = true;
    record.approvedAt = Date.now();

    return record;
  }

  /**
   * Cancels an active pending action.
   *
   * @param {string} pendingActionId
   * @param {string} [reason='Operator cancelled']
   */
  cancelPendingAction(pendingActionId, reason = 'Operator cancelled') {
    const record = this.getPendingAction(pendingActionId);
    if (!record) {
      throw new RuntimeHarnessError(`Pending action "${pendingActionId}" not found.`, ERROR_CODES.PENDING_ACTION_NOT_FOUND);
    }
    record.cancelled = true;
    record.cancelReason = reason;
  }

  /**
   * Cleans up expired or consumed pending actions.
   */
  cleanup() {
    const now = Date.now();
    for (const [id, record] of this.pendingActions.entries()) {
      if (record.consumed || record.cancelled || now > record.expiresAt) {
        this.pendingActions.delete(id);
      }
    }
  }
}
