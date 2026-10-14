import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SessionVault,
  SessionVaultError,
  generateSessionId,
  isValidSessionId,
  extractSafeOrigins,
  createSafeMetadata,
  MemoryProtectionProvider,
  UnavailableProtectionProvider
} from '../../src/browser/sessionVault.js';

describe('Session Vault Unit Tests (Brick 35)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-vault-'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe('Session ID Generation & Validation', () => {
    it('generates opaque session IDs starting with sess_', () => {
      const id1 = generateSessionId();
      const id2 = generateSessionId();
      assert.ok(id1.startsWith('sess_'));
      assert.ok(id2.startsWith('sess_'));
      assert.notStrictEqual(id1, id2);
      assert.ok(isValidSessionId(id1));
      assert.ok(isValidSessionId(id2));
    });

    it('rejects email, username, or non-opaque strings as session IDs', () => {
      assert.strictEqual(isValidSessionId('user@example.com'), false);
      assert.strictEqual(isValidSessionId('john_doe'), false);
      assert.strictEqual(isValidSessionId('sess_'), false);
      assert.strictEqual(isValidSessionId(''), false);
      assert.strictEqual(isValidSessionId(null), false);
      assert.strictEqual(isValidSessionId(12345), false);
      assert.strictEqual(isValidSessionId('sess_123_invalidChars!'), false);
    });
  });

  describe('Safe Origin Extraction', () => {
    it('extracts unique origins from cookies and origins arrays without paths or secrets', () => {
      const mockStorageState = {
        cookies: [
          { name: 'session_token', value: 'secret_abc123', domain: 'portal.example.com', path: '/app', secure: true },
          { name: 'auth_id', value: 'secret_xyz', domain: '.portal.example.com', path: '/login', secure: true },
          { name: 'insecure_cookie', value: '123', domain: 'insecure.example.com', path: '/', secure: false }
        ],
        origins: [
          {
            origin: 'https://service.example.com:8443',
            localStorage: [{ name: 'auth_token', value: 'sensitive_jwt_token' }]
          },
          {
            origin: 'https://portal.example.com',
            localStorage: [{ name: 'pref', value: 'dark' }]
          }
        ]
      };

      const origins = extractSafeOrigins(mockStorageState);
      assert.deepStrictEqual(origins, [
        'http://insecure.example.com',
        'https://portal.example.com',
        'https://service.example.com:8443'
      ]);

      // Prove that zero secret values or paths are in the origins output
      const json = JSON.stringify(origins);
      assert.ok(!json.includes('secret_abc123'));
      assert.ok(!json.includes('secret_xyz'));
      assert.ok(!json.includes('sensitive_jwt_token'));
      assert.ok(!json.includes('/app'));
      assert.ok(!json.includes('/login'));
      assert.ok(!json.includes('auth_token'));
      assert.ok(!json.includes('session_token'));
    });

    it('safely handles empty or malformed storageState objects', () => {
      assert.deepStrictEqual(extractSafeOrigins(null), []);
      assert.deepStrictEqual(extractSafeOrigins({}), []);
      assert.deepStrictEqual(extractSafeOrigins({ cookies: 'invalid' }), []);
      assert.deepStrictEqual(extractSafeOrigins({ origins: 'invalid' }), []);
    });
  });

  describe('createSafeMetadata', () => {
    it('returns only safe fields and redacts all auth state', () => {
      const raw = {
        sessionId: 'sess_123456789_abcdef01',
        name: 'Work Portal',
        createdAt: '2026-10-14T00:00:00.000Z',
        updatedAt: '2026-10-14T01:00:00.000Z',
        origins: ['https://example.com'],
        storageState: { cookies: [{ name: 'pw', value: 'secret' }] },
        cipherBuffer: Buffer.from('encrypted'),
        extraSecret: 'do_not_leak'
      };

      const safe = createSafeMetadata(raw);
      assert.deepStrictEqual(safe, {
        sessionId: 'sess_123456789_abcdef01',
        name: 'Work Portal',
        createdAt: '2026-10-14T00:00:00.000Z',
        updatedAt: '2026-10-14T01:00:00.000Z',
        origins: ['https://example.com']
      });

      assert.strictEqual(safe.storageState, undefined);
      assert.strictEqual(safe.cipherBuffer, undefined);
      assert.strictEqual(safe.extraSecret, undefined);
    });
  });

  describe('SessionVault CRUD with MemoryProtectionProvider', () => {
    let vault;

    beforeEach(() => {
      vault = new SessionVault({
        vaultDir: tempDir,
        protectionProvider: new MemoryProtectionProvider()
      });
    });

    it('saves a session, encrypts state on disk, and returns safe metadata', async () => {
      const storageState = {
        cookies: [{ name: 'auth_cookie', value: 'secret_12345', domain: 'example.com', path: '/', secure: true }],
        origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'jwt_secret' }] }]
      };

      const meta = await vault.saveSession({
        name: 'My Portal',
        storageState
      });

      assert.ok(meta.sessionId.startsWith('sess_'));
      assert.strictEqual(meta.name, 'My Portal');
      assert.deepStrictEqual(meta.origins, ['https://example.com']);
      assert.ok(meta.createdAt);
      assert.ok(meta.updatedAt);

      // Verify files created on disk
      const metaFile = path.join(tempDir, `${meta.sessionId}.meta.json`);
      const vaultFile = path.join(tempDir, `${meta.sessionId}.vault`);

      assert.ok(fs.existsSync(metaFile));
      assert.ok(fs.existsSync(vaultFile));

      // Verify the on-disk metadata file contains NO sensitive cookies or storage
      const metaContent = fs.readFileSync(metaFile, 'utf8');
      assert.ok(!metaContent.includes('secret_12345'));
      assert.ok(!metaContent.includes('jwt_secret'));

      // Verify the on-disk .vault file is NOT plaintext JSON
      const vaultBytes = fs.readFileSync(vaultFile);
      const vaultStr = vaultBytes.toString('utf8');
      assert.ok(!vaultStr.includes('"cookies"'));
      assert.ok(!vaultStr.includes('secret_12345'));
      assert.ok(!vaultStr.includes('jwt_secret'));
    });

    it('loads and decrypts a saved session correctly in memory', async () => {
      const storageState = {
        cookies: [{ name: 'auth_cookie', value: 'secret_12345', domain: 'example.com', path: '/', secure: true }],
        origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'jwt_secret' }] }]
      };

      const meta = await vault.saveSession({ name: 'Work Portal', storageState });
      const loaded = await vault.loadSession(meta.sessionId);

      assert.strictEqual(loaded.metadata.sessionId, meta.sessionId);
      assert.strictEqual(loaded.metadata.name, 'Work Portal');
      assert.deepStrictEqual(loaded.storageState, storageState);
    });

    it('lists metadata for all stored sessions without decrypting vault files', async () => {
      await vault.saveSession({
        name: 'Session 1',
        storageState: { cookies: [{ name: 'c1', value: 'v1', domain: 'a.com', secure: true }] }
      });
      await vault.saveSession({
        name: 'Session 2',
        storageState: { cookies: [{ name: 'c2', value: 'v2', domain: 'b.com', secure: true }] }
      });

      const list = await vault.listSessions();
      assert.strictEqual(list.length, 2);
      const names = list.map(s => s.name);
      assert.ok(names.includes('Session 1'));
      assert.ok(names.includes('Session 2'));

      for (const item of list) {
        assert.ok(item.sessionId.startsWith('sess_'));
        assert.ok(!item.storageState);
        assert.ok(!item.cookies);
      }
    });

    it('deletes a session profile cleanly', async () => {
      const meta = await vault.saveSession({
        name: 'To Delete',
        storageState: { cookies: [{ name: 'c', value: 'v', domain: 'del.com', secure: true }] }
      });

      const metaFile = path.join(tempDir, `${meta.sessionId}.meta.json`);
      const vaultFile = path.join(tempDir, `${meta.sessionId}.vault`);
      assert.ok(fs.existsSync(metaFile));
      assert.ok(fs.existsSync(vaultFile));

      const delResult = await vault.deleteSession(meta.sessionId);
      assert.strictEqual(delResult.success, true);
      assert.strictEqual(delResult.deletedSessionId, meta.sessionId);

      assert.strictEqual(fs.existsSync(metaFile), false);
      assert.strictEqual(fs.existsSync(vaultFile), false);

      // Subsequent load must fail with SESSION_NOT_FOUND
      await assert.rejects(
        async () => vault.loadSession(meta.sessionId),
        (err) => err instanceof SessionVaultError && err.code === 'SESSION_NOT_FOUND'
      );
    });

    it('rejects duplicate session save unless overwrite is explicit', async () => {
      const id = generateSessionId();
      await vault.saveSession({
        name: 'Original',
        sessionId: id,
        storageState: { cookies: [] }
      });

      // Saving with same ID without overwrite should reject
      await assert.rejects(
        async () => vault.saveSession({
          name: 'Overwrite Attempt',
          sessionId: id,
          storageState: { cookies: [] }
        }),
        (err) => err instanceof SessionVaultError && err.code === 'SESSION_ALREADY_EXISTS'
      );

      // Saving with overwrite: true succeeds
      const updated = await vault.saveSession({
        name: 'Updated Name',
        sessionId: id,
        overwrite: true,
        storageState: { cookies: [] }
      });
      assert.strictEqual(updated.name, 'Updated Name');
    });

    it('validates session name constraints', async () => {
      await assert.rejects(
        async () => vault.saveSession({ name: '', storageState: { cookies: [] } }),
        (err) => err instanceof SessionVaultError && err.code === 'INVALID_SESSION_NAME'
      );

      await assert.rejects(
        async () => vault.saveSession({ name: '   ', storageState: { cookies: [] } }),
        (err) => err instanceof SessionVaultError && err.code === 'INVALID_SESSION_NAME'
      );

      await assert.rejects(
        async () => vault.saveSession({ name: 'a'.repeat(101), storageState: { cookies: [] } }),
        (err) => err instanceof SessionVaultError && err.code === 'INVALID_SESSION_NAME'
      );
    });
  });

  describe('Security Boundaries & Fail-Closed Behavior', () => {
    it('fails closed when protection provider is unavailable with SESSION_VAULT_UNAVAILABLE (no plaintext fallback)', async () => {
      const unavailableVault = new SessionVault({
        vaultDir: tempDir,
        protectionProvider: new UnavailableProtectionProvider()
      });

      await assert.rejects(
        async () => unavailableVault.saveSession({
          name: 'Should Fail',
          storageState: { cookies: [{ name: 'auth', value: 'secret', domain: 'a.com' }] }
        }),
        (err) => err instanceof SessionVaultError && err.code === 'SESSION_VAULT_UNAVAILABLE'
      );

      // Verify that no plaintext files were written to disk
      const files = fs.readdirSync(tempDir);
      assert.strictEqual(files.length, 0);
    });

    it('fails closed when vault ciphertext is corrupted with SESSION_STATE_INVALID or SESSION_DECRYPT_FAILED', async () => {
      const vault = new SessionVault({
        vaultDir: tempDir,
        protectionProvider: new MemoryProtectionProvider()
      });

      const meta = await vault.saveSession({
        name: 'Corrupt Test',
        storageState: { cookies: [{ name: 'a', value: 'b', domain: 'c.com' }] }
      });

      const vaultFile = path.join(tempDir, `${meta.sessionId}.vault`);

      // Corrupt the vault file with garbage bytes
      fs.writeFileSync(vaultFile, Buffer.from('NOT_A_VALID_VAULT_PAYLOAD_GARBAGE_BYTES'));

      await assert.rejects(
        async () => vault.loadSession(meta.sessionId),
        (err) => err instanceof SessionVaultError && (err.code === 'SESSION_STATE_INVALID' || err.code === 'SESSION_DECRYPT_FAILED')
      );
    });

    it('fails closed when vault file is empty (0 bytes)', async () => {
      const vault = new SessionVault({
        vaultDir: tempDir,
        protectionProvider: new MemoryProtectionProvider()
      });

      const meta = await vault.saveSession({
        name: 'Empty Test',
        storageState: { cookies: [{ name: 'a', value: 'b', domain: 'c.com' }] }
      });

      const vaultFile = path.join(tempDir, `${meta.sessionId}.vault`);
      fs.writeFileSync(vaultFile, Buffer.alloc(0));

      await assert.rejects(
        async () => vault.loadSession(meta.sessionId),
        (err) => err instanceof SessionVaultError && err.code === 'SESSION_STATE_INVALID'
      );
    });
  });
});
