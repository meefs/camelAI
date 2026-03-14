import { describe, it, expect } from 'vitest';
import {
  OrgUsageLogSchema,
  OrgUsageLogSumSchema,
} from '../workers/main/src/routes/admin/schemas.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query param validation schemas (mirror the route definitions)
// ---------------------------------------------------------------------------

const UsageLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  cursor: z.string().optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

const UsageLogSumQuerySchema = z.object({
  from: z.coerce.number().int().min(0),
  to: z.coerce.number().int().min(0),
});

// ---------------------------------------------------------------------------
// Usage log query validation
// ---------------------------------------------------------------------------

describe('usage log query validation', () => {
  it('accepts limit up to 1000', () => {
    const result = UsageLogQuerySchema.safeParse({ limit: '1000' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(1000);
  });

  it('rejects limit above 1000', () => {
    const result = UsageLogQuerySchema.safeParse({ limit: '1001' });
    expect(result.success).toBe(false);
  });

  it('accepts cursor param', () => {
    const result = UsageLogQuerySchema.safeParse({ cursor: 'abc123' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cursor).toBe('abc123');
  });

  it('accepts from/to date filters', () => {
    const result = UsageLogQuerySchema.safeParse({ from: '1710000000000', to: '1710100000000' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBe(1710000000000);
      expect(result.data.to).toBe(1710100000000);
    }
  });

  it('accepts empty query (all optional)', () => {
    const result = UsageLogQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts all params together', () => {
    const result = UsageLogQuerySchema.safeParse({
      limit: '200',
      cursor: 'next-page',
      from: '1000',
      to: '2000',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        limit: 200,
        cursor: 'next-page',
        from: 1000,
        to: 2000,
      });
    }
  });

  it('rejects limit below 1', () => {
    const result = UsageLogQuerySchema.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Usage log sum query validation
// ---------------------------------------------------------------------------

describe('usage log sum query validation', () => {
  it('requires both from and to', () => {
    expect(UsageLogSumQuerySchema.safeParse({}).success).toBe(false);
    expect(UsageLogSumQuerySchema.safeParse({ from: '1000' }).success).toBe(false);
    expect(UsageLogSumQuerySchema.safeParse({ to: '2000' }).success).toBe(false);
  });

  it('accepts valid from/to', () => {
    const result = UsageLogSumQuerySchema.safeParse({ from: '1000', to: '2000' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBe(1000);
      expect(result.data.to).toBe(2000);
    }
  });

  it('rejects negative timestamps', () => {
    expect(UsageLogSumQuerySchema.safeParse({ from: '-1', to: '2000' }).success).toBe(false);
    expect(UsageLogSumQuerySchema.safeParse({ from: '1000', to: '-1' }).success).toBe(false);
  });

  it('coerces string timestamps to numbers', () => {
    const result = UsageLogSumQuerySchema.safeParse({
      from: '1710000000000',
      to: '1710100000000',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.from).toBe('number');
      expect(typeof result.data.to).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// Response schema validation
// ---------------------------------------------------------------------------

describe('OrgUsageLogSchema', () => {
  it('accepts response with pagination fields', () => {
    const result = OrgUsageLogSchema.safeParse({
      org_id: 'org-1',
      entries: [],
      count: 0,
      has_more: true,
      next_cursor: 'cursor-abc',
    });
    expect(result.success).toBe(true);
  });

  it('accepts response without pagination fields (backwards compat)', () => {
    const result = OrgUsageLogSchema.safeParse({
      org_id: 'org-1',
      entries: [],
      count: 0,
    });
    expect(result.success).toBe(true);
  });

  it('accepts full entry shape', () => {
    const result = OrgUsageLogSchema.safeParse({
      org_id: 'org-1',
      entries: [
        {
          id: 1,
          workspace_id: 'ws-1',
          user_id: 'user-1',
          thread_id: 'thread-1',
          model: 'claude-sonnet-4-5-20250514',
          provider: 'anthropic',
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 50,
          cost_usd: 0.015,
          duration_ms: 3200,
          created_at_ms: 1710000000000,
        },
      ],
      count: 1,
      has_more: false,
      next_cursor: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('OrgUsageLogSumSchema', () => {
  it('validates a complete sum response', () => {
    const result = OrgUsageLogSumSchema.safeParse({
      org_id: 'org-1',
      total_cost_usd: 42.5,
      total_requests: 350,
      total_input_tokens: 500000,
      total_output_tokens: 100000,
      total_cache_creation_input_tokens: 50000,
      total_cache_read_input_tokens: 30000,
      from_ms: 1710000000000,
      to_ms: 1710100000000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = OrgUsageLogSumSchema.safeParse({
      org_id: 'org-1',
      total_cost_usd: 42.5,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Query string building (mirrors route handler logic)
// ---------------------------------------------------------------------------

describe('usage log query string building', () => {
  function buildLogQueryString(opts: {
    limit?: number;
    cursor?: string;
    from?: number;
    to?: number;
  }): string {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.from) params.set('from', String(opts.from));
    if (opts.to) params.set('to', String(opts.to));
    return params.toString() ? `?${params}` : '';
  }

  it('builds empty string with no params', () => {
    expect(buildLogQueryString({})).toBe('');
  });

  it('builds correct string with all params', () => {
    const qs = buildLogQueryString({ limit: 100, cursor: 'abc', from: 1000, to: 2000 });
    const params = new URLSearchParams(qs.slice(1));
    expect(params.get('limit')).toBe('100');
    expect(params.get('cursor')).toBe('abc');
    expect(params.get('from')).toBe('1000');
    expect(params.get('to')).toBe('2000');
  });

  it('omits undefined params', () => {
    const qs = buildLogQueryString({ limit: 50 });
    const params = new URLSearchParams(qs.slice(1));
    expect(params.get('limit')).toBe('50');
    expect(params.has('cursor')).toBe(false);
    expect(params.has('from')).toBe(false);
    expect(params.has('to')).toBe(false);
  });
});
