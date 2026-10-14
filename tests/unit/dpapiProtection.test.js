import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DpapiProtectionProvider, SessionVaultError } from '../../src/browser/sessionVault.js';

describe('DpapiProtectionProvider Contract Tests (Brick 35 Section 54)', () => {
  it('detects availability correctly when probe succeeds', () => {
    const mockSpawn = (cmd, args) => {
      return { status: 0, stdout: 'OK' };
    };

    const provider = new DpapiProtectionProvider({ spawnSync: mockSpawn });
    // If running on Windows, isAvailable returns true; if not on Windows, returns false
    if (process.platform === 'win32') {
      assert.strictEqual(provider.isAvailable(), true);
    } else {
      assert.strictEqual(provider.isAvailable(), false);
    }
  });

  it('detects unavailablility when probe fails or throws', () => {
    const mockSpawn = () => {
      return { status: 1, stdout: '', stderr: 'Access Denied' };
    };

    const provider = new DpapiProtectionProvider({ spawnSync: mockSpawn });
    assert.strictEqual(provider.isAvailable(), false);
  });

  it('protect passes input via stdin and receives ciphertext via stdout', () => {
    let capturedInput = null;
    let capturedArgs = null;

    const mockSpawn = (cmd, args, opts) => {
      // If probing availability
      if (!opts || !opts.input) {
        return { status: 0, stdout: 'OK' };
      }
      capturedArgs = args;
      capturedInput = opts.input;
      return {
        status: 0,
        stdout: Buffer.from([1, 0, 0, 0, 42, 43, 44])
      };
    };

    const provider = new DpapiProtectionProvider({ spawnSync: mockSpawn });
    provider._isWindows = true;

    const plaintext = Buffer.from('my-sensitive-session-state', 'utf8');
    const ciphertext = provider.protect(plaintext);

    assert.ok(Buffer.isBuffer(ciphertext));
    assert.deepStrictEqual(ciphertext, Buffer.from([1, 0, 0, 0, 42, 43, 44]));
    assert.strictEqual(capturedInput, plaintext);

    // Verify command line does NOT contain sensitive data
    const argsStr = capturedArgs.join(' ');
    assert.ok(!argsStr.includes('my-sensitive-session-state'));
  });

  it('unprotect passes ciphertext via stdin and receives plaintext via stdout', () => {
    let capturedInput = null;

    const mockSpawn = (cmd, args, opts) => {
      if (!opts || !opts.input) {
        return { status: 0, stdout: 'OK' };
      }
      capturedInput = opts.input;
      return {
        status: 0,
        stdout: Buffer.from('decrypted-session-state', 'utf8')
      };
    };

    const provider = new DpapiProtectionProvider({ spawnSync: mockSpawn });
    provider._isWindows = true;

    const cipher = Buffer.from([1, 0, 0, 0, 42, 43, 44]);
    const decrypted = provider.unprotect(cipher);

    assert.ok(Buffer.isBuffer(decrypted));
    assert.strictEqual(decrypted.toString('utf8'), 'decrypted-session-state');
    assert.strictEqual(capturedInput, cipher);
  });

  it('throws SESSION_DECRYPT_FAILED without leaking raw data on execution failure', () => {
    const mockSpawn = (cmd, args, opts) => {
      if (!opts || !opts.input) {
        return { status: 0, stdout: 'OK' };
      }
      return {
        status: 1,
        stdout: '',
        stderr: 'PowerShell runtime failure'
      };
    };

    const provider = new DpapiProtectionProvider({ spawnSync: mockSpawn });
    provider._isWindows = true;

    assert.throws(
      () => provider.protect(Buffer.from('secret-auth-value')),
      (err) => {
        assert.ok(err instanceof SessionVaultError);
        assert.strictEqual(err.code, 'SESSION_DECRYPT_FAILED');
        assert.ok(!err.message.includes('secret-auth-value'));
        return true;
      }
    );
  });
});
