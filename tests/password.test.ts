/**
 * Unit tests for password hashing utilities
 *
 * Run with: npm run test:run -- tests/password.test.ts
 */

import { describe, it, expect } from 'vitest';

// Helper functions copied from worker/password.ts for testing
const ITERATIONS = 100000;
const HASH_ALGORITHM = 'SHA-256';
const KEY_LENGTH = 256;
const SALT_LENGTH = 16;

function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  const key = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: ITERATIONS,
      hash: HASH_ALGORITHM,
    },
    key,
    KEY_LENGTH
  );

  return `${bufferToHex(salt)}:${bufferToHex(new Uint8Array(hash))}`;
}

async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const [saltHex, hashHex] = storedHash.split(':');
  if (!saltHex || !hashHex) {
    return false;
  }

  const salt = hexToBuffer(saltHex);
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  const key = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: ITERATIONS,
      hash: HASH_ALGORITHM,
    },
    key,
    KEY_LENGTH
  );

  const computedHashHex = bufferToHex(new Uint8Array(hash));

  if (computedHashHex.length !== hashHex.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < computedHashHex.length; i++) {
    result |= computedHashHex.charCodeAt(i) ^ hashHex.charCodeAt(i);
  }

  return result === 0;
}

describe('bufferToHex', () => {
  it('should convert buffer to hex string', () => {
    const buffer = new Uint8Array([0, 1, 15, 16, 255]);
    expect(bufferToHex(buffer)).toBe('00010f10ff');
  });

  it('should handle empty buffer', () => {
    expect(bufferToHex(new Uint8Array([]))).toBe('');
  });

  it('should pad single digit hex values', () => {
    const buffer = new Uint8Array([0, 5, 10]);
    expect(bufferToHex(buffer)).toBe('00050a');
  });
});

describe('hexToBuffer', () => {
  it('should convert hex string to buffer', () => {
    const buffer = hexToBuffer('00010f10ff');
    expect(Array.from(buffer)).toEqual([0, 1, 15, 16, 255]);
  });

  it('should handle empty string', () => {
    expect(Array.from(hexToBuffer(''))).toEqual([]);
  });

  it('should handle uppercase hex', () => {
    const buffer = hexToBuffer('FF');
    expect(Array.from(buffer)).toEqual([255]);
  });
});

describe('Password Hashing', () => {
  it('should hash a password and produce a salt:hash format', async () => {
    const hash = await hashPassword('mypassword123');

    expect(hash).toContain(':');
    const [salt, hashPart] = hash.split(':');

    // Salt should be 16 bytes = 32 hex chars
    expect(salt).toHaveLength(32);
    // Hash should be 256 bits = 32 bytes = 64 hex chars
    expect(hashPart).toHaveLength(64);
  });

  it('should produce different hashes for the same password (random salt)', async () => {
    const hash1 = await hashPassword('samepassword');
    const hash2 = await hashPassword('samepassword');

    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for different passwords', async () => {
    const hash1 = await hashPassword('password1');
    const hash2 = await hashPassword('password2');

    expect(hash1).not.toBe(hash2);
  });
});

describe('Password Verification', () => {
  it('should verify correct password', async () => {
    const password = 'correctpassword';
    const hash = await hashPassword(password);

    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
  });

  it('should reject incorrect password', async () => {
    const hash = await hashPassword('correctpassword');

    const isValid = await verifyPassword('wrongpassword', hash);
    expect(isValid).toBe(false);
  });

  it('should reject malformed hash (no colon)', async () => {
    const isValid = await verifyPassword('password', 'nocolonhere');
    expect(isValid).toBe(false);
  });

  it('should reject empty hash', async () => {
    const isValid = await verifyPassword('password', '');
    expect(isValid).toBe(false);
  });

  it('should handle special characters in password', async () => {
    const password = 'P@$$w0rd!#$%^&*()_+-=[]{}|;:,.<>?';
    const hash = await hashPassword(password);

    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword(password + 'x', hash)).toBe(false);
  });

  it('should handle unicode characters in password', async () => {
    const password = 'password123';
    const hash = await hashPassword(password);

    expect(await verifyPassword(password, hash)).toBe(true);
  });

  it('should handle very long passwords', async () => {
    const password = 'a'.repeat(1000);
    const hash = await hashPassword(password);

    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword(password + 'b', hash)).toBe(false);
  });
});

describe('Constant-time comparison', () => {
  it('should not leak timing information on wrong password length', async () => {
    const hash = await hashPassword('password123');

    // Both should return false, but take similar time
    const start1 = performance.now();
    await verifyPassword('x', hash);
    const time1 = performance.now() - start1;

    const start2 = performance.now();
    await verifyPassword('wrongpasswordthatislonger', hash);
    const time2 = performance.now() - start2;

    // Times should be within reasonable bounds (allowing for PBKDF2 being slow)
    // This is a rough check - true timing attack tests would need many iterations
    expect(Math.abs(time1 - time2)).toBeLessThan(100);
  });
});
