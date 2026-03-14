/**
 * Zod schemas for the admin API.
 *
 * These serve dual purpose:
 * 1. Runtime request validation via hono-zod-openapi's openApi() middleware
 * 2. OpenAPI 3.1 spec auto-generation (schemas are read from routes at startup)
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export const ErrorSchema = z.object({
  error: z.string(),
});

const AvatarSchema = z.object({
  color: z.string(),
  content: z.string(),
});

// ---------------------------------------------------------------------------
// Pagination & query schemas
// ---------------------------------------------------------------------------

/**
 * Parse a boolean query param from its string representation.
 * z.coerce.boolean() is broken for query strings — Boolean("false") === true.
 * This accepts "true"/"1" → true, "false"/"0" → false, and rejects anything else.
 */
const booleanQueryParam = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

/** Base pagination params shared by all list endpoints. */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  search: z.string().optional(),
});

export const UsersQuerySchema = PaginationQuerySchema.extend({
  is_superuser: booleanQueryParam,
  is_orphaned: booleanQueryParam,
  sort_by: z.enum(['created_at', 'email', 'name']).optional().default('created_at'),
  sort_dir: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const ThreadsQuerySchema = PaginationQuerySchema.extend({
  org_id: z.string().optional(),
  workspace_id: z.string().optional(),
  created_by: z.string().optional(),
  sort_by: z.enum(['created_at', 'updated_at']).optional().default('updated_at'),
  sort_dir: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const OrgsQuerySchema = PaginationQuerySchema.extend({
  archived: booleanQueryParam,
  sort_by: z.enum(['created_at', 'name']).optional().default('created_at'),
  sort_dir: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const WorkspacesQuerySchema = PaginationQuerySchema.extend({
  org_id: z.string().optional(),
  archived: booleanQueryParam,
  sort_by: z.enum(['created_at', 'name']).optional().default('created_at'),
  sort_dir: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const AppsQuerySchema = PaginationQuerySchema.extend({
  org_id: z.string().optional(),
  workspace_id: z.string().optional(),
  is_public: booleanQueryParam,
  sort_by: z.enum(['created_at', 'updated_at']).optional().default('updated_at'),
  sort_dir: z.enum(['asc', 'desc']).optional().default('desc'),
});

// ---------------------------------------------------------------------------
// Request schemas (mutations)
// ---------------------------------------------------------------------------

export const AddMemberBodySchema = z.object({
  user_id: z.string(),
  role: z.enum(['admin', 'member']).optional().default('member'),
});

export const UpdateThreadBodySchema = z.object({
  title: z.string().optional(),
  created_by: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const StatsResponseSchema = z.object({
  total_users: z.number().int(),
  total_orgs: z.number().int(),
  total_memberships: z.number().int(),
  total_workspaces: z.number().int(),
  total_integrations: z.number().int(),
  orphaned_users: z.number().int(),
});

export const UserSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  avatar: AvatarSchema,
  created_at: z.number(),
  org_count: z.number().int(),
  is_superuser: z.boolean(),
  is_orphaned: z.boolean(),
});

export const OrgMembershipSchema = z.object({
  org_id: z.string(),
  role: z.enum(['admin', 'member']),
});

export const OrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable().optional(),
  created_by: z.string(),
  created_at: z.number(),
  archived: z.boolean(),
  billing_status: z.string().nullable().optional(),
  member_count: z.number().int(),
  workspace_count: z.number().int(),
});

export const OrgDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable().optional(),
  created_by: z.string(),
  created_at: z.number(),
  archived: z.boolean(),
  member_count: z.number().int(),
  workspace_count: z.number().int(),
  threads: z.array(z.any()),
  apps: z.array(z.any()),
  threadCount: z.number().int().nullable(),
  appCount: z.number().int().nullable(),
});

export const ThreadSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  workspace_id: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  created_by: z.string().nullable().optional(),
  org_id: z.string(),
  org_name: z.string(),
  workspace_name: z.string(),
});

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  org_id: z.string(),
  org_name: z.string(),
  description: z.string().nullable(),
  avatar: AvatarSchema,
  created_at: z.number(),
  created_by: z.string(),
  archived: z.boolean(),
  archived_at: z.number().nullable(),
  archived_by: z.string().nullable(),
  compute_tier: z.string(),
  thread_count: z.number().int(),
  integration_count: z.number().int(),
});

export const AppSchema = z.object({
  app_id: z.string(),
  script_name: z.string(),
  org_id: z.string(),
  workspace_id: z.string(),
  org_name: z.string(),
  org_slug: z.string().nullable().optional(),
  workspace_name: z.string(),
  created_by: z.string(),
  created_by_name: z.string().nullable().optional(),
  created_by_email: z.string().nullable().optional(),
  created_at: z.number(),
  updated_at: z.number(),
  is_public: z.boolean(),
  preview_status: z.string().nullable().optional(),
  preview_error: z.string().nullable().optional(),
});

export const AddMemberResponseSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
  role: z.string(),
});

export const KvEntrySchema = z.object({
  name: z.string(),
  metadata: z.unknown().optional(),
});

export const KvValueSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  type: z.enum(['json', 'string']),
});

export const R2ObjectSummarySchema = z.object({
  key: z.string(),
  size: z.number().int(),
  lastModified: z.string(),
  etag: z.string(),
});

export const R2ObjectDetailSchema = z.object({
  key: z.string(),
  size: z.number().int(),
  lastModified: z.string(),
  etag: z.string(),
  httpMetadata: z.record(z.string(), z.unknown()).optional(),
  customMetadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Usage / spend schemas
// ---------------------------------------------------------------------------

const WindowSpendSchema = z.object({
  label: z.string(),
  window_ms: z.number(),
  limit_usd: z.number(),
  spent_usd: z.number(),
  exceeded: z.boolean(),
});

export const OrgUsageSpendSchema = z.object({
  org_id: z.string(),
  total_cost_usd: z.number(),
  total_requests: z.number().int(),
  windows: z.array(WindowSpendSchema),
});

const SpendLimitSchema = z.object({
  window: z.number(),
  limit_usd: z.number(),
  label: z.string(),
});

export const OrgUsageLimitsSchema = z.object({
  org_id: z.string(),
  limits: z.array(SpendLimitSchema),
});

export const SetOrgLimitsBodySchema = z.object({
  limits: z.array(z.object({
    window_hours: z.number().positive(),
    limit_usd: z.number().positive(),
    label: z.string().optional(),
  })),
});

const UsageLogEntrySchema = z.object({
  id: z.number().int(),
  workspace_id: z.string(),
  user_id: z.string(),
  thread_id: z.string(),
  model: z.string(),
  provider: z.string(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cache_creation_input_tokens: z.number().int(),
  cache_read_input_tokens: z.number().int(),
  cost_usd: z.number(),
  duration_ms: z.number().int(),
  created_at_ms: z.number().int(),
});

export const OrgUsageLogSchema = z.object({
  org_id: z.string(),
  entries: z.array(UsageLogEntrySchema),
  count: z.number().int(),
  has_more: z.boolean().optional(),
  next_cursor: z.string().nullable().optional(),
});

export const OrgUsageLogSumSchema = z.object({
  org_id: z.string(),
  total_cost_usd: z.number(),
  total_requests: z.number().int(),
  total_input_tokens: z.number().int(),
  total_output_tokens: z.number().int(),
  total_cache_creation_input_tokens: z.number().int(),
  total_cache_read_input_tokens: z.number().int(),
  from_ms: z.number().int(),
  to_ms: z.number().int(),
});

// ---------------------------------------------------------------------------
// Wrapped list response helpers
// ---------------------------------------------------------------------------

/** Paginated list response: { items, total, offset, limit } */
export function paginatedList<T extends z.ZodType>(schema: T) {
  return z.object({
    items: z.array(schema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
  });
}

/** Simple list wrapper for non-paginated endpoints (KV, R2) */
export function dataList<T extends z.ZodType>(schema: T) {
  return z.object({ data: z.array(schema) });
}
