/**
 * Spend limit tests using Cloudflare Vitest pool
 *
 * Tests the spend tracking and rate limiting functionality with real KV.
 * Uses fixed time periods (not rolling windows) that reset after expiry.
 *
 * Run with: bun run test:workers
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  checkSpendLimitsFromKV,
  recordSpendToKV,
  windowToMs,
  getSpendKVKey,
  type SpendTrackingKV,
} from '../src/lib/cost-calculation';

interface TestEnv {
  APP_KV: KVNamespace;
}

describe('Spend limits (fixed periods)', () => {
  const testEnv = env as unknown as TestEnv;

  // Generate unique org ID for each test
  const testOrgId = () => `test-org-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  describe('checkSpendLimitsFromKV', () => {
    it('should return not exceeded when no KV data exists', async () => {
      const orgId = testOrgId();
      const result = await checkSpendLimitsFromKV(testEnv.APP_KV, orgId);

      expect(result.exceeded).toBe(false);
    });

    it('should return not exceeded when under all limits', async () => {
      const orgId = testOrgId();
      const now = Date.now();

      await testEnv.APP_KV.put(
        getSpendKVKey(orgId),
        JSON.stringify({
          '3h': { spent_cents: 1000, resets_at: now + 3 * 60 * 60 * 1000 }, // $10, under $30 limit
          '7d': { spent_cents: 5000, resets_at: now + 7 * 24 * 60 * 60 * 1000 }, // $50, under $200 limit
        } satisfies SpendTrackingKV)
      );

      const result = await checkSpendLimitsFromKV(testEnv.APP_KV, orgId);

      expect(result.exceeded).toBe(false);
    });

    it('should return exceeded when 3h limit is hit', async () => {
      const orgId = testOrgId();
      const now = Date.now();

      await testEnv.APP_KV.put(
        getSpendKVKey(orgId),
        JSON.stringify({
          '3h': { spent_cents: 3000, resets_at: now + 60 * 60 * 1000 }, // $30, at the limit
          '7d': { spent_cents: 5000, resets_at: now + 7 * 24 * 60 * 60 * 1000 },
        } satisfies SpendTrackingKV)
      );

      const result = await checkSpendLimitsFromKV(testEnv.APP_KV, orgId);

      expect(result.exceeded).toBe(true);
      expect(result.window).toBe('3h');
      expect(result.current_cents).toBe(3000);
      expect(result.limit_cents).toBe(3000);
      expect(result.resets_at).toBeDefined();
    });

    it('should return exceeded when 7d limit is hit', async () => {
      const orgId = testOrgId();
      const now = Date.now();

      await testEnv.APP_KV.put(
        getSpendKVKey(orgId),
        JSON.stringify({
          '3h': { spent_cents: 1000, resets_at: now + 60 * 60 * 1000 }, // Under limit
          '7d': { spent_cents: 20000, resets_at: now + 24 * 60 * 60 * 1000 }, // $200, at the limit
        } satisfies SpendTrackingKV)
      );

      const result = await checkSpendLimitsFromKV(testEnv.APP_KV, orgId);

      expect(result.exceeded).toBe(true);
      expect(result.window).toBe('7d');
      expect(result.current_cents).toBe(20000);
      expect(result.limit_cents).toBe(20000);
    });

    it('should return not exceeded when period has expired', async () => {
      const orgId = testOrgId();
      const pastTime = Date.now() - 1000; // 1 second ago

      await testEnv.APP_KV.put(
        getSpendKVKey(orgId),
        JSON.stringify({
          '3h': { spent_cents: 5000, resets_at: pastTime }, // Over limit but expired
          '7d': { spent_cents: 25000, resets_at: pastTime }, // Over limit but expired
        } satisfies SpendTrackingKV)
      );

      const result = await checkSpendLimitsFromKV(testEnv.APP_KV, orgId);

      expect(result.exceeded).toBe(false);
    });

    it('should check 3h limit before 7d limit', async () => {
      const orgId = testOrgId();
      const now = Date.now();

      // Both limits exceeded - should return 3h first
      await testEnv.APP_KV.put(
        getSpendKVKey(orgId),
        JSON.stringify({
          '3h': { spent_cents: 5000, resets_at: now + 60 * 60 * 1000 },
          '7d': { spent_cents: 25000, resets_at: now + 24 * 60 * 60 * 1000 },
        } satisfies SpendTrackingKV)
      );

      const result = await checkSpendLimitsFromKV(testEnv.APP_KV, orgId);

      expect(result.exceeded).toBe(true);
      expect(result.window).toBe('3h'); // 3h is checked first
    });

    it('should handle malformed KV data gracefully', async () => {
      const orgId = testOrgId();

      await testEnv.APP_KV.put(getSpendKVKey(orgId), 'not json');

      const result = await checkSpendLimitsFromKV(testEnv.APP_KV, orgId);

      expect(result.exceeded).toBe(false);
    });

  });

  describe('recordSpendToKV', () => {
    it('should create new periods on first spend', async () => {
      const orgId = testOrgId();

      await recordSpendToKV(testEnv.APP_KV, orgId, 1500); // $15

      const kvData = await testEnv.APP_KV.get(getSpendKVKey(orgId));
      expect(kvData).not.toBeNull();

      const data = JSON.parse(kvData!) as SpendTrackingKV;
      expect(data['3h'].spent_cents).toBe(1500);
      expect(data['7d'].spent_cents).toBe(1500);
      expect(data['3h'].resets_at).toBeGreaterThan(Date.now());
      expect(data['7d'].resets_at).toBeGreaterThan(Date.now());
    });

    it('should accumulate spend within same period', async () => {
      const orgId = testOrgId();

      await recordSpendToKV(testEnv.APP_KV, orgId, 1000);
      await recordSpendToKV(testEnv.APP_KV, orgId, 500);
      await recordSpendToKV(testEnv.APP_KV, orgId, 250);

      const kvData = await testEnv.APP_KV.get(getSpendKVKey(orgId));
      const data = JSON.parse(kvData!) as SpendTrackingKV;

      expect(data['3h'].spent_cents).toBe(1750); // 1000 + 500 + 250
      expect(data['7d'].spent_cents).toBe(1750);
    });

    it('should reset period when expired', async () => {
      const orgId = testOrgId();
      const pastTime = Date.now() - 1000; // 1 second ago

      // Set up expired data
      await testEnv.APP_KV.put(
        getSpendKVKey(orgId),
        JSON.stringify({
          '3h': { spent_cents: 5000, resets_at: pastTime },
          '7d': { spent_cents: 10000, resets_at: pastTime },
        } satisfies SpendTrackingKV)
      );

      // Record new spend - should reset expired periods
      await recordSpendToKV(testEnv.APP_KV, orgId, 100);

      const kvData = await testEnv.APP_KV.get(getSpendKVKey(orgId));
      const data = JSON.parse(kvData!) as SpendTrackingKV;

      expect(data['3h'].spent_cents).toBe(100); // Reset, not 5100
      expect(data['7d'].spent_cents).toBe(100); // Reset, not 10100
      expect(data['3h'].resets_at).toBeGreaterThan(Date.now());
    });

    it('should trigger rate limit after exceeding threshold', async () => {
      const orgId = testOrgId();

      // Record spend just under the 3h limit
      await recordSpendToKV(testEnv.APP_KV, orgId, 2900); // $29

      // Should not be exceeded yet
      let result = await checkSpendLimitsFromKV(testEnv.APP_KV, orgId);
      expect(result.exceeded).toBe(false);

      // Record more spend to exceed the limit
      await recordSpendToKV(testEnv.APP_KV, orgId, 200); // Total: $31

      // Should be exceeded now
      result = await checkSpendLimitsFromKV(testEnv.APP_KV, orgId);
      expect(result.exceeded).toBe(true);
      expect(result.window).toBe('3h');
    });
  });

  describe('windowToMs', () => {
    it('should convert 1h correctly', () => {
      expect(windowToMs('1h')).toBe(60 * 60 * 1000);
    });

    it('should convert 3h correctly', () => {
      expect(windowToMs('3h')).toBe(3 * 60 * 60 * 1000);
    });

    it('should convert 24h correctly', () => {
      expect(windowToMs('24h')).toBe(24 * 60 * 60 * 1000);
    });

    it('should convert 7d correctly', () => {
      expect(windowToMs('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('should convert 30d correctly', () => {
      expect(windowToMs('30d')).toBe(30 * 24 * 60 * 60 * 1000);
    });
  });
});
