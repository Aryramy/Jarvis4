/**
 * Session Vault subsystem for JARVIS4 (Brick 35).
 * Provides device-local, Windows user-bound DPAPI encrypted storage for
 * human-authenticated browser sessions without automating passwords.
 *
 * Invariants:
 * - Device-local only: state is never pushed to Git, cloud, docs, or test artifacts.
 * - Windows user-bound: production encryption uses Windows DPAPI (CurrentUser scope).
 * - Fail closed: if DPAPI / secure vault is unavailable, returns SESSION_VAULT_UNAVAILABLE.
 *   Strictly NO fallback to plaintext storage.
 * - Secret sanitization: cookies, tokens, and storage values are NEVER returned in
 *   metadata, logs, error messages, or API responses.
 * - Opaque session IDs: generated as 'sess_<timestamp>_<randomHex>'. Never email/username.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export class SessionVaultError extends Error {
  /**
   * @param {string} message
   * @param {string} [code='SESSION_VAULT_ERROR']
   * @param {Object} [details={}]
   */
  constructor(message, code = 'SESSION_VAULT_ERROR', details = {}) {
    super(message);
    this.name = 'SessionVaultError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Generates an opaque session identifier.
 * Example: 'sess_1728900000000_a1b2c3d4e5f6'
 *
 * @returns {string}
 */
export function generateSessionId() {
  const timestamp = Date.now();
  const randomHex = crypto.randomBytes(6).toString('hex');
  return `sess_${timestamp}_${randomHex}`;
}

/**
 * Validates whether an opaque session ID conforms to the required format.
 *
 * @param {*} sessionId
 * @returns {boolean}
 */
export function isValidSessionId(sessionId) {
  if (typeof sessionId !== 'string') return false;
  return /^sess_\d+_[a-f0-9]{8,32}$/.test(sessionId.trim());
}

/**
 * Normalizes and extracts safe origins from Playwright storageState.
 * Only returns origin strings (scheme://host[:port]).
 * Paths, query params, cookies, tokens, and storage values are strictly omitted.
 *
 * @param {Object} storageState
 * @returns {string[]} Sorted array of unique origin strings
 */
export function extractSafeOrigins(storageState) {
  if (!storageState || typeof storageState !== 'object') {
    return [];
  }

  const originsSet = new Set();

  // 1. From storageState.origins (localStorage entries)
  if (Array.isArray(storageState.origins)) {
    for (const entry of storageState.origins) {
      if (entry && typeof entry.origin === 'string') {
        try {
          const parsed = new URL(entry.origin);
          originsSet.add(`${parsed.protocol}//${parsed.host}`);
        } catch {
          // ignore malformed
        }
      }
    }
  }

  // 2. From storageState.cookies
  if (Array.isArray(storageState.cookies)) {
    for (const cookie of storageState.cookies) {
      if (cookie && typeof cookie.domain === 'string') {
        const rawDomain = cookie.domain.replace(/^\./, '').trim();
        if (rawDomain) {
          const scheme = cookie.secure ? 'https' : 'http';
          // Check if domain includes port or is an IP / hostname
          try {
            const parsed = new URL(`${scheme}://${rawDomain}`);
            originsSet.add(`${parsed.protocol}//${parsed.host}`);
          } catch {
            // ignore malformed
          }
        }
      }
    }
  }

  return Array.from(originsSet).sort();
}

/**
 * Formats safe metadata for public exposure (API, UI, logs).
 * Guarantees zero sensitive authentication artifacts.
 *
 * @param {Object} rawProfile
 * @returns {Object} Safe metadata object
 */
export function createSafeMetadata(rawProfile) {
  if (!rawProfile || typeof rawProfile !== 'object') {
    throw new SessionVaultError('Invalid profile data for metadata extraction', 'SESSION_STATE_INVALID');
  }

  return {
    sessionId: rawProfile.sessionId,
    name: rawProfile.name,
    createdAt: rawProfile.createdAt,
    updatedAt: rawProfile.updatedAt,
    origins: Array.isArray(rawProfile.origins) ? [...rawProfile.origins] : []
  };
}

/**
 * PowerShell DPAPI Protection Provider for Windows.
 * Uses System.Security.Cryptography.ProtectedData in CurrentUser scope.
 * Reads plaintext via stdin and writes ciphertext via stdout.
 * Secrets are never exposed on command line arguments.
 */
export class DpapiProtectionProvider {
  constructor(options = {}) {
    this._isWindows = process.platform === 'win32';
    this._customSpawn = options.spawnSync || spawnSync;
    this._isAvailableCached = undefined;
  }

  /**
   * Checks if Windows DPAPI protection is available on this environment.
   * @returns {boolean}
   */
  isAvailable() {
    if (!this._isWindows) return false;
    if (this._isAvailableCached !== undefined) {
      return this._isAvailableCached;
    }
    try {
      const probeScript = `
        Add-Type -AssemblyName System.Security
        $t = [System.Security.Cryptography.ProtectedData]
        if ($t) { [Console]::Write("OK") }
      `;
      const encoded = Buffer.from(probeScript, 'utf16le').toString('base64');
      const res = this._customSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        timeout: 15000,
        encoding: 'utf8'
      });
      const ok = res.status === 0 && res.stdout?.trim() === 'OK';
      this._isAvailableCached = ok;
      return ok;
    } catch {
      this._isAvailableCached = false;
      return false;
    }
  }

  /**
   * Encrypts a buffer using Windows DPAPI CurrentUser scope.
   *
   * @param {Buffer} plaintextBuffer
   * @returns {Buffer} Encrypted ciphertext buffer
   */
  protect(plaintextBuffer) {
    if (!Buffer.isBuffer(plaintextBuffer)) {
      throw new SessionVaultError('Data to protect must be a Buffer', 'SESSION_STATE_INVALID');
    }
    if (!this.isAvailable()) {
      throw new SessionVaultError('Windows DPAPI protection is unavailable on this device.', 'SESSION_VAULT_UNAVAILABLE');
    }

    const script = `
      Add-Type -AssemblyName System.Security
      $in = [Console]::OpenStandardInput()
      $ms = New-Object System.IO.MemoryStream
      $in.CopyTo($ms)
      $bytes = $ms.ToArray()
      $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Console]::OpenStandardOutput().Write($enc, 0, $enc.Length)
    `;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const res = this._customSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      input: plaintextBuffer,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15000
    });

    if (res.status !== 0 || !res.stdout || res.stdout.length === 0) {
      throw new SessionVaultError('Failed to encrypt session state via DPAPI.', 'SESSION_DECRYPT_FAILED');
    }

    return Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout);
  }

  /**
   * Decrypts a DPAPI ciphertext buffer using CurrentUser scope.
   *
   * @param {Buffer} cipherBuffer
   * @returns {Buffer} Decrypted plaintext buffer
   */
  unprotect(cipherBuffer) {
    if (!Buffer.isBuffer(cipherBuffer)) {
      throw new SessionVaultError('Data to unprotect must be a Buffer', 'SESSION_STATE_INVALID');
    }
    if (!this.isAvailable()) {
      throw new SessionVaultError('Windows DPAPI protection is unavailable on this device.', 'SESSION_VAULT_UNAVAILABLE');
    }

    const script = `
      Add-Type -AssemblyName System.Security
      $in = [Console]::OpenStandardInput()
      $ms = New-Object System.IO.MemoryStream
      $in.CopyTo($ms)
      $bytes = $ms.ToArray()
      $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Console]::OpenStandardOutput().Write($dec, 0, $dec.Length)
    `;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const res = this._customSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      input: cipherBuffer,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15000
    });

    if (res.status !== 0 || !res.stdout || res.stdout.length === 0) {
      throw new SessionVaultError('Failed to decrypt session state via DPAPI.', 'SESSION_DECRYPT_FAILED');
    }

    return Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout);
  }
}

/**
 * Deterministic in-memory / test protection provider for offline test suites.
 * Uses a local key to encrypt/decrypt without requiring Windows DPAPI.
 */
export class MemoryProtectionProvider {
  constructor(options = {}) {
    this._key = crypto.createHash('sha256').update(options.seed || 'test-vault-secret-key').digest();
  }

  isAvailable() {
    return true;
  }

  protect(plaintextBuffer) {
    if (!Buffer.isBuffer(plaintextBuffer)) {
      throw new SessionVaultError('Data to protect must be a Buffer', 'SESSION_STATE_INVALID');
    }
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this._key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
    // Prepend IV and magic header 'MVAULT1:'
    const header = Buffer.from('MVAULT1:');
    return Buffer.concat([header, iv, encrypted]);
  }

  unprotect(cipherBuffer) {
    if (!Buffer.isBuffer(cipherBuffer)) {
      throw new SessionVaultError('Data to unprotect must be a Buffer', 'SESSION_STATE_INVALID');
    }
    const header = Buffer.from('MVAULT1:');
    if (cipherBuffer.length < header.length + 16 || !cipherBuffer.subarray(0, header.length).equals(header)) {
      throw new SessionVaultError('Invalid or corrupted vault ciphertext', 'SESSION_STATE_INVALID');
    }
    try {
      const iv = cipherBuffer.subarray(header.length, header.length + 16);
      const data = cipherBuffer.subarray(header.length + 16);
      const decipher = crypto.createDecipheriv('aes-256-cbc', this._key, iv);
      return Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
      throw new SessionVaultError('Decryption failed for memory vault ciphertext', 'SESSION_DECRYPT_FAILED');
    }
  }
}

/**
 * Provider representing an unavailable secure vault (e.g. non-Windows or disabled).
 */
export class UnavailableProtectionProvider {
  isAvailable() {
    return false;
  }
  protect() {
    throw new SessionVaultError('Secure session vault is unavailable on this device.', 'SESSION_VAULT_UNAVAILABLE');
  }
  unprotect() {
    throw new SessionVaultError('Secure session vault is unavailable on this device.', 'SESSION_VAULT_UNAVAILABLE');
  }
}

/**
 * SessionVault manages device-local encrypted browser authentication sessions.
 */
export class SessionVault {
  /**
   * @param {Object} [options]
   * @param {string} [options.vaultDir] - Path to directory storing vault files
   * @param {Object} [options.protectionProvider] - Protection provider instance
   */
  constructor(options = {}) {
    this._vaultDir = options.vaultDir || path.resolve(process.cwd(), 'runtime', 'session-vault');
    this._provider = options.protectionProvider || new DpapiProtectionProvider();
  }

  get vaultDir() {
    return this._vaultDir;
  }

  get protectionProvider() {
    return this._provider;
  }

  /**
   * Ensures the local session vault directory exists.
   * @private
   */
  _ensureVaultDir() {
    if (!fs.existsSync(this._vaultDir)) {
      fs.mkdirSync(this._vaultDir, { recursive: true });
    }
  }

  /**
   * Saves a browser session's storageState securely into the device vault.
   *
   * @param {Object} params
   * @param {string} params.name - Human-readable session profile name
   * @param {Object} params.storageState - Raw Playwright storageState ({ cookies, origins })
   * @param {string} [params.sessionId] - Optional existing sessionId for explicit update
   * @param {boolean} [params.overwrite=false] - Explicit flag required to overwrite an existing session
   * @returns {Promise<Object>} Safe session metadata (0 secrets)
   */
  async saveSession({ name, storageState, sessionId = null, overwrite = false } = {}) {
    // 1. Fail closed if secure provider is not available
    if (!this._provider || !this._provider.isAvailable()) {
      throw new SessionVaultError(
        'Session vault is unavailable. Cannot securely save session.',
        'SESSION_VAULT_UNAVAILABLE'
      );
    }

    // 2. Validate session name
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new SessionVaultError('Session name must be a non-empty string.', 'INVALID_SESSION_NAME');
    }
    const cleanName = name.trim();
    if (cleanName.length > 100) {
      throw new SessionVaultError('Session name must not exceed 100 characters.', 'INVALID_SESSION_NAME');
    }

    // 3. Validate storageState structure
    if (!storageState || typeof storageState !== 'object') {
      throw new SessionVaultError('Invalid or empty storageState provided.', 'SESSION_STATE_INVALID');
    }
    if (!Array.isArray(storageState.cookies) && !Array.isArray(storageState.origins)) {
      throw new SessionVaultError('storageState must contain cookies or origins array.', 'SESSION_STATE_INVALID');
    }

    // 4. Resolve sessionId
    let targetSessionId = sessionId;
    if (targetSessionId) {
      if (!isValidSessionId(targetSessionId)) {
        throw new SessionVaultError('Invalid session ID format.', 'INVALID_SESSION_ID');
      }
    } else {
      targetSessionId = generateSessionId();
    }

    this._ensureVaultDir();

    const vaultFile = path.join(this._vaultDir, `${targetSessionId}.vault`);
    const metaFile = path.join(this._vaultDir, `${targetSessionId}.meta.json`);
    const fileExists = fs.existsSync(vaultFile) || fs.existsSync(metaFile);

    if (fileExists && !overwrite) {
      throw new SessionVaultError(
        `Session "${targetSessionId}" already exists. Explicit overwrite is required.`,
        'SESSION_ALREADY_EXISTS',
        { sessionId: targetSessionId }
      );
    }

    const now = new Date().toISOString();
    let createdAt = now;
    if (fileExists && fs.existsSync(metaFile)) {
      try {
        const priorMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (priorMeta && priorMeta.createdAt) {
          createdAt = priorMeta.createdAt;
        }
      } catch {
        // preserve now
      }
    }

    // 5. Extract safe origin metadata
    const safeOrigins = extractSafeOrigins(storageState);

    // 6. Encrypt storageState in memory via provider (never written as plaintext)
    let plaintextBuffer;
    try {
      plaintextBuffer = Buffer.from(JSON.stringify(storageState), 'utf8');
    } catch {
      throw new SessionVaultError('Failed to serialize session storage state to JSON.', 'SESSION_STATE_INVALID');
    }

    let cipherBuffer;
    try {
      cipherBuffer = this._provider.protect(plaintextBuffer);
    } catch (err) {
      if (err instanceof SessionVaultError) throw err;
      throw new SessionVaultError('Encryption of session state failed.', 'SESSION_DECRYPT_FAILED');
    }

    // 7. Prepare safe metadata
    const metadata = {
      sessionId: targetSessionId,
      name: cleanName,
      createdAt,
      updatedAt: now,
      origins: safeOrigins
    };

    // 8. Atomic file writes (temp -> rename)
    const tempVault = `${vaultFile}.tmp.${Date.now()}`;
    const tempMeta = `${metaFile}.tmp.${Date.now()}`;

    try {
      fs.writeFileSync(tempVault, cipherBuffer);
      fs.writeFileSync(tempMeta, JSON.stringify(metadata, null, 2), 'utf8');
      fs.renameSync(tempVault, vaultFile);
      fs.renameSync(tempMeta, metaFile);
    } catch (ioErr) {
      try { if (fs.existsSync(tempVault)) fs.unlinkSync(tempVault); } catch {}
      try { if (fs.existsSync(tempMeta)) fs.unlinkSync(tempMeta); } catch {}
      throw new SessionVaultError(`Failed to write session vault files: ${ioErr.message}`, 'SESSION_SAVE_FAILED');
    }

    return createSafeMetadata(metadata);
  }

  /**
   * Loads a saved session from the device vault, decrypting its state in memory.
   *
   * @param {string} sessionId
   * @returns {Promise<{ metadata: Object, storageState: Object }>}
   */
  async loadSession(sessionId) {
    if (!this._provider || !this._provider.isAvailable()) {
      throw new SessionVaultError(
        'Session vault is unavailable. Cannot decrypt session state.',
        'SESSION_VAULT_UNAVAILABLE'
      );
    }

    if (!isValidSessionId(sessionId)) {
      throw new SessionVaultError('Invalid session ID format.', 'INVALID_SESSION_ID');
    }

    const vaultFile = path.join(this._vaultDir, `${sessionId}.vault`);
    const metaFile = path.join(this._vaultDir, `${sessionId}.meta.json`);

    if (!fs.existsSync(vaultFile) || !fs.existsSync(metaFile)) {
      throw new SessionVaultError(`Session "${sessionId}" not found.`, 'SESSION_NOT_FOUND', { sessionId });
    }

    let metaContent;
    let cipherBuffer;
    try {
      metaContent = fs.readFileSync(metaFile, 'utf8');
      cipherBuffer = fs.readFileSync(vaultFile);
    } catch (ioErr) {
      throw new SessionVaultError(`Failed to read session files: ${ioErr.message}`, 'SESSION_NOT_FOUND', { sessionId });
    }

    if (cipherBuffer.length === 0) {
      throw new SessionVaultError('Session vault file is empty or corrupted.', 'SESSION_STATE_INVALID', { sessionId });
    }

    let metadata;
    try {
      metadata = JSON.parse(metaContent);
    } catch {
      throw new SessionVaultError('Session metadata is corrupt or invalid JSON.', 'SESSION_STATE_INVALID', { sessionId });
    }

    // Decrypt cipher buffer in memory
    let decryptedBuffer;
    try {
      decryptedBuffer = this._provider.unprotect(cipherBuffer);
    } catch (err) {
      if (err instanceof SessionVaultError) throw err;
      throw new SessionVaultError('Failed to decrypt session state ciphertext.', 'SESSION_DECRYPT_FAILED', { sessionId });
    }

    let storageState;
    try {
      storageState = JSON.parse(decryptedBuffer.toString('utf8'));
    } catch {
      throw new SessionVaultError('Decrypted session state is not valid JSON.', 'SESSION_STATE_INVALID', { sessionId });
    }

    if (!storageState || typeof storageState !== 'object') {
      throw new SessionVaultError('Decrypted storage state is malformed.', 'SESSION_STATE_INVALID', { sessionId });
    }

    return {
      metadata: createSafeMetadata(metadata),
      storageState
    };
  }

  /**
   * Retrieves safe metadata for a single session without decrypting its state.
   *
   * @param {string} sessionId
   * @returns {Promise<Object>} Safe session metadata
   */
  async getSessionMetadata(sessionId) {
    if (!isValidSessionId(sessionId)) {
      throw new SessionVaultError('Invalid session ID format.', 'INVALID_SESSION_ID');
    }

    const metaFile = path.join(this._vaultDir, `${sessionId}.meta.json`);
    if (!fs.existsSync(metaFile)) {
      throw new SessionVaultError(`Session "${sessionId}" not found.`, 'SESSION_NOT_FOUND', { sessionId });
    }

    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      return createSafeMetadata(meta);
    } catch {
      throw new SessionVaultError('Session metadata is corrupt or invalid.', 'SESSION_STATE_INVALID', { sessionId });
    }
  }

  /**
   * Lists safe metadata for all persisted sessions on this device.
   * Does NOT open, decrypt, or access the .vault ciphertext files.
   *
   * @returns {Promise<Object[]>} Array of safe metadata objects
   */
  async listSessions() {
    if (!fs.existsSync(this._vaultDir)) {
      return [];
    }

    let files;
    try {
      files = fs.readdirSync(this._vaultDir);
    } catch {
      return [];
    }

    const sessions = [];
    for (const file of files) {
      if (file.endsWith('.meta.json')) {
        const metaPath = path.join(this._vaultDir, file);
        try {
          const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (raw && raw.sessionId && isValidSessionId(raw.sessionId)) {
            sessions.push(createSafeMetadata(raw));
          }
        } catch {
          // Ignore corrupt metadata entries in listing
        }
      }
    }

    // Sort by updatedAt descending (newest first)
    sessions.sort((a, b) => {
      const timeA = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const timeB = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return timeB - timeA;
    });

    return sessions;
  }

  /**
   * Deletes a session profile (both metadata and encrypted state) from the device vault.
   *
   * @param {string} sessionId
   * @returns {Promise<{ success: boolean, deletedSessionId: string }>}
   */
  async deleteSession(sessionId) {
    if (!isValidSessionId(sessionId)) {
      throw new SessionVaultError('Invalid session ID format.', 'INVALID_SESSION_ID');
    }

    const vaultFile = path.join(this._vaultDir, `${sessionId}.vault`);
    const metaFile = path.join(this._vaultDir, `${sessionId}.meta.json`);

    const hadVault = fs.existsSync(vaultFile);
    const hadMeta = fs.existsSync(metaFile);

    if (!hadVault && !hadMeta) {
      throw new SessionVaultError(`Session "${sessionId}" not found.`, 'SESSION_NOT_FOUND', { sessionId });
    }

    try {
      if (hadVault) fs.unlinkSync(vaultFile);
      if (hadMeta) fs.unlinkSync(metaFile);
    } catch (ioErr) {
      throw new SessionVaultError(`Failed to delete session files: ${ioErr.message}`, 'SESSION_DELETE_FAILED');
    }

    return {
      success: true,
      deletedSessionId: sessionId
    };
  }

  /**
   * Alias for listSessions.
   * @returns {Promise<Object[]>}
   */
  async listProfiles() {
    return this.listSessions();
  }

  /**
   * Alias for deleteSession.
   * @param {string} sessionId
   * @returns {Promise<{ success: boolean, deletedSessionId: string }>}
   */
  async delete(sessionId) {
    return this.deleteSession(sessionId);
  }
}

export default SessionVault;
