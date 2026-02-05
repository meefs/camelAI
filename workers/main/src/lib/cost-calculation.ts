/**
 * Cost Calculation Module
 *
 * Converts LLM usage (tokens) to cost in cents.
 * Prices are per 1M tokens (MTok).
 */

/**
 * Usage structure from Anthropic API response
 */
export interface UsageForCost {
  input_tokens: number;
  output_tokens: number;
  // Legacy flat cache fields (may still appear)
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  // New nested cache structure
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export interface ModelPricing {
  input_per_million: number;           // Base input tokens ($ per MTok, stored as cents)
  output_per_million: number;          // Output tokens
  cache_write_5m_per_million: number;  // 5-minute ephemeral cache writes
  cache_write_1h_per_million: number;  // 1-hour ephemeral cache writes
  cache_read_per_million: number;      // Cache hits & refreshes
}

// Pricing in cents per 1M tokens
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude Opus 4.6
  'claude-opus-4-6': {
    input_per_million: 500,           // $5/MTok
    output_per_million: 2500,         // $25/MTok
    cache_write_5m_per_million: 625,  // $6.25/MTok
    cache_write_1h_per_million: 1000, // $10/MTok
    cache_read_per_million: 50,       // $0.50/MTok
  },
  // Claude Opus 4.5
  'claude-opus-4-5-20251101': {
    input_per_million: 500,           // $5/MTok
    output_per_million: 2500,         // $25/MTok
    cache_write_5m_per_million: 625,  // $6.25/MTok
    cache_write_1h_per_million: 1000, // $10/MTok
    cache_read_per_million: 50,       // $0.50/MTok
  },
  // Claude Opus 4.1
  'claude-opus-4-1-20250414': {
    input_per_million: 1500,          // $15/MTok
    output_per_million: 7500,         // $75/MTok
    cache_write_5m_per_million: 1875, // $18.75/MTok
    cache_write_1h_per_million: 3000, // $30/MTok
    cache_read_per_million: 150,      // $1.50/MTok
  },
  // Claude Opus 4
  'claude-opus-4-20250514': {
    input_per_million: 1500,          // $15/MTok
    output_per_million: 7500,         // $75/MTok
    cache_write_5m_per_million: 1875, // $18.75/MTok
    cache_write_1h_per_million: 3000, // $30/MTok
    cache_read_per_million: 150,      // $1.50/MTok
  },
  // Claude Sonnet 4.5
  'claude-sonnet-4-5-20250929': {
    input_per_million: 300,           // $3/MTok
    output_per_million: 1500,         // $15/MTok
    cache_write_5m_per_million: 375,  // $3.75/MTok
    cache_write_1h_per_million: 600,  // $6/MTok
    cache_read_per_million: 30,       // $0.30/MTok
  },
  // Claude Sonnet 4
  'claude-sonnet-4-20250514': {
    input_per_million: 300,           // $3/MTok
    output_per_million: 1500,         // $15/MTok
    cache_write_5m_per_million: 375,  // $3.75/MTok
    cache_write_1h_per_million: 600,  // $6/MTok
    cache_read_per_million: 30,       // $0.30/MTok
  },
  // Claude Sonnet 3.7 (deprecated but may still be used)
  'claude-3-7-sonnet-20250219': {
    input_per_million: 300,           // $3/MTok
    output_per_million: 1500,         // $15/MTok
    cache_write_5m_per_million: 375,  // $3.75/MTok
    cache_write_1h_per_million: 600,  // $6/MTok
    cache_read_per_million: 30,       // $0.30/MTok
  },
  // Claude Haiku 4.5
  'claude-haiku-4-5-20251001': {
    input_per_million: 100,           // $1/MTok
    output_per_million: 500,          // $5/MTok
    cache_write_5m_per_million: 125,  // $1.25/MTok
    cache_write_1h_per_million: 200,  // $2/MTok
    cache_read_per_million: 10,       // $0.10/MTok
  },
  // Claude Haiku 3.5
  'claude-3-5-haiku-20241022': {
    input_per_million: 80,            // $0.80/MTok
    output_per_million: 400,          // $4/MTok
    cache_write_5m_per_million: 100,  // $1/MTok
    cache_write_1h_per_million: 160,  // $1.60/MTok
    cache_read_per_million: 8,        // $0.08/MTok
  },
  // Claude Opus 3 (deprecated but may still be used)
  'claude-3-opus-20240229': {
    input_per_million: 1500,          // $15/MTok
    output_per_million: 7500,         // $75/MTok
    cache_write_5m_per_million: 1875, // $18.75/MTok
    cache_write_1h_per_million: 3000, // $30/MTok
    cache_read_per_million: 150,      // $1.50/MTok
  },
  // Claude Sonnet 3.5 (may still be in use)
  'claude-3-5-sonnet-20241022': {
    input_per_million: 300,           // $3/MTok
    output_per_million: 1500,         // $15/MTok
    cache_write_5m_per_million: 375,  // $3.75/MTok
    cache_write_1h_per_million: 600,  // $6/MTok
    cache_read_per_million: 30,       // $0.30/MTok
  },
  // Claude Haiku 3
  'claude-3-haiku-20240307': {
    input_per_million: 25,            // $0.25/MTok
    output_per_million: 125,          // $1.25/MTok
    cache_write_5m_per_million: 30,   // $0.30/MTok
    cache_write_1h_per_million: 50,   // $0.50/MTok
    cache_read_per_million: 3,        // $0.03/MTok
  },
};

// Default pricing for unknown models (use Sonnet 4 pricing as reasonable default)
const DEFAULT_PRICING: ModelPricing = {
  input_per_million: 300,
  output_per_million: 1500,
  cache_write_5m_per_million: 375,
  cache_write_1h_per_million: 600,
  cache_read_per_million: 30,
};

/**
 * Get pricing for a model.
 * Tries exact match first, then tries to match by model family.
 */
export function getModelPricing(model: string): ModelPricing {
  // Exact match
  if (MODEL_PRICING[model]) {
    return MODEL_PRICING[model];
  }

  // Try to match by model family (e.g., "claude-sonnet-4-5" matches any sonnet 4.5)
  const modelLower = model.toLowerCase();

  if (modelLower.includes('opus-4-6') || modelLower.includes('opus-4.6')) {
    return MODEL_PRICING['claude-opus-4-6'];
  }
  if (modelLower.includes('opus-4-5') || modelLower.includes('opus-4.5')) {
    return MODEL_PRICING['claude-opus-4-5-20251101'];
  }
  if (modelLower.includes('opus-4-1') || modelLower.includes('opus-4.1')) {
    return MODEL_PRICING['claude-opus-4-1-20250414'];
  }
  if (modelLower.includes('opus-4') && !modelLower.includes('opus-4-5') && !modelLower.includes('opus-4-1')) {
    return MODEL_PRICING['claude-opus-4-20250514'];
  }
  if (modelLower.includes('sonnet-4-5') || modelLower.includes('sonnet-4.5')) {
    return MODEL_PRICING['claude-sonnet-4-5-20250929'];
  }
  if (modelLower.includes('sonnet-4') && !modelLower.includes('sonnet-4-5')) {
    return MODEL_PRICING['claude-sonnet-4-20250514'];
  }
  if (modelLower.includes('haiku-4-5') || modelLower.includes('haiku-4.5')) {
    return MODEL_PRICING['claude-haiku-4-5-20251001'];
  }
  if (modelLower.includes('3-5-haiku') || modelLower.includes('haiku-3.5') || modelLower.includes('haiku-3-5')) {
    return MODEL_PRICING['claude-3-5-haiku-20241022'];
  }
  if (modelLower.includes('3-5-sonnet') || modelLower.includes('sonnet-3.5') || modelLower.includes('sonnet-3-5')) {
    return MODEL_PRICING['claude-3-5-sonnet-20241022'];
  }
  if (modelLower.includes('3-opus') || modelLower.includes('opus-3')) {
    return MODEL_PRICING['claude-3-opus-20240229'];
  }
  if (modelLower.includes('3-haiku') || modelLower.includes('haiku-3')) {
    return MODEL_PRICING['claude-3-haiku-20240307'];
  }

  return DEFAULT_PRICING;
}

/**
 * Calculate cost in cents for a given usage
 */
export function calculateCostCents(model: string, usage: UsageForCost): number {
  const pricing = getModelPricing(model);

  // Base input tokens
  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input_per_million;

  // Output tokens
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output_per_million;

  // Cache costs
  let cacheWrite5mCost = 0;
  let cacheWrite1hCost = 0;
  let cacheReadCost = 0;

  // Handle new nested cache_creation structure
  if (usage.cache_creation) {
    if (usage.cache_creation.ephemeral_5m_input_tokens) {
      cacheWrite5mCost = (usage.cache_creation.ephemeral_5m_input_tokens / 1_000_000) * pricing.cache_write_5m_per_million;
    }
    if (usage.cache_creation.ephemeral_1h_input_tokens) {
      cacheWrite1hCost = (usage.cache_creation.ephemeral_1h_input_tokens / 1_000_000) * pricing.cache_write_1h_per_million;
    }
  }

  // Handle legacy flat cache_creation_input_tokens (use 5m pricing as default)
  if (usage.cache_creation_input_tokens && !usage.cache_creation) {
    cacheWrite5mCost = (usage.cache_creation_input_tokens / 1_000_000) * pricing.cache_write_5m_per_million;
  }

  // Cache read tokens (hits & refreshes)
  if (usage.cache_read_input_tokens) {
    cacheReadCost = (usage.cache_read_input_tokens / 1_000_000) * pricing.cache_read_per_million;
  }

  // Total cost in cents, rounded to 6 decimal places to avoid floating point issues
  const totalCents = inputCost + outputCost + cacheWrite5mCost + cacheWrite1hCost + cacheReadCost;
  return Math.round(totalCents * 1_000_000) / 1_000_000;
}

/**
 * Time window for spend limits
 */
export type LimitWindow = '1h' | '3h' | '24h' | '7d' | '30d';

/**
 * Spend limit configuration
 */
export interface SpendLimit {
  window: LimitWindow;
  limit_cents: number;
}

/**
 * Result of a spend limit check
 */
export interface SpendLimitResult {
  exceeded: boolean;
  window?: LimitWindow;
  current_cents?: number;
  limit_cents?: number;
  resets_at?: number;
}

/**
 * Spend tracking data stored in KV per window (fixed periods, not rolling)
 */
export interface SpendWindowData {
  spent_cents: number;
  resets_at: number;
}

/**
 * Full spend tracking data in KV
 */
export interface SpendTrackingKV {
  [window: string]: SpendWindowData;
}

/**
 * Convert a limit window to milliseconds
 */
export function windowToMs(window: LimitWindow): number {
  switch (window) {
    case '1h':
      return 60 * 60 * 1000;
    case '3h':
      return 3 * 60 * 60 * 1000;
    case '24h':
      return 24 * 60 * 60 * 1000;
    case '7d':
      return 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return 30 * 24 * 60 * 60 * 1000;
  }
}

/**
 * Spend limits: $30 per 3 hours, $200 per week
 */
const SPEND_LIMITS: SpendLimit[] = [
  { window: '3h', limit_cents: 3000 },
  { window: '7d', limit_cents: 20000 },
];

/**
 * Get the KV key for spend tracking
 */
export function getSpendKVKey(orgId: string): string {
  return `spend:${orgId}`;
}

/**
 * Check spend limits from KV.
 * Returns exceeded limit or { exceeded: false } if all OK.
 */
export async function checkSpendLimitsFromKV(
  kv: KVNamespace,
  orgId: string
): Promise<SpendLimitResult> {
  const value = await kv.get(getSpendKVKey(orgId));
  if (!value) return { exceeded: false };

  let data: SpendTrackingKV;
  try {
    data = JSON.parse(value) as SpendTrackingKV;
  } catch {
    return { exceeded: false };
  }

  const now = Date.now();

  for (const { window, limit_cents } of SPEND_LIMITS) {
    const windowData = data[window];
    if (!windowData || now >= windowData.resets_at) continue;

    if (windowData.spent_cents >= limit_cents) {
      return {
        exceeded: true,
        window,
        current_cents: windowData.spent_cents,
        limit_cents,
        resets_at: windowData.resets_at,
      };
    }
  }

  return { exceeded: false };
}

/**
 * Record spend to KV. Resets period if expired.
 */
export async function recordSpendToKV(
  kv: KVNamespace,
  orgId: string,
  costCents: number
): Promise<void> {
  const kvKey = getSpendKVKey(orgId);
  const now = Date.now();

  let data: SpendTrackingKV = {};
  const value = await kv.get(kvKey);
  if (value) {
    try {
      data = JSON.parse(value) as SpendTrackingKV;
    } catch {
      // Start fresh on parse error
    }
  }

  for (const { window } of SPEND_LIMITS) {
    const windowMs = windowToMs(window);
    const existing = data[window];

    if (!existing || now >= existing.resets_at) {
      // Period expired or doesn't exist - start new period
      data[window] = {
        spent_cents: costCents,
        resets_at: now + windowMs,
      };
    } else {
      // Period still active - accumulate
      data[window] = {
        spent_cents: existing.spent_cents + costCents,
        resets_at: existing.resets_at,
      };
    }
  }

  // Write back to KV (no TTL needed - we check resets_at)
  await kv.put(kvKey, JSON.stringify(data));
}
