/**
 * Unit tests for cost calculation utilities
 *
 * Run with: bun run test:run -- tests/cost-calculation.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  calculateCostCents,
  getModelPricing,
  type UsageForCost,
} from '../workers/main/src/lib/cost-calculation';

describe('getModelPricing', () => {
  describe('exact model match', () => {
    it('should return correct pricing for claude-opus-4-6', () => {
      const pricing = getModelPricing('claude-opus-4-6');
      expect(pricing.input_per_million).toBe(500);
      expect(pricing.output_per_million).toBe(2500);
      expect(pricing.cache_write_5m_per_million).toBe(625);
      expect(pricing.cache_write_1h_per_million).toBe(1000);
      expect(pricing.cache_read_per_million).toBe(50);
    });

    it('should return correct pricing for claude-opus-4-5-20251101', () => {
      const pricing = getModelPricing('claude-opus-4-5-20251101');
      expect(pricing.input_per_million).toBe(500);
      expect(pricing.output_per_million).toBe(2500);
      expect(pricing.cache_write_5m_per_million).toBe(625);
      expect(pricing.cache_write_1h_per_million).toBe(1000);
      expect(pricing.cache_read_per_million).toBe(50);
    });

    it('should return correct pricing for claude-sonnet-4-5-20250929', () => {
      const pricing = getModelPricing('claude-sonnet-4-5-20250929');
      expect(pricing.input_per_million).toBe(300);
      expect(pricing.output_per_million).toBe(1500);
    });

    it('should return correct pricing for claude-haiku-4-5-20251001', () => {
      const pricing = getModelPricing('claude-haiku-4-5-20251001');
      expect(pricing.input_per_million).toBe(100);
      expect(pricing.output_per_million).toBe(500);
    });

    it('should return correct pricing for claude-3-5-haiku-20241022', () => {
      const pricing = getModelPricing('claude-3-5-haiku-20241022');
      expect(pricing.input_per_million).toBe(80);
      expect(pricing.output_per_million).toBe(400);
    });

    it('should return correct pricing for claude-3-haiku-20240307', () => {
      const pricing = getModelPricing('claude-3-haiku-20240307');
      expect(pricing.input_per_million).toBe(25);
      expect(pricing.output_per_million).toBe(125);
    });
  });

  describe('model family matching', () => {
    it('should match opus-4-6 variants', () => {
      const pricing = getModelPricing('claude-opus-4-6-some-other-date');
      expect(pricing.input_per_million).toBe(500);
    });

    it('should match opus-4-5 variants', () => {
      const pricing = getModelPricing('claude-opus-4-5-some-other-date');
      expect(pricing.input_per_million).toBe(500);
    });

    it('should match sonnet-4-5 variants', () => {
      const pricing = getModelPricing('claude-sonnet-4-5-20260101');
      expect(pricing.input_per_million).toBe(300);
    });

    it('should match haiku-4-5 variants', () => {
      const pricing = getModelPricing('claude-haiku-4-5-20260101');
      expect(pricing.input_per_million).toBe(100);
    });

    it('should match sonnet-4 without matching sonnet-4-5', () => {
      const pricing = getModelPricing('claude-sonnet-4-20260101');
      expect(pricing.input_per_million).toBe(300);
    });

    it('should match 3-5-sonnet variants', () => {
      const pricing = getModelPricing('claude-3-5-sonnet-20260101');
      expect(pricing.input_per_million).toBe(300);
    });

    it('should match 3-haiku variants', () => {
      const pricing = getModelPricing('claude-3-haiku-20260101');
      expect(pricing.input_per_million).toBe(25);
    });
  });

  describe('unknown models', () => {
    it('should return default (Sonnet 4) pricing for unknown models', () => {
      const pricing = getModelPricing('unknown-model-xyz');
      expect(pricing.input_per_million).toBe(300);
      expect(pricing.output_per_million).toBe(1500);
    });

    it('should return default pricing for empty string', () => {
      const pricing = getModelPricing('');
      expect(pricing.input_per_million).toBe(300);
    });
  });
});

describe('calculateCostCents', () => {
  describe('basic input/output calculation', () => {
    it('should calculate cost for simple usage (Sonnet 4.5)', () => {
      const usage: UsageForCost = {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      };
      // 1M input @ $3/M = 300 cents
      // 1M output @ $15/M = 1500 cents
      // Total = 1800 cents
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBe(1800);
    });

    it('should calculate cost for small usage', () => {
      const usage: UsageForCost = {
        input_tokens: 1000,
        output_tokens: 500,
      };
      // 1000 input @ $3/M = 0.3 cents
      // 500 output @ $15/M = 0.75 cents
      // Total = 1.05 cents
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBeCloseTo(1.05, 4);
    });

    it('should calculate cost for Opus 4.5 (most expensive)', () => {
      const usage: UsageForCost = {
        input_tokens: 100_000,
        output_tokens: 50_000,
      };
      // 100k input @ $5/M = 50 cents
      // 50k output @ $25/M = 125 cents
      // Total = 175 cents
      const cost = calculateCostCents('claude-opus-4-5-20251101', usage);
      expect(cost).toBe(175);
    });

    it('should calculate cost for Haiku 3 (cheapest)', () => {
      const usage: UsageForCost = {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      };
      // 1M input @ $0.25/M = 25 cents
      // 1M output @ $1.25/M = 125 cents
      // Total = 150 cents
      const cost = calculateCostCents('claude-3-haiku-20240307', usage);
      expect(cost).toBe(150);
    });

    it('should return 0 for zero tokens', () => {
      const usage: UsageForCost = {
        input_tokens: 0,
        output_tokens: 0,
      };
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBe(0);
    });
  });

  describe('cache read calculation', () => {
    it('should add cache read cost', () => {
      const usage: UsageForCost = {
        input_tokens: 100_000,
        output_tokens: 10_000,
        cache_read_input_tokens: 500_000,
      };
      // 100k input @ $3/M = 30 cents
      // 10k output @ $15/M = 15 cents
      // 500k cache read @ $0.30/M = 15 cents
      // Total = 60 cents
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBe(60);
    });

    it('should handle cache reads with Opus pricing', () => {
      const usage: UsageForCost = {
        input_tokens: 100_000,
        output_tokens: 10_000,
        cache_read_input_tokens: 1_000_000,
      };
      // 100k input @ $5/M = 50 cents
      // 10k output @ $25/M = 25 cents
      // 1M cache read @ $0.50/M = 50 cents
      // Total = 125 cents
      const cost = calculateCostCents('claude-opus-4-5-20251101', usage);
      expect(cost).toBe(125);
    });
  });

  describe('new cache_creation structure (5m and 1h tiers)', () => {
    it('should calculate 5m ephemeral cache cost', () => {
      const usage: UsageForCost = {
        input_tokens: 100_000,
        output_tokens: 10_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 200_000,
          ephemeral_1h_input_tokens: 0,
        },
      };
      // 100k input @ $3/M = 30 cents
      // 10k output @ $15/M = 15 cents
      // 200k 5m cache @ $3.75/M = 75 cents
      // Total = 120 cents
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBe(120);
    });

    it('should calculate 1h ephemeral cache cost', () => {
      const usage: UsageForCost = {
        input_tokens: 100_000,
        output_tokens: 10_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 200_000,
        },
      };
      // 100k input @ $3/M = 30 cents
      // 10k output @ $15/M = 15 cents
      // 200k 1h cache @ $6/M = 120 cents
      // Total = 165 cents
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBe(165);
    });

    it('should calculate mixed 5m and 1h cache cost', () => {
      const usage: UsageForCost = {
        input_tokens: 100_000,
        output_tokens: 10_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 100_000,
          ephemeral_1h_input_tokens: 100_000,
        },
      };
      // 100k input @ $3/M = 30 cents
      // 10k output @ $15/M = 15 cents
      // 100k 5m cache @ $3.75/M = 37.5 cents
      // 100k 1h cache @ $6/M = 60 cents
      // Total = 142.5 cents
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBe(142.5);
    });

    it('should handle full usage with all cache types', () => {
      const usage: UsageForCost = {
        input_tokens: 100_000,
        output_tokens: 50_000,
        cache_read_input_tokens: 200_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 50_000,
          ephemeral_1h_input_tokens: 50_000,
        },
      };
      // 100k input @ $3/M = 30 cents
      // 50k output @ $15/M = 75 cents
      // 200k cache read @ $0.30/M = 6 cents
      // 50k 5m cache @ $3.75/M = 18.75 cents
      // 50k 1h cache @ $6/M = 30 cents
      // Total = 159.75 cents
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBe(159.75);
    });
  });

  describe('legacy cache_creation_input_tokens format', () => {
    it('should use 5m pricing for legacy flat cache field', () => {
      const usage: UsageForCost = {
        input_tokens: 100_000,
        output_tokens: 10_000,
        cache_creation_input_tokens: 200_000,
      };
      // 100k input @ $3/M = 30 cents
      // 10k output @ $15/M = 15 cents
      // 200k legacy cache @ $3.75/M (5m rate) = 75 cents
      // Total = 120 cents
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBe(120);
    });

    it('should ignore legacy field when cache_creation object exists', () => {
      const usage: UsageForCost = {
        input_tokens: 100_000,
        output_tokens: 10_000,
        cache_creation_input_tokens: 500_000, // Should be ignored
        cache_creation: {
          ephemeral_5m_input_tokens: 100_000,
          ephemeral_1h_input_tokens: 0,
        },
      };
      // 100k input @ $3/M = 30 cents
      // 10k output @ $15/M = 15 cents
      // 100k 5m cache @ $3.75/M = 37.5 cents (NOT 500k!)
      // Total = 82.5 cents
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBe(82.5);
    });
  });

  describe('real-world usage example', () => {
    it('should calculate cost from API response format', () => {
      // Real usage from the user's example
      const usage: UsageForCost = {
        input_tokens: 744,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
        },
      };
      // 744 input @ $3/M = (744/1M) * 300 cents = 0.2232 cents
      // 1 output @ $15/M = (1/1M) * 1500 cents = 0.0015 cents
      // Total = 0.2247 cents
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBeCloseTo(0.2247, 4);
    });

    it('should calculate a typical chat response cost', () => {
      const usage: UsageForCost = {
        input_tokens: 5000,
        output_tokens: 2000,
        cache_read_input_tokens: 10000,
      };
      // 5k input @ $3/M = 1.5 cents
      // 2k output @ $15/M = 3 cents
      // 10k cache read @ $0.30/M = 0.3 cents
      // Total = 4.8 cents
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBe(4.8);
    });
  });

  describe('precision handling', () => {
    it('should handle very small token counts', () => {
      const usage: UsageForCost = {
        input_tokens: 1,
        output_tokens: 1,
      };
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      // 1 input @ $3/M = 0.0003 cents
      // 1 output @ $15/M = 0.0015 cents
      // Total = 0.0018 cents
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(0.01);
      expect(cost).toBeCloseTo(0.0018, 4);
    });

    it('should handle very large token counts', () => {
      const usage: UsageForCost = {
        input_tokens: 100_000_000, // 100M tokens
        output_tokens: 50_000_000,  // 50M tokens
      };
      // 100M input @ $3/M = 30000 cents = $300
      // 50M output @ $15/M = 75000 cents = $750
      // Total = 105000 cents = $1050
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      expect(cost).toBe(105000);
    });

    it('should round to 6 decimal places to avoid floating point issues', () => {
      const usage: UsageForCost = {
        input_tokens: 333,
        output_tokens: 777,
      };
      const cost = calculateCostCents('claude-sonnet-4-5-20250929', usage);
      // The result should have at most 6 decimal places
      const decimalPlaces = (cost.toString().split('.')[1] || '').length;
      expect(decimalPlaces).toBeLessThanOrEqual(6);
    });
  });
});
