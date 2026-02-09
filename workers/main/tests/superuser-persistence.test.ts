/**
 * Regression tests for superuser persistence across DO re-instantiation.
 *
 * Bug: The _schema_version table in UserDO accumulates multiple rows (one per
 * migration version). The query `SELECT version FROM _schema_version LIMIT 1`
 * returns the lowest version (1) instead of the highest (7). This causes
 * migration V2 to re-run on every DO re-instantiation, which forcibly resets
 * is_superuser based on the hardcoded email allowlist — overriding any
 * manually-granted superuser status.
 *
 * Run with: bun run test:workers
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createUser,
  getUserById,
  updateUserProfile,
  remigrateUser,
  getUserSchemaVersion,
  createOrg,
  type TestEnv,
} from './test-helpers';

const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe('superuser persistence', () => {
  const testEnv = env as unknown as TestEnv;

  describe('schema version correctness', () => {
    it('should report the maximum schema version, not the minimum', async () => {
      // This is the core regression test for the bug.
      // After UserDO.migrate() runs, the _schema_version table has rows for
      // versions 1 through 7. The query must return the highest version (7).
      // Before the fix, LIMIT 1 returns 1 (the lowest), causing V2 migration
      // to re-run on every DO re-instantiation.
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Version Check User');

      const version = await getUserSchemaVersion(testEnv, userId);

      // The version should be the latest (currently 7), not the first (1)
      expect(version).toBeGreaterThanOrEqual(7);
    });
  });

  describe('manually-granted superuser survives DO re-instantiation', () => {
    it('should preserve superuser=true after remigration for non-allowlisted email', async () => {
      // 1. Create a user with a non-allowlisted email (NOT in SUPERUSER_EMAILS)
      const email = testEmail(); // e.g. test-xxx@example.com — not in allowlist
      const { userId, user } = await createUser(testEnv, email, 'password123', 'Admin Grantee');
      expect(user.is_superuser).toBe(false); // Not in hardcoded list

      // 2. Admin grants superuser via updateProfile (same as admin panel Save)
      const updated = await updateUserProfile(testEnv, userId, { is_superuser: true });
      expect(updated?.is_superuser).toBe(true);

      // 3. Verify getProfile returns superuser=true
      const profileBeforeRemigrate = await getUserById(testEnv, userId);
      expect(profileBeforeRemigrate?.is_superuser).toBe(true);

      // 4. Simulate DO re-instantiation (eviction + re-creation)
      // This re-runs the migration logic, which is where the bug lives.
      await remigrateUser(testEnv, userId);

      // 5. Verify superuser is STILL true after remigration
      // Before the fix: this FAILS because V2 migration re-runs and resets
      // is_superuser to false (email not in SUPERUSER_EMAILS)
      const profileAfterRemigrate = await getUserById(testEnv, userId);
      expect(profileAfterRemigrate?.is_superuser).toBe(true);
    });

    it('should preserve superuser=true through multiple remigrations', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Multi Remigrate User');

      // Grant superuser
      await updateUserProfile(testEnv, userId, { is_superuser: true });

      // Simulate 3 consecutive DO re-instantiations
      for (let i = 0; i < 3; i++) {
        await remigrateUser(testEnv, userId);
        const profile = await getUserById(testEnv, userId);
        expect(profile?.is_superuser).toBe(true);
      }
    });

    it('should preserve superuser=true after remigration + profile reads (admin dashboard simulation)', async () => {
      // Simulates what happens when a superuser accesses the admin dashboard:
      // 1. Admin grants superuser to user X
      // 2. User X accesses admin panel (triggers DO re-instantiation if evicted)
      // 3. Admin dashboard loader calls getProfile() on ALL users
      // 4. User X's superuser should not be affected

      const adminEmail = testEmail();
      const { userId: adminId } = await createUser(testEnv, adminEmail, 'password123', 'Admin');
      const { org } = await createOrg(testEnv, 'Test Org', adminId);

      // Create a regular user
      const userEmail = testEmail();
      const { userId: regularId } = await createUser(testEnv, userEmail, 'password123', 'Regular User');

      // Admin grants superuser to the regular user
      await updateUserProfile(testEnv, regularId, { is_superuser: true });

      // Simulate DO re-instantiation (user X's DO gets evicted)
      await remigrateUser(testEnv, regularId);

      // User X loads the admin dashboard — calls getProfile on themselves
      const profile = await getUserById(testEnv, regularId);
      expect(profile?.is_superuser).toBe(true);

      // Load profile again (simulating navigation within admin panel)
      const profile2 = await getUserById(testEnv, regularId);
      expect(profile2?.is_superuser).toBe(true);

      // Simulate another eviction + re-instantiation
      await remigrateUser(testEnv, regularId);

      // Profile should still have superuser after the second remigration
      const profile3 = await getUserById(testEnv, regularId);
      expect(profile3?.is_superuser).toBe(true);
    });
  });

  describe('superuser revocation also survives remigration', () => {
    it('should preserve superuser=false after remigration when explicitly revoked', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Revoked User');

      // Grant then revoke superuser
      await updateUserProfile(testEnv, userId, { is_superuser: true });
      await updateUserProfile(testEnv, userId, { is_superuser: false });

      const profileBefore = await getUserById(testEnv, userId);
      expect(profileBefore?.is_superuser).toBe(false);

      // Simulate DO re-instantiation
      await remigrateUser(testEnv, userId);

      const profileAfter = await getUserById(testEnv, userId);
      expect(profileAfter?.is_superuser).toBe(false);
    });
  });

  describe('admin panel operations with superuser', () => {
    it('should allow superuser to perform admin actions after remigration', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Admin User');
      const { org } = await createOrg(testEnv, 'Admin Org', userId);

      // Grant superuser
      await updateUserProfile(testEnv, userId, { is_superuser: true });

      // Simulate DO re-instantiation
      await remigrateUser(testEnv, userId);

      // Verify superuser can still be read (simulates requireSuperuser check)
      const profile = await getUserById(testEnv, userId);
      expect(profile?.is_superuser).toBe(true);

      // Simulate admin changing another user's profile via admin panel
      const otherEmail = testEmail();
      const { userId: otherId } = await createUser(testEnv, otherEmail, 'password123', 'Other User');

      // Admin updates the other user's name (simulates admin panel edit)
      const updatedOther = await updateUserProfile(testEnv, otherId, { name: 'Renamed User' });
      expect(updatedOther?.name).toBe('Renamed User');

      // Original admin should still be superuser after all these operations
      await remigrateUser(testEnv, userId);
      const finalProfile = await getUserById(testEnv, userId);
      expect(finalProfile?.is_superuser).toBe(true);
    });

    it('should maintain superuser across profile updates that do not change superuser', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Profile Update User');

      // Grant superuser
      await updateUserProfile(testEnv, userId, { is_superuser: true });

      // Update non-superuser fields (like the user changing their display name)
      await updateUserProfile(testEnv, userId, { name: 'New Display Name' });

      const profile = await getUserById(testEnv, userId);
      expect(profile?.name).toBe('New Display Name');
      expect(profile?.is_superuser).toBe(true);

      // Simulate DO re-instantiation
      await remigrateUser(testEnv, userId);

      const profileAfter = await getUserById(testEnv, userId);
      expect(profileAfter?.name).toBe('New Display Name');
      expect(profileAfter?.is_superuser).toBe(true);
    });
  });
});
