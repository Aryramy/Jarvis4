/**
 * Unit Tests for Safe File Upload & Download v1 (Brick 37).
 *
 * Tests:
 * - Path normalization & traversal rejection
 * - File existence & directory rejection
 * - Size limits & oversize rejection
 * - Sensitive file denylist
 * - HTML accept constraint validation
 * - Filename sanitization & reserved names
 * - Collision-safe naming
 * - Executable download detection
 * - Opaque download ID format
 * - In-memory transfer manager lifecycle
 * - Privacy: zero path leakage in returned metadata
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  FileTransferError,
  FileTransferManager,
  validateAndNormalizeUploadPath,
  isSensitiveFilePath,
  validateAcceptConstraint,
  sanitizeDownloadFilename,
  getCollisionSafePath,
  generateDownloadId,
  SENSITIVE_EXTENSIONS,
  SENSITIVE_FILENAMES,
  BLOCKED_DOWNLOAD_EXTENSIONS,
  RESERVED_WINDOWS_NAMES
} from '../../src/browser/fileTransfer.js';

describe('File Transfer Unit Tests (Brick 37)', () => {
  let tempDir;
  let sampleFilePath;
  let largeFilePath;
  let testSubDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-transfer-test-'));
    sampleFilePath = path.join(tempDir, 'test-doc.pdf');
    fs.writeFileSync(sampleFilePath, 'Sample PDF content for upload tests\n');

    largeFilePath = path.join(tempDir, 'large-file.bin');
    fs.writeFileSync(largeFilePath, Buffer.alloc(5000, 0x42));

    testSubDir = path.join(tempDir, 'sub-folder');
    fs.mkdirSync(testSubDir, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Path Normalization & File Existence Validation', () => {
    it('accepts valid existing regular file path and returns safe metadata', () => {
      const res = validateAndNormalizeUploadPath(sampleFilePath);
      assert.equal(res.filename, 'test-doc.pdf');
      assert.ok(res.size > 0);
      assert.equal(path.resolve(res.path), path.resolve(sampleFilePath));
    });

    it('rejects empty or whitespace-only paths with INVALID_FILE_PATH', () => {
      assert.throws(
        () => validateAndNormalizeUploadPath(''),
        (err) => err instanceof FileTransferError && err.code === 'INVALID_FILE_PATH'
      );
      assert.throws(
        () => validateAndNormalizeUploadPath('   '),
        (err) => err instanceof FileTransferError && err.code === 'INVALID_FILE_PATH'
      );
    });

    it('rejects URL-like schemas with INVALID_FILE_PATH', () => {
      assert.throws(
        () => validateAndNormalizeUploadPath('file:///etc/passwd'),
        (err) => err instanceof FileTransferError && err.code === 'INVALID_FILE_PATH'
      );
      assert.throws(
        () => validateAndNormalizeUploadPath('http://example.com/file.txt'),
        (err) => err instanceof FileTransferError && err.code === 'INVALID_FILE_PATH'
      );
    });

    it('rejects relative traversal sequences with INVALID_FILE_PATH', () => {
      assert.throws(
        () => validateAndNormalizeUploadPath('../../secrets.txt'),
        (err) => err instanceof FileTransferError && err.code === 'INVALID_FILE_PATH'
      );
      assert.throws(
        () => validateAndNormalizeUploadPath('..\\..\\secrets.txt'),
        (err) => err instanceof FileTransferError && err.code === 'INVALID_FILE_PATH'
      );
    });

    it('rejects paths containing illegal control characters', () => {
      assert.throws(
        () => validateAndNormalizeUploadPath('C:\\test\x00\\bad.txt'),
        (err) => err instanceof FileTransferError && err.code === 'INVALID_FILE_PATH'
      );
    });

    it('rejects non-existent file with FILE_NOT_FOUND', () => {
      const missing = path.join(tempDir, 'does-not-exist.pdf');
      assert.throws(
        () => validateAndNormalizeUploadPath(missing),
        (err) => err instanceof FileTransferError && err.code === 'FILE_NOT_FOUND'
      );
    });

    it('rejects directories with FILE_IS_DIRECTORY', () => {
      assert.throws(
        () => validateAndNormalizeUploadPath(testSubDir),
        (err) => err instanceof FileTransferError && err.code === 'FILE_IS_DIRECTORY'
      );
    });

    it('rejects files exceeding maxBytes with UPLOAD_FILE_TOO_LARGE', () => {
      assert.throws(
        () => validateAndNormalizeUploadPath(largeFilePath, { maxBytes: 100 }),
        (err) => err instanceof FileTransferError && err.code === 'UPLOAD_FILE_TOO_LARGE'
      );
    });
  });

  describe('Sensitive File Denylist (Section 16)', () => {
    it('blocks SSH keys and directory contents', () => {
      assert.equal(isSensitiveFilePath('C:\\Users\\user\\.ssh\\id_rsa'), true);
      assert.equal(isSensitiveFilePath('/home/user/.ssh/id_ed25519'), true);
      assert.equal(isSensitiveFilePath('C:\\keys\\id_dsa'), true);
      assert.equal(isSensitiveFilePath('known_hosts'), true);
      assert.equal(isSensitiveFilePath('authorized_keys'), true);
    });

    it('blocks private keys and certificate files (.pem, .key, .pfx, .pkcs12)', () => {
      assert.equal(isSensitiveFilePath('C:\\cert\\server.pem'), true);
      assert.equal(isSensitiveFilePath('C:\\cert\\private.key'), true);
      assert.equal(isSensitiveFilePath('C:\\cert\\cert.pfx'), true);
      assert.equal(isSensitiveFilePath('C:\\cert\\bundle.pkcs12'), true);
    });

    it('blocks credential database files (.kdbx, credentials, .git-credentials)', () => {
      assert.equal(isSensitiveFilePath('C:\\vault\\passwords.kdbx'), true);
      assert.equal(isSensitiveFilePath('C:\\Users\\user\\.aws\\credentials'), true);
      assert.equal(isSensitiveFilePath('C:\\repo\\.git-credentials'), true);
    });

    it('blocks environment files (.env, .env.local, .env.production)', () => {
      assert.equal(isSensitiveFilePath('.env'), true);
      assert.equal(isSensitiveFilePath('.env.local'), true);
      assert.equal(isSensitiveFilePath('C:\\project\\.env.production'), true);
    });

    it('blocks browser profile databases', () => {
      assert.equal(isSensitiveFilePath('Cookies'), true);
      assert.equal(isSensitiveFilePath('Login Data'), true);
      assert.equal(isSensitiveFilePath('Web Data'), true);
      assert.equal(isSensitiveFilePath('places.sqlite'), true);
      assert.equal(isSensitiveFilePath('key4.db'), true);
      assert.equal(isSensitiveFilePath('logins.json'), true);
    });

    it('allows ordinary non-sensitive files', () => {
      assert.equal(isSensitiveFilePath('report.pdf'), false);
      assert.equal(isSensitiveFilePath('document.txt'), false);
      assert.equal(isSensitiveFilePath('photo.png'), false);
      assert.equal(isSensitiveFilePath('data.json'), false);
    });

    it('validateAndNormalizeUploadPath throws SENSITIVE_FILE_NOT_ALLOWED for sensitive paths', () => {
      const fakeEnv = path.join(tempDir, '.env');
      fs.writeFileSync(fakeEnv, 'API_KEY=secret\n');

      assert.throws(
        () => validateAndNormalizeUploadPath(fakeEnv),
        (err) => err instanceof FileTransferError && err.code === 'SENSITIVE_FILE_NOT_ALLOWED'
      );
    });
  });

  describe('HTML Accept Constraint Validation (Section 14)', () => {
    it('allows any file when accept attribute is empty or undefined', () => {
      assert.equal(validateAcceptConstraint('document.pdf', ''), true);
      assert.equal(validateAcceptConstraint('document.pdf', undefined), true);
      assert.equal(validateAcceptConstraint('image.png', null), true);
    });

    it('matches exact file extension constraints', () => {
      assert.equal(validateAcceptConstraint('report.pdf', '.pdf'), true);
      assert.equal(validateAcceptConstraint('report.PDF', '.pdf'), true);
      assert.equal(validateAcceptConstraint('photo.png', '.png, .jpg'), true);
      assert.equal(validateAcceptConstraint('document.txt', '.pdf, .docx'), false);
    });

    it('matches wildcard MIME types (image/*, text/*)', () => {
      assert.equal(validateAcceptConstraint('avatar.png', 'image/*'), true);
      assert.equal(validateAcceptConstraint('avatar.jpg', 'image/*'), true);
      assert.equal(validateAcceptConstraint('doc.pdf', 'image/*'), false);
      assert.equal(validateAcceptConstraint('readme.txt', 'text/*'), true);
      assert.equal(validateAcceptConstraint('audio.mp3', 'image/*'), false);
    });

    it('matches exact MIME types (application/pdf)', () => {
      assert.equal(validateAcceptConstraint('statement.pdf', 'application/pdf'), true);
      assert.equal(validateAcceptConstraint('statement.txt', 'application/pdf'), false);
    });
  });

  describe('Filename Sanitization & Reserved Names (Section 27 & 36)', () => {
    it('strips directory traversal from suggested filenames', () => {
      const res1 = sanitizeDownloadFilename('../../evil.txt');
      assert.equal(res1.filename, 'evil.txt');
      assert.equal(res1.isExecutable, false);

      const res2 = sanitizeDownloadFilename('..\\..\\malicious.pdf');
      assert.equal(res2.filename, 'malicious.pdf');
    });

    it('removes dangerous characters and control codes', () => {
      const res = sanitizeDownloadFilename('report<test>:special"file|name?.pdf');
      assert.ok(!res.filename.includes('<'));
      assert.ok(!res.filename.includes('>'));
      assert.ok(!res.filename.includes(':'));
      assert.ok(!res.filename.includes('"'));
      assert.ok(!res.filename.includes('|'));
      assert.ok(!res.filename.includes('?'));
    });

    it('escapes reserved Windows device names (CON, NUL, PRN, COM1)', () => {
      assert.equal(sanitizeDownloadFilename('CON').filename, '_CON');
      assert.equal(sanitizeDownloadFilename('con.txt').filename, '_con.txt');
      assert.equal(sanitizeDownloadFilename('NUL.dat').filename, '_NUL.dat');
      assert.equal(sanitizeDownloadFilename('aux').filename, '_aux');
      assert.equal(sanitizeDownloadFilename('COM1').filename, '_COM1');
    });

    it('falls back to "download" when filename is empty or entirely sanitized', () => {
      assert.equal(sanitizeDownloadFilename('').filename, 'download');
      assert.equal(sanitizeDownloadFilename('   ').filename, 'download');
      assert.equal(sanitizeDownloadFilename(':::').filename, '___');
    });

    it('detects blocked executable and script extensions (Section 36)', () => {
      const exes = ['.exe', '.msi', '.bat', '.cmd', '.ps1', '.scr', '.vbs', '.js'];
      for (const ext of exes) {
        const res = sanitizeDownloadFilename(`program${ext}`);
        assert.equal(res.isExecutable, true, `Expected ${ext} to be flagged as executable`);
      }
      assert.equal(sanitizeDownloadFilename('report.pdf').isExecutable, false);
      assert.equal(sanitizeDownloadFilename('data.csv').isExecutable, false);
    });
  });

  describe('Collision Safe Path Naming (Section 28)', () => {
    it('returns target path directly if file does not exist', () => {
      const p = getCollisionSafePath(tempDir, 'non-existent.txt');
      assert.equal(path.basename(p), 'non-existent.txt');
    });

    it('generates collision-safe incremented names when file exists', () => {
      const baseFile = path.join(tempDir, 'report.pdf');
      fs.writeFileSync(baseFile, 'first version');

      const p1 = getCollisionSafePath(tempDir, 'report.pdf');
      assert.equal(path.basename(p1), 'report (1).pdf');

      fs.writeFileSync(p1, 'second version');
      const p2 = getCollisionSafePath(tempDir, 'report.pdf');
      assert.equal(path.basename(p2), 'report (2).pdf');
    });
  });

  describe('Download ID & Manager Registry (Section 33 & 34)', () => {
    it('generates opaque download IDs starting with dl_', () => {
      const id1 = generateDownloadId();
      const id2 = generateDownloadId();
      assert.ok(id1.startsWith('dl_'));
      assert.ok(id2.startsWith('dl_'));
      assert.notEqual(id1, id2);
    });

    it('FileTransferManager stores completed downloads in safe registry', async () => {
      const mgr = new FileTransferManager({ downloadDir: path.join(tempDir, 'downloads') });
      assert.equal(mgr.listDownloads().length, 0);

      // Simulate recorded download
      const id = generateDownloadId();
      mgr._downloads.set(id, {
        downloadId: id,
        filename: 'statement.pdf',
        size: 1024,
        createdAt: new Date().toISOString(),
        status: 'completed',
        _destPath: 'C:\\internal\\path\\statement.pdf'
      });

      const list = mgr.listDownloads();
      assert.equal(list.length, 1);
      assert.equal(list[0].downloadId, id);
      assert.equal(list[0].filename, 'statement.pdf');
      assert.equal(list[0].size, 1024);
      assert.equal(list[0].status, 'completed');
      // Must NOT leak internal destination path!
      assert.equal(list[0]._destPath, undefined);

      const d = mgr.getDownload(id);
      assert.equal(d.filename, 'statement.pdf');
      assert.equal(d._destPath, undefined);
    });
  });

  describe('FileTransferManager Upload Logic', () => {
    it('rejects upload when snapshot token is missing or mismatched', async () => {
      const mgr = new FileTransferManager();
      const mockPageEntry = {
        snapshotToken: 'snap_v1_abc',
        page: { isClosed: () => false }
      };

      await assert.rejects(
        () => mgr.uploadFile({
          pageEntry: mockPageEntry,
          target: { kind: 'input', name: 'File' },
          expectedSnapshotToken: 'snap_v1_wrong',
          filePath: sampleFilePath
        }),
        (err) => err instanceof FileTransferError && err.code === 'TARGET_STALE'
      );
    });

    it('rejects upload when Human Handoff is active on page', async () => {
      const mgr = new FileTransferManager();
      const mockBm = {
        isHandoffActive: () => true
      };
      const mockPageEntry = {
        pageId: 'pg_1',
        snapshotToken: 'snap_v1_abc',
        page: { isClosed: () => false }
      };

      await assert.rejects(
        () => mgr.uploadFile({
          pageEntry: mockPageEntry,
          target: { kind: 'input', name: 'File' },
          expectedSnapshotToken: 'snap_v1_abc',
          filePath: sampleFilePath,
          browserManager: mockBm
        }),
        (err) => err instanceof FileTransferError && err.code === 'HUMAN_HANDOFF_ACTIVE'
      );
    });

    it('rejects upload when target element is not an input of type="file"', async () => {
      const mgr = new FileTransferManager();
      const mockPageEntry = {
        pageId: 'pg_1',
        snapshotToken: 'snap_v1_abc',
        currentUrl: 'http://127.0.0.1/test',
        title: 'Test',
        inspection: {
          elements: [
            { kind: 'input', inputType: 'text', accessibleName: 'Text Box', tag: 'input' }
          ]
        },
        page: { isClosed: () => false }
      };

      await assert.rejects(
        () => mgr.uploadFile({
          pageEntry: mockPageEntry,
          target: { kind: 'input', name: 'Text Box' },
          expectedSnapshotToken: 'snap_v1_abc',
          filePath: sampleFilePath
        }),
        (err) => err instanceof FileTransferError && err.code === 'TARGET_NOT_FILE_INPUT'
      );
    });

    it('rejects upload when accept constraint is violated', async () => {
      const mgr = new FileTransferManager();
      const mockPageEntry = {
        pageId: 'pg_1',
        snapshotToken: 'snap_v1_abc',
        currentUrl: 'http://127.0.0.1/test',
        title: 'Test',
        inspection: {
          elements: [
            { kind: 'input', inputType: 'file', accessibleName: 'Upload Image', tag: 'input', accept: 'image/*' }
          ]
        },
        page: { isClosed: () => false }
      };

      await assert.rejects(
        () => mgr.uploadFile({
          pageEntry: mockPageEntry,
          target: { kind: 'input', name: 'Upload Image' },
          expectedSnapshotToken: 'snap_v1_abc',
          filePath: sampleFilePath // .pdf does not match image/*
        }),
        (err) => err instanceof FileTransferError && err.code === 'FILE_TYPE_NOT_ACCEPTED'
      );
    });

    it('rejects multiple files when target input does not have multiple attribute', async () => {
      const mgr = new FileTransferManager();
      const mockPageEntry = {
        pageId: 'pg_1',
        snapshotToken: 'snap_v1_abc',
        currentUrl: 'http://127.0.0.1/test',
        title: 'Test',
        inspection: {
          elements: [
            { kind: 'input', inputType: 'file', accessibleName: 'Upload Doc', tag: 'input' }
          ]
        },
        page: { isClosed: () => false }
      };

      await assert.rejects(
        () => mgr.uploadFile({
          pageEntry: mockPageEntry,
          target: { kind: 'input', name: 'Upload Doc' },
          expectedSnapshotToken: 'snap_v1_abc',
          filePaths: [sampleFilePath, largeFilePath]
        }),
        (err) => err instanceof FileTransferError && err.code === 'MULTIPLE_UPLOAD_NOT_SUPPORTED'
      );
    });

    it('executes upload cleanly with mock element handle and returns safe metadata', async () => {
      const mgr = new FileTransferManager();
      let filesSet = null;
      const mockHandle = {
        asElement: () => mockHandle,
        isConnected: async () => true,
        setInputFiles: async (paths) => { filesSet = paths; },
        evaluate: async () => ({
          count: 1,
          files: [{ filename: 'test-doc.pdf', size: 100, type: 'application/pdf' }]
        }),
        dispose: async () => {}
      };

      const mockPageEntry = {
        pageId: 'pg_1',
        snapshotToken: 'snap_v1_abc',
        currentUrl: 'http://127.0.0.1/test',
        title: 'Test',
        inspection: {
          elements: [
            { kind: 'input', inputType: 'file', accessibleName: 'Upload Document', tag: 'input' }
          ]
        },
        page: {
          isClosed: () => false,
          evaluateHandle: async () => mockHandle
        }
      };

      const res = await mgr.uploadFile({
        pageEntry: mockPageEntry,
        target: { kind: 'input', name: 'Upload Document' },
        expectedSnapshotToken: 'snap_v1_abc',
        filePath: sampleFilePath,
        options: { mockElementHandle: mockHandle }
      });

      assert.equal(res.success, true);
      assert.equal(res.uploaded, true);
      assert.equal(res.filename, 'test-doc.pdf');
      assert.equal(res.count, 1);
      assert.equal(res.verified, true);
      assert.ok(filesSet && filesSet.length === 1);
      // Privacy: full local path not present in result object
      assert.equal(res.path, undefined);
      assert.equal(res.filePath, undefined);
    });
  });

  describe('FileTransferManager Download Logic', () => {
    it('rejects download when snapshot token is stale', async () => {
      const mgr = new FileTransferManager({ downloadDir: tempDir });
      const mockPageEntry = {
        snapshotToken: 'snap_v1_abc',
        page: { isClosed: () => false }
      };

      await assert.rejects(
        () => mgr.downloadFile({
          pageEntry: mockPageEntry,
          target: { kind: 'link', name: 'Download' },
          expectedSnapshotToken: 'snap_stale'
        }),
        (err) => err instanceof FileTransferError && err.code === 'TARGET_STALE'
      );
    });

    it('rejects download when Human Handoff is active', async () => {
      const mgr = new FileTransferManager({ downloadDir: tempDir });
      const mockBm = { isHandoffActive: () => true };
      const mockPageEntry = {
        pageId: 'pg_1',
        snapshotToken: 'snap_v1_abc',
        page: { isClosed: () => false }
      };

      await assert.rejects(
        () => mgr.downloadFile({
          pageEntry: mockPageEntry,
          target: { kind: 'link', name: 'Download' },
          expectedSnapshotToken: 'snap_v1_abc',
          browserManager: mockBm
        }),
        (err) => err instanceof FileTransferError && err.code === 'HUMAN_HANDOFF_ACTIVE'
      );
    });

    it('blocks executable downloads with DOWNLOAD_TYPE_NOT_ALLOWED', async () => {
      const mgr = new FileTransferManager({ downloadDir: tempDir });
      let cancelled = false;

      const mockDownload = {
        suggestedFilename: () => 'setup.exe',
        failure: async () => null,
        cancel: async () => { cancelled = true; }
      };

      const mockHandle = {
        asElement: () => mockHandle,
        click: async () => {},
        dispose: async () => {}
      };

      const mockPageEntry = {
        pageId: 'pg_1',
        snapshotToken: 'snap_v1_abc',
        currentUrl: 'http://127.0.0.1/test',
        title: 'Test',
        inspection: {
          elements: [
            { kind: 'link', accessibleName: 'Download Installer', tag: 'a' }
          ]
        },
        page: {
          isClosed: () => false,
          evaluateHandle: async () => mockHandle,
          waitForEvent: async () => mockDownload
        }
      };

      await assert.rejects(
        () => mgr.downloadFile({
          pageEntry: mockPageEntry,
          target: { kind: 'link', name: 'Download Installer' },
          expectedSnapshotToken: 'snap_v1_abc',
          options: { mockElementHandle: mockHandle }
        }),
        (err) => err instanceof FileTransferError && err.code === 'DOWNLOAD_TYPE_NOT_ALLOWED'
      );
      assert.equal(cancelled, true);
    });

    it('deletes oversized download and returns DOWNLOAD_TOO_LARGE', async () => {
      const dlDir = path.join(tempDir, 'oversized-test');
      fs.mkdirSync(dlDir, { recursive: true });
      const mgr = new FileTransferManager({ downloadDir: dlDir, downloadMaxBytes: 100 });

      const mockDownload = {
        suggestedFilename: () => 'large.bin',
        failure: async () => null,
        saveAs: async (dest) => {
          fs.writeFileSync(dest, Buffer.alloc(500, 0x41)); // 500 bytes > 100 bytes limit
        }
      };

      const mockHandle = {
        asElement: () => mockHandle,
        click: async () => {},
        dispose: async () => {}
      };

      const mockPageEntry = {
        pageId: 'pg_1',
        snapshotToken: 'snap_v1_abc',
        currentUrl: 'http://127.0.0.1/test',
        title: 'Test',
        inspection: {
          elements: [
            { kind: 'link', accessibleName: 'Download Big File', tag: 'a' }
          ]
        },
        page: {
          isClosed: () => false,
          evaluateHandle: async () => mockHandle,
          waitForEvent: async () => mockDownload
        }
      };

      await assert.rejects(
        () => mgr.downloadFile({
          pageEntry: mockPageEntry,
          target: { kind: 'link', name: 'Download Big File' },
          expectedSnapshotToken: 'snap_v1_abc',
          options: { mockElementHandle: mockHandle }
        }),
        (err) => err instanceof FileTransferError && err.code === 'DOWNLOAD_TOO_LARGE'
      );

      // Verify oversized file was cleaned up
      const files = fs.readdirSync(dlDir);
      assert.equal(files.length, 0);
    });
  });
});
