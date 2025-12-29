import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password';

describe('Password hashing (Workers runtime)', () => {
  it('should hash and verify a password correctly', async () => {
    const password = 'mySecurePassword123!';
    const hash = await hashPassword(password);

    // Hash format should be salt:hash (both hex)
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);

    // Verification should succeed with correct password
    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
  });

  it('should reject incorrect passwords', async () => {
    const password = 'correctPassword';
    const hash = await hashPassword(password);

    const isValid = await verifyPassword('wrongPassword', hash);
    expect(isValid).toBe(false);
  });

  it('should generate unique hashes for the same password', async () => {
    const password = 'samePassword';
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);

    // Different salts should produce different hashes
    expect(hash1).not.toBe(hash2);

    // But both should verify correctly
    expect(await verifyPassword(password, hash1)).toBe(true);
    expect(await verifyPassword(password, hash2)).toBe(true);
  });

  it('should handle invalid hash format gracefully', async () => {
    const isValid = await verifyPassword('password', 'invalid-hash');
    expect(isValid).toBe(false);
  });
});
