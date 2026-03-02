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

// ---------------------------------------------------------------------------
// Request schemas
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
  user_count: z.number().int(),
  org_count: z.number().int(),
  membership_count: z.number().int(),
});

export const UserSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  created_at: z.number(),
  org_count: z.number().int(),
  is_superuser: z.boolean(),
});

export const OrgMembershipSchema = z.object({
  org_id: z.string(),
  role: z.enum(['admin', 'member']),
});

export const OrgMemberDetailSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.enum(['admin', 'member']),
  joined_at: z.number(),
});

export const WorkspaceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.number(),
  archived: z.boolean(),
});

export const OrgEnrichedSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_by: z.string(),
  created_at: z.number(),
  member_count: z.number().int(),
  members: z.array(OrgMemberDetailSchema),
  workspace_count: z.number().int(),
  workspaces: z.array(WorkspaceSummarySchema),
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
// Wrapped list response helper
// ---------------------------------------------------------------------------

export function dataList<T extends z.ZodType>(schema: T) {
  return z.object({ data: z.array(schema) });
}
