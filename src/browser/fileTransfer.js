/**
 * Safe File Upload & Download v1 for JARVIS4 (Brick 37).
 *
 * Strict invariants:
 * - Explicit user authorization: uploads require explicit local path; downloads require dedicated endpoint.
 * - Narrowly scoped: zero arbitrary filesystem scanning, browsing, enumeration, or traversal.
 * - Local path privacy: full upload paths and internal destination paths are never returned in public APIs, logs, or UI.
 * - Sensitive file denylist: SSH keys, private keys, credential vaults, browser databases deterministically blocked.
 * - File verification: validates file existence, regular file type, readability, size limits, and accept constraints.
 * - Approved download directory: all downloads save strictly into JARVIS-owned runtime download directory.
 * - Filename sanitization: strips path separators, traversal characters, control characters, and reserved Windows names.
 * - Deterministic collision safety: existing download files are never overwritten silently.
 * - Zero auto-execution: downloaded executables/scripts are blocked or never auto-opened.
 * - Zero auto-retry: one authorization = at most one download action.
 * - Human handoff safety: mutating transfer operations are blocked during active sensitive handoffs.
 * - Zero AI / LLM calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { resolveTargetFromElements } from './targetResolver.js';
import { findTargetDomElement } from './actionExecutor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');

export class FileTransferError extends Error {
  /**
   * @param {string} message
   * @param {string} [code='FILE_TRANSFER_FAILED']
   * @param {Object} [details={}]
   */
  constructor(message, code = 'FILE_TRANSFER_FAILED', details = {}) {
    super(message);
    this.name = 'FileTransferError';
    this.code = code;
    this.details = details;
  }
}

export const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30000; // 30 seconds

export const SENSITIVE_EXTENSIONS = Object.freeze([
  '.pem',
  '.key',
  '.pkcs12',
  '.pfx',
  '.kdbx'
]);

export const SENSITIVE_FILENAMES = Object.freeze([
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'id_rsa.pub',
  'known_hosts',
  'authorized_keys',
  'credentials',
  '.git-credentials',
  'cookies',
  'login data',
  'web data',
  'places.sqlite',
  'key4.db',
  'logins.json'
]);

export const BLOCKED_DOWNLOAD_EXTENSIONS = Object.freeze([
  '.exe',
  '.msi',
  '.bat',
  '.cmd',
  '.ps1',
  '.scr',
  '.vbs',
  '.js',
  '.vbe',
  '.wsf',
  '.wsh',
  '.com',
  '.pif',
  '.hta',
  '.cpl',
  '.msc',
  '.jar'
]);

export const RESERVED_WINDOWS_NAMES = Object.freeze([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/**
 * Checks whether a given local path points to an obviously sensitive credential or key file.
 *
 * @param {string} localPath
 * @returns {boolean}
 */
export function isSensitiveFilePath(localPath) {
  if (typeof localPath !== 'string' || localPath.trim().length === 0) {
    return false;
  }

  const normalized = path.normalize(localPath);
  const base = path.basename(normalized).toLowerCase();
  const ext = path.extname(normalized).toLowerCase();

  // 1. Block sensitive extensions
  if (SENSITIVE_EXTENSIONS.includes(ext)) {
    return true;
  }

  // 2. Block sensitive filenames
  if (SENSITIVE_FILENAMES.includes(base)) {
    return true;
  }

  // 3. Block environment files (.env, .env.local, etc.)
  if (base === '.env' || base.startsWith('.env.')) {
    return true;
  }

  // 4. Block SSH or AWS directory contents
  const segments = normalized.split(/[\\/]/).map(s => s.toLowerCase());
  if (segments.includes('.ssh') || segments.includes('.aws')) {
    return true;
  }

  return false;
}

/**
 * Validates and normalizes an upload file path according to security rules.
 *
 * @param {string} rawPath
 * @param {Object} [options]
 * @param {number} [options.maxBytes]
 * @returns {{ path: string, filename: string, size: number }}
 */
export function validateAndNormalizeUploadPath(rawPath, options = {}) {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new FileTransferError('File path must be a non-empty string.', 'INVALID_FILE_PATH');
  }

  const trimmed = rawPath.trim();

  // Reject URL-like schemas
  if (/^[a-zA-Z][a-zA-Z0-9+-.]*:\/\//.test(trimmed)) {
    throw new FileTransferError('URL-like paths are not accepted as local file paths.', 'INVALID_FILE_PATH');
  }

  // Reject null bytes or illegal control characters
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new FileTransferError('File path contains illegal control characters.', 'INVALID_FILE_PATH');
  }

  // Reject relative traversal sequences
  if (trimmed.includes('../') || trimmed.includes('..\\')) {
    throw new FileTransferError('Relative path traversal sequences are not allowed.', 'INVALID_FILE_PATH');
  }

  const resolved = path.resolve(trimmed);
  const filename = path.basename(resolved);

  // Check sensitive file denylist (Section 16)
  if (isSensitiveFilePath(resolved)) {
    throw new FileTransferError('Sensitive local artifact is blocked from upload.', 'SENSITIVE_FILE_NOT_ALLOWED', {
      filename
    });
  }

  // Verify file existence and access (Section 11)
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new FileTransferError(`File not found: "${filename}".`, 'FILE_NOT_FOUND', { filename });
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new FileTransferError(`File is not accessible or readable: "${filename}".`, 'FILE_NOT_READABLE', { filename });
    }
    throw new FileTransferError(`Failed to inspect file "${filename}": ${err.message}`, 'FILE_NOT_READABLE', { filename });
  }

  if (stat.isDirectory()) {
    throw new FileTransferError(`Path is a directory, not a regular file: "${filename}".`, 'FILE_IS_DIRECTORY', { filename });
  }

  if (!stat.isFile()) {
    throw new FileTransferError(`Path is not a regular file: "${filename}".`, 'FILE_NOT_FOUND', { filename });
  }

  // Check read permission
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    throw new FileTransferError(`File is not readable: "${filename}".`, 'FILE_NOT_READABLE', { filename });
  }

  // Check file size limit (Section 13)
  const maxBytes = options.maxBytes ?? config.browser?.uploadMaxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
  if (stat.size > maxBytes) {
    throw new FileTransferError(`File size (${stat.size} bytes) exceeds maximum upload limit of ${maxBytes} bytes.`, 'UPLOAD_FILE_TOO_LARGE', {
      filename,
      size: stat.size,
      maxBytes
    });
  }

  return {
    path: resolved,
    filename,
    size: stat.size
  };
}

/**
 * Validates a file against an input's HTML accept attribute (Section 14).
 *
 * @param {string} filename
 * @param {string} [acceptAttr]
 * @returns {boolean}
 */
export function validateAcceptConstraint(filename, acceptAttr) {
  if (!acceptAttr || typeof acceptAttr !== 'string' || acceptAttr.trim().length === 0) {
    return true; // No constraint
  }

  const ext = path.extname(filename).toLowerCase();
  const tokens = acceptAttr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return true;

  const MIME_EXT_MAP = {
    'application/pdf': ['.pdf'],
    'text/plain': ['.txt'],
    'text/csv': ['.csv'],
    'text/html': ['.html', '.htm'],
    'application/json': ['.json'],
    'application/zip': ['.zip'],
    'image/png': ['.png'],
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/gif': ['.gif'],
    'image/webp': ['.webp'],
    'image/svg+xml': ['.svg']
  };

  const WILDCARD_MAP = {
    'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'],
    'text/*': ['.txt', '.csv', '.html', '.htm', '.css', '.js', '.json', '.xml', '.md'],
    'audio/*': ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'],
    'video/*': ['.mp4', '.webm', '.mov', '.avi', '.mkv']
  };

  for (const token of tokens) {
    // 1. Direct extension match (.pdf, .png)
    if (token.startsWith('.')) {
      if (ext === token) return true;
    }
    // 2. Wildcard MIME match (image/*, text/*)
    else if (WILDCARD_MAP[token]) {
      if (WILDCARD_MAP[token].includes(ext)) return true;
    }
    // 3. Exact MIME type match
    else if (MIME_EXT_MAP[token]) {
      if (MIME_EXT_MAP[token].includes(ext)) return true;
    }
  }

  return false;
}

/**
 * Sanitizes a browser-suggested download filename (Section 27 & 36).
 *
 * @param {string} suggestedFilename
 * @returns {{ filename: string, isExecutable: boolean }}
 */
export function sanitizeDownloadFilename(suggestedFilename) {
  let raw = typeof suggestedFilename === 'string' ? suggestedFilename.trim() : '';

  // 1. Strip directory traversal and path separators
  raw = raw.replace(/^[a-zA-Z]:[\\/]/, '');
  raw = path.basename(raw.replace(/[\\/]+/g, path.sep));
  raw = raw.replace(/(_*\.\._*)+/g, '');
  raw = raw.replace(/\.\.+/g, '');

  // 2. Strip dangerous characters and control codes
  raw = raw.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_');

  // 3. Trim whitespace and trailing periods/spaces
  raw = raw.replace(/[.\s]+$/, '').trim();

  // Strip leading traversal artifacts if name remains non-empty
  const strippedLeading = raw.replace(/^[._-]+/, '');
  if (strippedLeading.length > 0) {
    raw = strippedLeading;
  }

  // 4. Fallback if empty
  if (raw.length === 0) {
    raw = 'download';
  }

  // 5. Length clamp
  if (raw.length > 200) {
    const ext = path.extname(raw);
    const base = path.basename(raw, ext);
    raw = `${base.slice(0, 190)}${ext}`;
  }

  // 6. Check reserved Windows device names
  const ext = path.extname(raw).toLowerCase();
  const baseNameWithoutExt = path.basename(raw, ext).toLowerCase();
  if (RESERVED_WINDOWS_NAMES.includes(baseNameWithoutExt)) {
    raw = `_${raw}`;
  }

  // 7. Check executable policy (Section 36)
  const finalExt = path.extname(raw).toLowerCase();
  const isExecutable = BLOCKED_DOWNLOAD_EXTENSIONS.includes(finalExt);

  return {
    filename: raw,
    isExecutable
  };
}

/**
 * Returns a collision-safe file path in the target directory (Section 28).
 *
 * @param {string} directory
 * @param {string} filename
 * @returns {string}
 */
export function getCollisionSafePath(directory, filename) {
  const initialPath = path.join(directory, filename);
  if (!fs.existsSync(initialPath)) {
    return initialPath;
  }

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  let counter = 1;
  let candidate = `${base} (${counter})${ext}`;
  let candidatePath = path.join(directory, candidate);

  while (fs.existsSync(candidatePath)) {
    counter++;
    candidate = `${base} (${counter})${ext}`;
    candidatePath = path.join(directory, candidate);
  }

  return candidatePath;
}

/**
 * Generates an opaque download identifier (Section 33).
 *
 * @returns {string}
 */
export function generateDownloadId() {
  const rnd = crypto.randomBytes(6).toString('hex');
  return `dl_${Date.now().toString(36)}_${rnd}`;
}

/**
 * File Transfer Manager coordinating safe upload and download operations (Brick 37).
 */
export class FileTransferManager {
  /**
   * @param {Object} [options]
   * @param {string} [options.downloadDir]
   * @param {number} [options.uploadMaxBytes]
   * @param {number} [options.downloadMaxBytes]
   * @param {number} [options.downloadTimeoutMs]
   */
  constructor(options = {}) {
    this._downloadDir = options.downloadDir
      ? path.resolve(options.downloadDir)
      : path.resolve(ROOT_DIR, 'runtime', 'downloads');

    this._uploadMaxBytes = options.uploadMaxBytes !== undefined
      ? Math.max(1, Number(options.uploadMaxBytes))
      : Number(config.browser?.uploadMaxBytes ?? DEFAULT_UPLOAD_MAX_BYTES);
    this._downloadMaxBytes = options.downloadMaxBytes !== undefined
      ? Math.max(1, Number(options.downloadMaxBytes))
      : Number(config.browser?.downloadMaxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES);
    this._downloadTimeoutMs = options.downloadTimeoutMs !== undefined
      ? Math.max(1, Number(options.downloadTimeoutMs))
      : Number(config.browser?.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);

    // Safe in-memory registry of completed JARVIS-managed downloads (Section 34)
    this._downloads = new Map();
  }

  get downloadDir() {
    return this._downloadDir;
  }

  get uploadMaxBytes() {
    return this._uploadMaxBytes;
  }

  get downloadMaxBytes() {
    return this._downloadMaxBytes;
  }

  get downloadTimeoutMs() {
    return this._downloadTimeoutMs;
  }

  /**
   * Executes a user-authorized safe file upload to a target file input (Sections 6-21).
   *
   * @param {Object} params
   * @param {Object} params.pageEntry
   * @param {Object} params.target
   * @param {string} params.expectedSnapshotToken
   * @param {string} [params.filePath]
   * @param {Array<string>} [params.filePaths]
   * @param {Object} [params.browserManager]
   * @param {Object} [options]
   * @returns {Promise<{ success: boolean, uploaded: boolean, filename: string, size: number, count: number, files: Array<Object>, verified: boolean }>}
   */
  async uploadFile({
    pageEntry,
    target,
    expectedSnapshotToken,
    filePath,
    filePaths,
    browserManager,
    options = {}
  }) {
    if (!pageEntry || !pageEntry.page || (typeof pageEntry.page.isClosed === 'function' && pageEntry.page.isClosed())) {
      throw new FileTransferError('Target page is closed or not available.', 'PAGE_CLOSED');
    }

    // 1. Check Human Handoff boundary (Section 21)
    if (browserManager && typeof browserManager.isHandoffActive === 'function') {
      if (browserManager.isHandoffActive(pageEntry.pageId)) {
        throw new FileTransferError(
          'File upload is blocked while Human Handoff is active on this page.',
          'HUMAN_HANDOFF_ACTIVE',
          { pageId: pageEntry.pageId }
        );
      }
    }

    // 2. Validate expected snapshot token (Section 10)
    if (!expectedSnapshotToken || typeof expectedSnapshotToken !== 'string') {
      throw new FileTransferError('Expected snapshot token is required for upload.', 'TARGET_STALE');
    }
    if (pageEntry.snapshotToken !== expectedSnapshotToken) {
      throw new FileTransferError('Snapshot token is stale or does not match active page.', 'TARGET_STALE', {
        expected: expectedSnapshotToken,
        current: pageEntry.snapshotToken
      });
    }

    // 3. Normalize and validate input file path(s) (Sections 7, 11, 12, 13, 16)
    let filesToUpload = [];
    if (Array.isArray(filePaths) && filePaths.length > 0) {
      filesToUpload = filePaths;
    } else if (typeof filePath === 'string' && filePath.trim().length > 0) {
      filesToUpload = [filePath];
    } else {
      throw new FileTransferError('Explicit local file path is required for upload.', 'INVALID_FILE_PATH');
    }

    const validatedFiles = filesToUpload.map(fp => validateAndNormalizeUploadPath(fp, { maxBytes: options.maxBytes ?? this._uploadMaxBytes }));

    // 4. Resolve target file input element (Section 8)
    if (!target || typeof target !== 'object') {
      throw new FileTransferError('Target description is required for upload.', 'INVALID_TARGET_QUERY');
    }

    // Synchronize dynamic state before resolving target
    if (browserManager && typeof browserManager.syncDynamicState === 'function') {
      await browserManager.syncDynamicState(pageEntry.pageId);
    }

    const query = { ...target };
    if (!query.kind) {
      query.kind = 'input';
    }

    let resolution;
    if (browserManager && typeof browserManager.resolveTarget === 'function') {
      try {
        resolution = await browserManager.resolveTarget(query, {
          pageId: pageEntry.pageId,
          expectedSnapshotToken,
          ...options
        });
      } catch (err) {
        if (err.code === 'TARGET_NOT_FOUND' || err.code === 'TARGET_RESOLUTION_FAILED') {
          throw new FileTransferError('No matching file input found on the current page.', 'TARGET_NOT_FOUND');
        }
        if (err.code === 'TARGET_AMBIGUOUS') {
          throw new FileTransferError('Multiple file inputs matched the target query equally.', 'TARGET_AMBIGUOUS', {
            candidateCount: err.candidateCount
          });
        }
        if (err.code === 'TARGET_STALE') {
          throw new FileTransferError('Snapshot token is stale or does not match active page.', 'TARGET_STALE');
        }
        throw err;
      }
    } else {
      const inspection = pageEntry.inspection || { elements: [] };
      resolution = resolveTargetFromElements(inspection.elements, query, {
        snapshotToken: pageEntry.snapshotToken,
        pageUrl: pageEntry.currentUrl,
        pageTitle: pageEntry.title
      });
    }

    if (!resolution || resolution.resolution === 'not_found') {
      throw new FileTransferError('No matching file input found on the current page.', 'TARGET_NOT_FOUND');
    }
    if (resolution.resolution === 'ambiguous') {
      throw new FileTransferError('Multiple file inputs matched the target query equally.', 'TARGET_AMBIGUOUS', {
        candidateCount: resolution.candidateCount
      });
    }
    if (resolution.confidence !== 'high') {
      throw new FileTransferError('Target confidence is too low for upload interaction (high confidence required).', 'TARGET_CONFIDENCE_TOO_LOW');
    }

    const matched = resolution.match;
    if (!matched) {
      throw new FileTransferError('Target element not found on page.', 'TARGET_NOT_FOUND');
    }

    if (matched.disabled) {
      throw new FileTransferError('Target file input is disabled.', 'TARGET_DISABLED');
    }

    // Ensure target is an input of type="file" (Section 8 & 9)
    if (matched.kind !== 'input' || (matched.inputType && matched.inputType !== 'file')) {
      throw new FileTransferError('Target element is not a file input.', 'TARGET_NOT_FILE_INPUT', {
        kind: matched.kind,
        inputType: matched.inputType
      });
    }

    // Check multiple constraint (Section 15)
    if (!matched.multiple && validatedFiles.length > 1) {
      throw new FileTransferError('Target file input does not allow multiple files.', 'MULTIPLE_UPLOAD_NOT_SUPPORTED', {
        providedCount: validatedFiles.length
      });
    }

    // Check accept constraints (Section 14)
    if (matched.accept) {
      for (const vf of validatedFiles) {
        if (!validateAcceptConstraint(vf.filename, matched.accept)) {
          throw new FileTransferError(
            `File "${vf.filename}" does not match the target accept constraint ("${matched.accept}").`,
            'FILE_TYPE_NOT_ACCEPTED',
            { filename: vf.filename, accept: matched.accept }
          );
        }
      }
    }

    // 5. Locate DOM element handle (Section 17)
    const targetIndex = matched.targetId ? parseInt(matched.targetId.split('_')[1], 10) : -1;
    if (isNaN(targetIndex) || targetIndex < 0) {
      throw new FileTransferError('Target file input is missing valid target ID.', 'TARGET_CHANGED');
    }

    const page = pageEntry.page;
    let rawHandle = null;
    let elementHandle = null;

    try {
      if (typeof options.evaluateHandle === 'function') {
        rawHandle = await options.evaluateHandle(findTargetDomElement, {
          targetIndex,
          expectedKind: 'input',
          expectedTag: 'input'
        });
        elementHandle = rawHandle && typeof rawHandle.asElement === 'function' ? rawHandle.asElement() : rawHandle;
      } else if (typeof page.evaluateHandle === 'function') {
        rawHandle = await page.evaluateHandle(findTargetDomElement, {
          targetIndex,
          expectedKind: 'input',
          expectedTag: 'input'
        });
        elementHandle = rawHandle && typeof rawHandle.asElement === 'function' ? rawHandle.asElement() : rawHandle;
      } else if (options.mockElementHandle) {
        elementHandle = options.mockElementHandle;
      }

      if (!elementHandle) {
        throw new FileTransferError('Target file input changed or is no longer attached.', 'TARGET_CHANGED');
      }

      if (typeof elementHandle.isConnected === 'function') {
        const isConnected = await elementHandle.isConnected().catch(() => true);
        if (!isConnected) {
          throw new FileTransferError('Target file input is no longer connected to DOM.', 'TARGET_CHANGED');
        }
      }

      // 6. Set input files via Playwright mechanism (Section 17)
      const pathsToSet = validatedFiles.map(vf => vf.path);
      if (typeof elementHandle.setInputFiles === 'function') {
        await elementHandle.setInputFiles(pathsToSet);
      } else if (typeof page.setInputFiles === 'function') {
        await page.setInputFiles(`input[name="${matched.name || ''}"]`, pathsToSet);
      }

      // 7. Verify browser-side file input state safely (Section 18 & 19)
      let domFilesState = { count: validatedFiles.length, files: [] };
      if (typeof elementHandle.evaluate === 'function') {
        domFilesState = await elementHandle.evaluate((el) => {
          const files = el.files ? Array.from(el.files) : [];
          return {
            count: files.length,
            files: files.map(f => ({
              filename: f.name,
              size: f.size,
              type: f.type || ''
            }))
          };
        }).catch(() => domFilesState);
      }

      const verified = domFilesState.count > 0;

      // Safe result: only basenames and sizes, zero full paths exposed (Section 18 & 19)
      return {
        success: true,
        uploaded: true,
        count: domFilesState.count,
        filename: domFilesState.files[0]?.filename || validatedFiles[0].filename,
        size: domFilesState.files[0]?.size ?? validatedFiles[0].size,
        files: domFilesState.files.length > 0
          ? domFilesState.files.map(f => ({ filename: f.filename, size: f.size, type: f.type }))
          : validatedFiles.map(f => ({ filename: f.filename, size: f.size })),
        verified
      };
    } finally {
      if (rawHandle && typeof rawHandle.dispose === 'function') {
        try { await rawHandle.dispose(); } catch {}
      }
    }
  }

  /**
   * Executes a user-authorized safe file download triggered by semantic target click (Sections 22-45).
   *
   * @param {Object} params
   * @param {Object} params.pageEntry
   * @param {Object} params.target
   * @param {string} params.expectedSnapshotToken
   * @param {Object} [params.browserManager]
   * @param {Object} [options]
   * @returns {Promise<{ success: boolean, downloadId: string, filename: string, size: number, status: string, verified: boolean }>}
   */
  async downloadFile({
    pageEntry,
    target,
    expectedSnapshotToken,
    browserManager,
    options = {}
  }) {
    if (!pageEntry || !pageEntry.page || (typeof pageEntry.page.isClosed === 'function' && pageEntry.page.isClosed())) {
      throw new FileTransferError('Target page is closed or not available.', 'PAGE_CLOSED');
    }

    // 1. Check Human Handoff boundary (Section 42)
    if (browserManager && typeof browserManager.isHandoffActive === 'function') {
      if (browserManager.isHandoffActive(pageEntry.pageId)) {
        throw new FileTransferError(
          'File download is blocked while Human Handoff is active on this page.',
          'HUMAN_HANDOFF_ACTIVE',
          { pageId: pageEntry.pageId }
        );
      }
    }

    // 2. Validate expected snapshot token (Section 23)
    if (!expectedSnapshotToken || typeof expectedSnapshotToken !== 'string') {
      throw new FileTransferError('Expected snapshot token is required for download.', 'TARGET_STALE');
    }
    if (pageEntry.snapshotToken !== expectedSnapshotToken) {
      throw new FileTransferError('Snapshot token is stale or does not match active page.', 'TARGET_STALE', {
        expected: expectedSnapshotToken,
        current: pageEntry.snapshotToken
      });
    }

    // 3. Resolve target element (Section 23)
    if (!target || typeof target !== 'object') {
      throw new FileTransferError('Target description is required for download.', 'INVALID_TARGET_QUERY');
    }

    if (browserManager && typeof browserManager.syncDynamicState === 'function') {
      await browserManager.syncDynamicState(pageEntry.pageId);
    }

    let resolution;
    if (browserManager && typeof browserManager.resolveTarget === 'function') {
      try {
        resolution = await browserManager.resolveTarget(target, {
          pageId: pageEntry.pageId,
          expectedSnapshotToken,
          ...options
        });
      } catch (err) {
        if (err.code === 'TARGET_NOT_FOUND' || err.code === 'TARGET_RESOLUTION_FAILED') {
          throw new FileTransferError('No matching download target found on the current page.', 'TARGET_NOT_FOUND');
        }
        if (err.code === 'TARGET_AMBIGUOUS') {
          throw new FileTransferError('Multiple elements matched the download target query equally.', 'TARGET_AMBIGUOUS', {
            candidateCount: err.candidateCount
          });
        }
        if (err.code === 'TARGET_STALE') {
          throw new FileTransferError('Snapshot token is stale or does not match active page.', 'TARGET_STALE');
        }
        throw err;
      }
    } else {
      const inspection = pageEntry.inspection || { elements: [] };
      resolution = resolveTargetFromElements(inspection.elements, target, {
        snapshotToken: pageEntry.snapshotToken,
        pageUrl: pageEntry.currentUrl,
        pageTitle: pageEntry.title
      });
    }

    if (!resolution || resolution.resolution === 'not_found') {
      throw new FileTransferError('No matching download target found on the current page.', 'TARGET_NOT_FOUND');
    }
    if (resolution.resolution === 'ambiguous') {
      throw new FileTransferError('Multiple elements matched the download target query equally.', 'TARGET_AMBIGUOUS', {
        candidateCount: resolution.candidateCount
      });
    }
    if (resolution.confidence !== 'high') {
      throw new FileTransferError('Target confidence is too low for download interaction (high confidence required).', 'TARGET_CONFIDENCE_TOO_LOW');
    }

    const matched = resolution.match;
    if (!matched) {
      throw new FileTransferError('Target element not found on page.', 'TARGET_NOT_FOUND');
    }

    if (matched.disabled) {
      throw new FileTransferError('Target download element is disabled.', 'TARGET_DISABLED');
    }

    // 4. Resolve DOM element handle
    const targetIndex = matched.targetId ? parseInt(matched.targetId.split('_')[1], 10) : -1;
    if (isNaN(targetIndex) || targetIndex < 0) {
      throw new FileTransferError('Target element is missing valid target ID.', 'TARGET_CHANGED');
    }

    const page = pageEntry.page;
    let rawHandle = null;
    let elementHandle = null;

    // Ensure approved download directory exists (Section 25)
    fs.mkdirSync(this._downloadDir, { recursive: true });

    try {
      if (typeof options.evaluateHandle === 'function') {
        rawHandle = await options.evaluateHandle(findTargetDomElement, {
          targetIndex,
          expectedKind: matched.kind,
          expectedTag: matched.tag
        });
        elementHandle = rawHandle && typeof rawHandle.asElement === 'function' ? rawHandle.asElement() : rawHandle;
      } else if (typeof page.evaluateHandle === 'function') {
        rawHandle = await page.evaluateHandle(findTargetDomElement, {
          targetIndex,
          expectedKind: matched.kind,
          expectedTag: matched.tag
        });
        elementHandle = rawHandle && typeof rawHandle.asElement === 'function' ? rawHandle.asElement() : rawHandle;
      } else if (options.mockElementHandle) {
        elementHandle = options.mockElementHandle;
      }

      if (!elementHandle) {
        throw new FileTransferError('Target element changed or is no longer attached.', 'TARGET_CHANGED');
      }

      // 5. Trigger download and await browser download event (Section 24, 30, 31)
      const downloadTimeoutMs = options.timeoutMs ?? this._downloadTimeoutMs;
      let downloadEvent = null;

      try {
        if (typeof page.waitForEvent === 'function') {
          // Exactly ONE click action, single download event listener (Section 31)
          const [ dl ] = await Promise.all([
            page.waitForEvent('download', { timeout: downloadTimeoutMs }),
            elementHandle.click({ timeout: 10000 })
          ]);
          downloadEvent = dl;
        } else if (options.mockDownload) {
          downloadEvent = options.mockDownload;
        } else {
          throw new FileTransferError('Browser page does not support download events.', 'DOWNLOAD_FAILED');
        }
      } catch (evtErr) {
        if (evtErr instanceof FileTransferError) throw evtErr;
        const msg = (evtErr.message || '').toLowerCase();
        if (msg.includes('timeout') || msg.includes('timed out')) {
          throw new FileTransferError(`Download timed out after ${downloadTimeoutMs} ms waiting for browser event.`, 'DOWNLOAD_TIMEOUT', {
            timeoutMs: downloadTimeoutMs
          });
        }
        throw new FileTransferError(`Download trigger failed: ${evtErr.message}`, 'DOWNLOAD_FAILED');
      }

      if (!downloadEvent) {
        throw new FileTransferError('No browser download event was emitted.', 'DOWNLOAD_FAILED');
      }

      // Check browser download failure state (Section 32)
      if (typeof downloadEvent.failure === 'function') {
        const failure = await downloadEvent.failure();
        if (failure) {
          throw new FileTransferError(`Browser reported download failure: ${failure}`, 'DOWNLOAD_FAILED', { failure });
        }
      }

      // 6. Sanitize suggested filename & enforce executable policy (Section 27 & 36)
      const suggested = typeof downloadEvent.suggestedFilename === 'function'
        ? downloadEvent.suggestedFilename()
        : 'download';

      const { filename: sanitizedName, isExecutable } = sanitizeDownloadFilename(suggested);

      if (isExecutable) {
        if (typeof downloadEvent.cancel === 'function') {
          await downloadEvent.cancel().catch(() => {});
        }
        throw new FileTransferError(
          `Downloading executable or script file "${sanitizedName}" is blocked by security policy.`,
          'DOWNLOAD_TYPE_NOT_ALLOWED',
          { filename: sanitizedName }
        );
      }

      // 7. Enforce collision-safe path within approved directory (Section 26 & 28)
      const destPath = getCollisionSafePath(this._downloadDir, sanitizedName);
      const finalFilename = path.basename(destPath);

      // Verify destination path never escapes approved download directory (Section 52)
      const relativeToDir = path.relative(this._downloadDir, destPath);
      if (relativeToDir.startsWith('..') || path.isAbsolute(relativeToDir)) {
        throw new FileTransferError('Path traversal detected in destination path.', 'TRAVERSAL_BLOCKED');
      }

      // 8. Save file to disk
      if (typeof downloadEvent.saveAs === 'function') {
        await downloadEvent.saveAs(destPath);
      }

      // 9. Verify saved file exists, is regular file, and within size limit (Section 29 & 32)
      let stat;
      try {
        stat = await fs.promises.stat(destPath);
      } catch (statErr) {
        throw new FileTransferError(`Failed to verify saved download: ${statErr.message}`, 'DOWNLOAD_FAILED');
      }

      if (!stat.isFile()) {
        try { await fs.promises.unlink(destPath); } catch {}
        throw new FileTransferError('Saved download artifact is not a regular file.', 'DOWNLOAD_FAILED');
      }

      const maxBytes = options.maxBytes ?? this._downloadMaxBytes;
      if (stat.size > maxBytes) {
        // Delete oversized artifact immediately (Section 29)
        try { await fs.promises.unlink(destPath); } catch {}
        throw new FileTransferError(
          `Downloaded file size (${stat.size} bytes) exceeds maximum limit of ${maxBytes} bytes.`,
          'DOWNLOAD_TOO_LARGE',
          { size: stat.size, maxBytes }
        );
      }

      // 10. Record in safe registry with opaque downloadId (Section 33 & 34)
      const downloadId = generateDownloadId();
      const record = {
        downloadId,
        filename: finalFilename,
        size: stat.size,
        createdAt: new Date().toISOString(),
        status: 'completed',
        _destPath: destPath // internal only, not exposed in public list
      };

      this._downloads.set(downloadId, record);

      // Safe result: only opaque ID, sanitized basename, size, status (Section 32 & 35)
      return {
        success: true,
        downloadId,
        filename: finalFilename,
        size: stat.size,
        status: 'completed',
        verified: true
      };
    } finally {
      if (rawHandle && typeof rawHandle.dispose === 'function') {
        try { await rawHandle.dispose(); } catch {}
      }
    }
  }

  /**
   * Lists completed JARVIS-managed downloads with safe metadata (Section 34).
   *
   * @returns {Array<{ downloadId: string, filename: string, size: number, createdAt: string, status: string }>}
   */
  listDownloads() {
    return Array.from(this._downloads.values()).map(d => ({
      downloadId: d.downloadId,
      filename: d.filename,
      size: d.size,
      createdAt: d.createdAt,
      status: d.status
    }));
  }

  /**
   * Retrieves safe metadata for a specific download.
   *
   * @param {string} downloadId
   * @returns {Object|null}
   */
  getDownload(downloadId) {
    if (!downloadId || !this._downloads.has(downloadId)) return null;
    const d = this._downloads.get(downloadId);
    return {
      downloadId: d.downloadId,
      filename: d.filename,
      size: d.size,
      createdAt: d.createdAt,
      status: d.status
    };
  }

  /**
   * Cleans all files in the download directory and clears in-memory registry.
   */
  async clearDownloads() {
    this._downloads.clear();
    try {
      if (fs.existsSync(this._downloadDir)) {
        const files = await fs.promises.readdir(this._downloadDir);
        for (const file of files) {
          const filePath = path.join(this._downloadDir, file);
          try {
            await fs.promises.unlink(filePath);
          } catch {}
        }
      }
    } catch {}
  }
}
