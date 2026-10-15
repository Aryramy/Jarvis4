/**
 * Contract Tests for File Transfer Endpoints (Brick 37).
 *
 * Validates HTTP route contracts:
 * - POST /api/browser/upload-file & /api/browser/upload
 * - POST /api/browser/download
 * - GET /api/browser/downloads
 *
 * Guarantees:
 * - Method constraints (405 on GET for mutating endpoints)
 * - JSON schema validation (400 on invalid JSON or missing parameters)
 * - Controlled error codes and HTTP status mappings
 * - Safe response metadata (zero full paths or internal directories leaked)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../../src/web/server.js';
import { BrowserManager } from '../../src/browser/browserManager.js';
import { FileTransferError } from '../../src/browser/fileTransfer.js';

describe('File Transfer Endpoints Contract Tests (Brick 37)', () => {
  let server;
  let port;
  let baseUrl;
  let tempDir;
  let sampleFilePath;
  let mockBrowserManager;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-transfer-contract-'));
    sampleFilePath = path.join(tempDir, 'invoice.pdf');
    fs.writeFileSync(sampleFilePath, 'Invoice test content\n');

    mockBrowserManager = {
      uploadFile: async (req) => {
        if (!req.expectedSnapshotToken || req.expectedSnapshotToken === 'stale') {
          throw new FileTransferError('Snapshot token is stale.', 'TARGET_STALE');
        }
        if (req.filePath && req.filePath.includes('sensitive')) {
          throw new FileTransferError('Sensitive file is blocked.', 'SENSITIVE_FILE_NOT_ALLOWED');
        }
        if (req.filePath && req.filePath.includes('missing')) {
          throw new FileTransferError('File not found.', 'FILE_NOT_FOUND');
        }
        return {
          success: true,
          uploaded: true,
          count: 1,
          filename: path.basename(req.filePath),
          size: 1234,
          verified: true
        };
      },
      downloadFile: async (req) => {
        if (!req.expectedSnapshotToken || req.expectedSnapshotToken === 'stale') {
          throw new FileTransferError('Snapshot token is stale.', 'TARGET_STALE');
        }
        if (req.target?.name === 'Timeout Target') {
          throw new FileTransferError('Download timed out waiting for browser event.', 'DOWNLOAD_TIMEOUT');
        }
        if (req.target?.name === 'Executable') {
          throw new FileTransferError('Downloading executable is blocked.', 'DOWNLOAD_TYPE_NOT_ALLOWED');
        }
        return {
          success: true,
          downloadId: 'dl_contract_test',
          filename: 'report.pdf',
          size: 5678,
          status: 'completed',
          verified: true
        };
      },
      listDownloads: () => [
        {
          downloadId: 'dl_contract_test',
          filename: 'report.pdf',
          size: 5678,
          createdAt: new Date().toISOString(),
          status: 'completed'
        }
      ]
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
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  async function post(endpoint, body) {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async function get(endpoint) {
    const res = await fetch(`${baseUrl}${endpoint}`);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  describe('POST /api/browser/upload-file', () => {
    it('rejects GET requests with 405 Method Not Allowed', async () => {
      const res = await get('/api/browser/upload-file');
      assert.equal(res.status, 405);
      assert.equal(res.data.success, false);
    });

    it('rejects malformed JSON with 400 Bad Request', async () => {
      const res = await post('/api/browser/upload-file', '{ bad json');
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'INVALID_REQUEST');
    });

    it('returns 409 TARGET_STALE on stale snapshot token', async () => {
      const res = await post('/api/browser/upload-file', {
        expectedSnapshotToken: 'stale',
        target: { kind: 'input', name: 'Upload File' },
        filePath: sampleFilePath
      });
      assert.equal(res.status, 409);
      assert.equal(res.data.code, 'TARGET_STALE');
      assert.equal(res.data.success, false);
    });

    it('returns 403 SENSITIVE_FILE_NOT_ALLOWED for blocked sensitive files', async () => {
      const res = await post('/api/browser/upload-file', {
        expectedSnapshotToken: 'snap_valid',
        target: { kind: 'input', name: 'Upload File' },
        filePath: 'sensitive_key.pem'
      });
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'SENSITIVE_FILE_NOT_ALLOWED');
    });

    it('returns 404 FILE_NOT_FOUND for non-existent local file', async () => {
      const res = await post('/api/browser/upload-file', {
        expectedSnapshotToken: 'snap_valid',
        target: { kind: 'input', name: 'Upload File' },
        filePath: 'missing_file.pdf'
      });
      assert.equal(res.status, 404);
      assert.equal(res.data.code, 'FILE_NOT_FOUND');
    });

    it('returns 200 with safe metadata on valid upload', async () => {
      const res = await post('/api/browser/upload-file', {
        expectedSnapshotToken: 'snap_valid',
        target: { kind: 'input', name: 'Upload File' },
        filePath: sampleFilePath
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.uploaded, true);
      assert.equal(res.data.filename, 'invoice.pdf');
      assert.equal(res.data.size, 1234);
      assert.equal(res.data.verified, true);
      // Privacy: no local path exposed
      assert.equal(res.data.path, undefined);
      assert.equal(res.data.filePath, undefined);
    });
  });

  describe('POST /api/browser/download', () => {
    it('rejects GET requests with 405 Method Not Allowed', async () => {
      const res = await get('/api/browser/download');
      assert.equal(res.status, 405);
      assert.equal(res.data.success, false);
    });

    it('returns 409 TARGET_STALE on stale snapshot token', async () => {
      const res = await post('/api/browser/download', {
        expectedSnapshotToken: 'stale',
        target: { kind: 'link', name: 'Download Statement' }
      });
      assert.equal(res.status, 409);
      assert.equal(res.data.code, 'TARGET_STALE');
    });

    it('returns 408 DOWNLOAD_TIMEOUT when download times out', async () => {
      const res = await post('/api/browser/download', {
        expectedSnapshotToken: 'snap_valid',
        target: { kind: 'link', name: 'Timeout Target' }
      });
      assert.equal(res.status, 408);
      assert.equal(res.data.code, 'DOWNLOAD_TIMEOUT');
    });

    it('returns 403 DOWNLOAD_TYPE_NOT_ALLOWED when executable download triggered', async () => {
      const res = await post('/api/browser/download', {
        expectedSnapshotToken: 'snap_valid',
        target: { kind: 'link', name: 'Executable' }
      });
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'DOWNLOAD_TYPE_NOT_ALLOWED');
    });

    it('returns 200 with safe metadata on successful download', async () => {
      const res = await post('/api/browser/download', {
        expectedSnapshotToken: 'snap_valid',
        target: { kind: 'link', name: 'Download Statement' }
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.downloadId, 'dl_contract_test');
      assert.equal(res.data.filename, 'report.pdf');
      assert.equal(res.data.size, 5678);
      assert.equal(res.data.status, 'completed');
      assert.equal(res.data.verified, true);
      // Privacy: no internal download path exposed
      assert.equal(res.data.destPath, undefined);
      assert.equal(res.data._destPath, undefined);
    });
  });

  describe('GET /api/browser/downloads', () => {
    it('returns 200 and array of completed managed downloads', async () => {
      const res = await get('/api/browser/downloads');
      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(Array.isArray(res.data.downloads));
      assert.equal(res.data.downloads.length, 1);
      assert.equal(res.data.downloads[0].downloadId, 'dl_contract_test');
      assert.equal(res.data.downloads[0].filename, 'report.pdf');
      assert.equal(res.data.downloads[0].size, 5678);
      assert.equal(res.data.downloads[0].status, 'completed');
      assert.equal(res.data.downloads[0]._destPath, undefined);
    });
  });
});
