/**
 * Admin API route handlers on Hono.
 *
 * Each route uses the openApi() middleware from hono-zod-openapi to declare
 * its request/response schemas. The OpenAPI spec is auto-generated from these
 * declarations — no separate spec file needed.
 *
 * List endpoints use the D1 app index for efficient paginated,
 * filterable, sortable queries. Mutation endpoints still use individual DO stubs.
 *
 * All handlers assume Bearer auth has already been validated by the wrapper
 * in index.ts — they only handle routing and business logic.
 */

import { Hono } from "hono";
import { openApi } from "hono-zod-openapi";
import { z } from "zod";
import type { Env } from "../../types.js";
import type { LlmModel } from "../../../../../src/types.js";
import {
  buildPublicLlmProviderConfig,
  normalizeLlmModel,
  THREAD_MODEL_LOCK_MESSAGE,
} from "../../../../../src/lib/llm-provider-config.js";
import type {
  UserFilters,
  ThreadFilters,
  OrgFilters,
  WorkspaceFilters,
  AppFilters,
  AdminOrgDirectoryRow,
  AdminUserSummaryRow,
  AdminThreadListRow,
  AdminAppListRow,
} from "../../admin-index-types.js";
import type {
  DashboardRetentionOptions,
  DashboardRetentionResponse,
  DashboardSummaryOptions,
  DashboardSummaryResponse,
} from "../../admin-dashboard-metrics.js";
import {
  ErrorSchema,
  StatsResponseSchema,
  UserSummarySchema,
  OrgMembershipSchema,
  OrgDetailSchema,
  OrgModelAccessSchema,
  ThreadSchema,
  WorkspaceSchema,
  AppSchema,
  AddMemberBodySchema,
  AddMemberResponseSchema,
  UpdateUserCreditsBodySchema,
  UserCreditsResponseSchema,
  RefreshOrgCustomDomainBodySchema,
  RefreshOrgCustomDomainResponseSchema,
  GrantOrgCreditsBodySchema,
  GrantOrgCreditsResponseSchema,
  UpdateOrgModelAccessBodySchema,
  UpdateThreadBodySchema,
  BlockSignupIpBodySchema,
  BlockedSignupIpSchema,
  CreateBanBodySchema,
  BansQuerySchema,
  BanRecordSchema,
  BanStartResponseSchema,
  KvEntrySchema,
  KvValueSchema,
  R2ObjectSummarySchema,
  R2ObjectDetailSchema,
  ThreadMessagesResponseSchema,
  UsersQuerySchema,
  ThreadsQuerySchema,
  OrgsQuerySchema,
  OrgLlmProvidersQuerySchema,
  WorkspacesQuerySchema,
  AppsQuerySchema,
  OrgUsageSpendSchema,
  OrgUsageLimitsSchema,
  OrgUsageLogSchema,
  OrgUsageLogSumSchema,
  SpamOrgIdsResponseSchema,
  AdminOrgListItemSchema,
  AdminOrgLlmProviderListItemSchema,
  DashboardTopOrgsQuerySchema,
  DashboardTopOrgsResponseSchema,
  DashboardDailySpendQuerySchema,
  DashboardDailySpendResponseSchema,
  DashboardSpamSummaryResponseSchema,
  DashboardSummaryQuerySchema,
  DashboardSummaryResponseSchema,
  DashboardRetentionQuerySchema,
  DashboardRetentionResponseSchema,
  SetOrgLimitsBodySchema,
  EmailDomainBlocklistSchema,
  AddEmailDomainBodySchema,
  paginatedList,
  dataList,
} from "./schemas.js";
import {
  fetchOrgUsageAnalytics,
  fetchSpamOrgIds,
  fetchDailySpendAnalytics,
  isOrgExcludedByInternalDomains,
  normalizeBillingStatus,
  normalizeInternalDomains,
  type OrgUsageAnalyticsItem,
  type DailySpendDashboardResponse,
} from "./metrics.js";
import { parseDateOnlyUtc } from "../../admin-dashboard-metrics.js";
import {
  getBlocklistDomainsFromKV,
  setBlocklistInKV,
} from "../../../../../src/lib/email-domain-blocklist.js";
import {
  getAdminIndexStub,
  getOrgStub,
  getUserStub,
  loadAdminThreadMessagesResponse,
} from "./helpers.js";
import {
  runAdminOrgBanAndPurgeWithEnv,
  runAdminUserBanAndPurgeWithEnv,
  startAdminOrgBanAndPurgeWithEnv,
  startAdminUserBanAndPurgeWithEnv,
} from "../../../../../src/lib/auth-do.server.js";
import {
  listBanRecords,
  getOrgBanById,
  getUserBanById,
} from "../../ban-list.js";
import { waitUntil } from "cloudflare:workers";
import { refreshOrgCustomDomainHostnamesForAdmin } from "../../../../../src/lib/admin-custom-domain.server.js";
import { WorkspaceFilesystemClient } from "../../workspace-filesystem-do.js";
import {
  cancelLegacyWorkspaceMigration,
  queueLegacyWorkspaceMigrationIfNeeded,
} from "../../legacy-workspace-migration-queue.js";

type HonoEnv = { Bindings: Env };

function centsFromUsd(value: number): number {
  return Math.round(value * 100);
}

async function fetchChargeableUsageCents(
  env: Env,
  orgId: string,
): Promise<number> {
  const data = await getOrgStub(env, orgId).getUsageLogSum(0, Date.now(), true);
  return centsFromUsd(Number(data.total_cost_usd ?? 0));
}

type AdminOrgDirectoryLookup = {
  getOrgDirectoryRows(): Promise<AdminOrgDirectoryRow[]>;
  getOrgDirectoryByIds(orgIds: string[]): Promise<AdminOrgDirectoryRow[]>;
  getOrgDirectoryPaginated(
    offset: number,
    limit: number,
    search?: string,
    filters?: {
      archived?: boolean;
      sort_by?: "created_at" | "name";
      sort_dir?: "asc" | "desc";
      exclude_org_ids?: string[];
      exclude_creator_domains?: string[];
    },
  ): Promise<{
    items: AdminOrgDirectoryRow[];
    total: number;
    offset: number;
    limit: number;
  }>;
  getOrgLlmProviderDirectoryPaginated(
    offset: number,
    limit: number,
    search?: string,
    provider?: string,
  ): Promise<{
    items: AdminOrgDirectoryRow[];
    total: number;
    offset: number;
    limit: number;
  }>;
  getUsersByOrgIds(orgIds: string[]): Promise<AdminUserSummaryRow[]>;
  getThreadsByOrgIds(orgIds: string[]): Promise<AdminThreadListRow[]>;
  getAppsByOrgIds(orgIds: string[]): Promise<AdminAppListRow[]>;
};

type DashboardMetricsLookup = {
  computeDashboardSummary(
    options: DashboardSummaryOptions,
  ): Promise<DashboardSummaryResponse>;
  computeRetentionData(
    options?: DashboardRetentionOptions,
  ): Promise<DashboardRetentionResponse>;
};

function normalizeAdminThreadResponse<T extends { model: unknown }>(thread: T) {
  return {
    ...thread,
    model: normalizeLlmModel(thread.model),
  };
}

function normalizeAdminThreadPage<T extends { model: unknown }>(page: {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}) {
  return {
    ...page,
    items: page.items.map(normalizeAdminThreadResponse),
  };
}

function normalizeAdminDashboardSummary(
  summary: DashboardSummaryResponse,
): DashboardSummaryResponse {
  return {
    ...summary,
    selected_day: {
      ...summary.selected_day,
      latest_threads: summary.selected_day.latest_threads.map(
        normalizeAdminThreadResponse,
      ),
    },
  };
}

function enrichOrgListItems(
  orgs: AdminOrgDirectoryRow[],
  usageByOrgId: Map<string, OrgUsageAnalyticsItem>,
  options: {
    includeUsage: boolean;
    includeSpend30d: boolean;
    llmProviderByOrgId?: Map<
      string,
      Awaited<ReturnType<typeof getAdminOrgLlmProvider>>
    >;
  },
) {
  return orgs.map((org) => {
    const usage = usageByOrgId.get(org.id);
    const llmProvider = options.llmProviderByOrgId?.get(org.id);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug ?? null,
      created_by: org.created_by,
      created_at: org.created_at,
      archived: org.archived,
      // Keep the raw billing enum here for backwards compatibility on the
      // long-standing /orgs admin route. Metrics-specific endpoints normalize
      // "paying" -> "active" at their own boundary.
      billing_status: org.billing_status ?? null,
      member_count: org.member_count,
      workspace_count: org.workspace_count,
      ...(options.llmProviderByOrgId
        ? {
            has_llm_provider: Boolean(llmProvider),
            llm_provider: llmProvider ?? null,
          }
        : {}),
      ...(options.includeUsage
        ? {
            total_requests: usage?.total_requests ?? 0,
            total_cost_usd: usage?.total_cost_usd ?? 0,
            windows: usage?.windows ?? [],
          }
        : {}),
      ...(options.includeSpend30d
        ? {
            spend_30d: usage?.spend_30d ?? 0,
          }
        : {}),
    };
  });
}

function toDashboardTopOrgItem(
  org: AdminOrgDirectoryRow,
  usage: OrgUsageAnalyticsItem | undefined,
) {
  return {
    org_id: org.id,
    name: org.name,
    slug: org.slug ?? null,
    created_at: org.created_at,
    created_by: org.created_by,
    creator_name: org.creator_name ?? null,
    creator_email: org.creator_email ?? null,
    member_count: org.member_count,
    workspace_count: org.workspace_count,
    billing_status: normalizeBillingStatus(org.billing_status),
    total_requests: usage?.total_requests ?? 0,
    total_cost_usd: usage?.total_cost_usd ?? 0,
    spend_7d: usage?.spend_7d ?? 0,
    spend_30d: usage?.spend_30d ?? 0,
    windows: usage?.windows ?? [],
  };
}

async function getAdminOrgLlmProvider(env: Env, orgId: string) {
  const orgStub = getOrgStub(env, orgId);
  const record = await orgStub.getLlmProviderConfig();
  if (!record) return null;

  return buildPublicLlmProviderConfig(record, env.INTEGRATION_SECRET_KEY);
}

async function getAdminOrgLlmProviderMap(env: Env, orgIds: string[]) {
  const entries = await Promise.all(
    orgIds.map(
      async (orgId) =>
        [orgId, await getAdminOrgLlmProvider(env, orgId)] as const,
    ),
  );
  return new Map(entries);
}

async function notifyThreadMetadataChange(
  env: Env,
  threadId: string,
  updates: {
    title?: string;
    model?: LlmModel;
  },
  updatedAt?: number,
): Promise<void> {
  if (
    !env.CHAT_THREAD ||
    typeof env.CHAT_THREAD.get !== "function" ||
    typeof env.CHAT_THREAD.idFromName !== "function"
  ) {
    return;
  }

  try {
    const chatThread = env.CHAT_THREAD.get(
      env.CHAT_THREAD.idFromName(threadId),
    ) as unknown as {
      setTitle(title: string): Promise<void>;
      setModel(
        model: LlmModel,
        provider?: "claude" | "codex",
        updatedAt?: number,
      ): Promise<void>;
      refreshRunnerConfig(): Promise<void>;
    };

    if (updates.title) {
      await chatThread.setTitle(updates.title, updatedAt);
    }
    if (updates.model) {
      await chatThread.setModel(updates.model, undefined, updatedAt);
      await chatThread.refreshRunnerConfig();
    }
  } catch (error) {
    console.error(
      "[admin api] failed to notify ChatThreadDO of thread metadata change",
      {
        threadId,
        updates,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function toDailySpendBillingPlan(status: string | null | undefined): string {
  return status === "paying" ||
    status === "active" ||
    status === "trialing" ||
    status === "enterprise"
    ? "pro"
    : "free";
}

function toDailySpendPct(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Number(((value / total) * 100).toFixed(1));
}

export const routes = new Hono<HonoEnv>();

const LegacyWorkspaceMigrationTriggerBodySchema = z.object({
  force: z.boolean().optional().default(false),
  dry_run: z.boolean().optional().default(false),
  requested_by: z.string().trim().min(1).max(128).optional(),
});

const LegacyWorkspaceMigrationTriggerResponseSchema = z.object({
  success: z.boolean(),
  org_id: z.string(),
  workspace_id: z.string(),
  workflow_id: z.string(),
  dry_run: z.boolean(),
  status: z.literal("queued"),
});

const LegacyWorkspaceMigrationCancelBodySchema = z.object({
  requested_by: z.string().trim().min(1).max(128).optional(),
});

const LegacyWorkspaceMigrationCancelResponseSchema = z.object({
  success: z.boolean(),
  org_id: z.string(),
  workspace_id: z.string(),
  workflow_id: z.string().optional(),
  status: z.literal("canceled"),
});

const LegacyPreviewRepairTriggerBodySchema = z.object({
  dry_run: z.boolean().optional().default(false),
  requested_by: z.string().trim().min(1).max(128).optional(),
  thread_ids: z.array(z.string().trim().min(1)).max(500).optional(),
});

const LegacyPreviewRepairTriggerResponseSchema = z.object({
  success: z.boolean(),
  org_id: z.string(),
  workspace_id: z.string(),
  workflow_id: z.string(),
  dry_run: z.boolean(),
  status: z.literal("queued"),
});

// ---------------------------------------------------------------------------
// Cache-Control middleware for GET endpoints
// ---------------------------------------------------------------------------

routes.use("*", async (c, next) => {
  await next();
  if (
    c.req.method === "GET" &&
    c.res.status === 200 &&
    !c.res.headers.has("Cache-Control")
  ) {
    c.res.headers.set("Cache-Control", "private, max-age=30");
  }
});

// ---------------------------------------------------------------------------
// GET /stats
// ---------------------------------------------------------------------------

routes.get(
  "/stats",
  openApi({
    summary: "Aggregate counts",
    responses: {
      200: StatsResponseSchema,
    },
  }),
  async (c) => {
    const adminIndex = getAdminIndexStub(c.env);
    const overview = await adminIndex.getOverview();
    return c.json({
      total_users: overview.total_users,
      total_orgs: overview.total_orgs,
      total_memberships: overview.total_memberships,
      total_workspaces: overview.total_workspaces,
      total_integrations: overview.total_integrations,
      orphaned_users: overview.orphaned_users,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /orgs/:orgId/workspaces/:workspaceId/legacy-migration
// ---------------------------------------------------------------------------

routes.get(
  "/orgs/:orgId/workspaces/:workspaceId/legacy-migration",
  openApi({
    summary: "Get legacy workspace migration state",
    responses: {
      200: z.any(),
      503: ErrorSchema,
    },
  }),
  async (c) => {
    if (!c.env.WORKSPACE_FS) {
      return c.json({ error: "Workspace filesystem is not configured" }, 503);
    }

    const workspaceId = c.req.param("workspaceId");
    const workspaceFs = new WorkspaceFilesystemClient(c.env as never, workspaceId);
    return c.json(await workspaceFs.getLegacyWorkspaceMigrationState());
  },
);

routes.post(
  "/orgs/:orgId/workspaces/:workspaceId/legacy-migration",
  openApi({
    summary: "Queue legacy workspace migration",
    request: { json: LegacyWorkspaceMigrationTriggerBodySchema },
    responses: {
      200: LegacyWorkspaceMigrationTriggerResponseSchema,
      409: ErrorSchema,
      503: ErrorSchema,
    },
  }),
  async (c) => {
    if (!c.env.WORKSPACE_FS || !c.env.LEGACY_WORKSPACE_MIGRATIONS) {
      return c.json({ error: "Legacy workspace migration is not configured" }, 503);
    }

    const orgId = c.req.param("orgId");
    const workspaceId = c.req.param("workspaceId");
    const body = c.req.valid("json");
    const result = await queueLegacyWorkspaceMigrationIfNeeded({
      env: c.env,
      workspaceId,
      orgId,
      requestedBy: body.requested_by || "admin-api",
      dryRun: body.dry_run === true,
      force: body.force === true,
    });
    if (!result.queued) {
      return c.json({ error: `Migration is already ${result.state.status}; pass force to enqueue a rerun` }, 409);
    }

    return c.json({
      success: true,
      org_id: orgId,
      workspace_id: workspaceId,
      workflow_id: result.workflowId,
      dry_run: body.dry_run === true,
      status: "queued" as const,
    });
  },
);

routes.post(
  "/orgs/:orgId/workspaces/:workspaceId/legacy-migration/cancel",
  openApi({
    summary: "Cancel active legacy workspace migration",
    request: { json: LegacyWorkspaceMigrationCancelBodySchema },
    responses: {
      200: LegacyWorkspaceMigrationCancelResponseSchema,
      409: ErrorSchema,
      503: ErrorSchema,
    },
  }),
  async (c) => {
    if (!c.env.WORKSPACE_FS || !c.env.LEGACY_WORKSPACE_MIGRATIONS) {
      return c.json({ error: "Legacy workspace migration is not configured" }, 503);
    }

    const orgId = c.req.param("orgId");
    const workspaceId = c.req.param("workspaceId");
    const body = c.req.valid("json");
    const result = await cancelLegacyWorkspaceMigration({
      env: c.env,
      workspaceId,
      requestedBy: body.requested_by || "admin-api",
    });
    if (!result.canceled) {
      return c.json({ error: `Migration is not active; current status is ${result.state.status}` }, 409);
    }

    return c.json({
      success: true,
      org_id: orgId,
      workspace_id: workspaceId,
      workflow_id: result.workflowId,
      status: "canceled" as const,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /orgs/:orgId/workspaces/:workspaceId/legacy-preview-repair
// ---------------------------------------------------------------------------

routes.post(
  "/orgs/:orgId/workspaces/:workspaceId/legacy-preview-repair",
  openApi({
    summary: "Queue legacy thread preview repair",
    request: { json: LegacyPreviewRepairTriggerBodySchema },
    responses: {
      200: LegacyPreviewRepairTriggerResponseSchema,
      503: ErrorSchema,
    },
  }),
  async (c) => {
    if (!c.env.LEGACY_PREVIEW_REPAIRS) {
      return c.json({ error: "Legacy preview repair workflow is not configured" }, 503);
    }

    const orgId = c.req.param("orgId");
    const workspaceId = c.req.param("workspaceId");
    const body = c.req.valid("json");
    const workflowId = [
      "legacy-preview-repair",
      workspaceId,
      Date.now().toString(36),
    ].join("-");

    await c.env.LEGACY_PREVIEW_REPAIRS.createBatch([{
      id: workflowId,
      params: {
        orgId,
        workspaceId,
        requestedBy: body.requested_by || "admin-api",
        dryRun: body.dry_run === true,
        threadIds: body.thread_ids,
      },
    }]);

    return c.json({
      success: true,
      org_id: orgId,
      workspace_id: workspaceId,
      workflow_id: workflowId,
      dry_run: body.dry_run === true,
      status: "queued" as const,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /users
// ---------------------------------------------------------------------------

routes.get(
  "/users",
  openApi({
    summary: "List users (paginated)",
    request: {
      query: UsersQuerySchema,
    },
    responses: {
      200: paginatedList(UserSummarySchema),
    },
  }),
  async (c) => {
    const {
      limit,
      offset,
      search,
      is_superuser,
      is_orphaned,
      sort_by,
      sort_dir,
    } = c.req.valid("query");
    const adminIndex = getAdminIndexStub(c.env);
    const filters: UserFilters = { sort_by, sort_dir };
    if (is_superuser !== undefined) filters.is_superuser = is_superuser;
    if (is_orphaned !== undefined) filters.is_orphaned = is_orphaned;

    const result = await adminIndex.getUsersPaginated(
      offset,
      limit,
      search,
      filters,
    );
    return c.json(result);
  },
);

// ---------------------------------------------------------------------------
// GET /users/:id/orgs
// ---------------------------------------------------------------------------

routes.get(
  "/users/:id/orgs",
  openApi({
    summary: "User's org memberships",
    responses: {
      200: dataList(OrgMembershipSchema),
    },
  }),
  async (c) => {
    const userId = c.req.param("id");
    const userStub = getUserStub(c.env, userId);
    const orgs = await userStub.getOrgs();
    return c.json({ data: orgs });
  },
);

// ---------------------------------------------------------------------------
// PUT /users/:id/credits
// ---------------------------------------------------------------------------

routes.put(
  "/users/:id/credits",
  openApi({
    summary: "Arbitrarily set credits for one user's organization",
    request: {
      json: UpdateUserCreditsBodySchema,
    },
    responses: {
      200: UserCreditsResponseSchema,
      400: ErrorSchema,
      404: ErrorSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const userId = c.req.param("id");
    const body = c.req.valid("json");
    const hasAvailableOverride = body.available_credits_cents !== undefined;
    const hasPurchaseOverride =
      body.billing_credit_purchase_total_cents !== undefined;
    const hasGrantOverride =
      body.billing_credit_grant_total_cents !== undefined;
    const hasUsageStartOverride =
      body.billing_credit_usage_started_at !== undefined;

    if (
      !hasAvailableOverride &&
      !hasPurchaseOverride &&
      !hasGrantOverride &&
      !hasUsageStartOverride
    ) {
      return c.json(
        {
          error:
            "At least one credit field is required: available_credits_cents, billing_credit_purchase_total_cents, billing_credit_grant_total_cents, or billing_credit_usage_started_at",
        },
        400,
      );
    }

    const userStub = getUserStub(c.env, userId);
    const profile = await userStub.getProfile();
    if (!profile) {
      return c.json({ error: "User not found" }, 404);
    }

    const memberships = await userStub.getOrgs();
    const targetOrgId =
      body.org_id?.trim() ||
      (memberships.length === 1 ? memberships[0]?.org_id : null);
    if (!targetOrgId) {
      return c.json(
        {
          error:
            "org_id is required when the user belongs to zero or multiple organizations",
        },
        400,
      );
    }
    if (!memberships.some((membership) => membership.org_id === targetOrgId)) {
      return c.json(
        { error: "User is not a member of the target organization" },
        400,
      );
    }

    const orgStub = getOrgStub(c.env, targetOrgId);
    const orgInfo = await orgStub.getInfo();
    if (!orgInfo) {
      return c.json({ error: "Organization not found" }, 404);
    }

    let chargeableUsageCents: number;
    try {
      chargeableUsageCents = await fetchChargeableUsageCents(
        c.env,
        targetOrgId,
      );
    } catch (error) {
      console.error('[admin] failed to load spam summary', error);
      return c.json(
        {
          error:
            error instanceof Error
              ? `Failed to load chargeable usage: ${error.message}`
              : "Failed to load chargeable usage",
        },
        502,
      );
    }

    const previousPurchase = orgInfo.billing_credit_purchase_total_cents ?? 0;
    const previousGrant = orgInfo.billing_credit_grant_total_cents ?? 0;
    const previousTotal = previousPurchase + previousGrant;
    const previousAvailable = Math.max(
      0,
      previousTotal - chargeableUsageCents,
    );

    const nextPurchase = hasPurchaseOverride
      ? body.billing_credit_purchase_total_cents!
      : previousPurchase;
    let nextGrant = hasGrantOverride
      ? body.billing_credit_grant_total_cents!
      : previousGrant;

    if (hasAvailableOverride) {
      // Preserve purchased-credit accounting and apply the balance correction
      // through grants so available credits match after chargeable usage.
      nextGrant =
        body.available_credits_cents! + chargeableUsageCents - nextPurchase;
    }

    const nextOrg = await orgStub.updateBillingState({
      billing_credit_purchase_total_cents: nextPurchase,
      billing_credit_grant_total_cents: nextGrant,
      ...(hasUsageStartOverride
        ? {
            billing_credit_usage_started_at:
              body.billing_credit_usage_started_at ?? null,
          }
        : {}),
    });
    if (!nextOrg) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const totalCreditLimitCents =
      (nextOrg.billing_credit_purchase_total_cents ?? 0) +
      (nextOrg.billing_credit_grant_total_cents ?? 0);
    return c.json({
      user_id: userId,
      org_id: targetOrgId,
      chargeable_usage_cents: chargeableUsageCents,
      available_credits_cents: Math.max(
        0,
        totalCreditLimitCents - chargeableUsageCents,
      ),
      total_credit_limit_cents: totalCreditLimitCents,
      billing_credit_purchase_total_cents:
        nextOrg.billing_credit_purchase_total_cents ?? 0,
      billing_credit_grant_total_cents:
        nextOrg.billing_credit_grant_total_cents ?? 0,
      billing_credit_usage_started_at:
        nextOrg.billing_credit_usage_started_at ?? null,
      previous: {
        available_credits_cents: previousAvailable,
        total_credit_limit_cents: previousTotal,
        billing_credit_purchase_total_cents: previousPurchase,
        billing_credit_grant_total_cents: previousGrant,
        billing_credit_usage_started_at:
          orgInfo.billing_credit_usage_started_at ?? null,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// GET /spam/org-ids
// ---------------------------------------------------------------------------

routes.get(
  "/spam/org-ids",
  openApi({
    summary: "List spam org IDs from effective spend limits",
    responses: {
      200: SpamOrgIdsResponseSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    try {
      const orgIds = await fetchSpamOrgIds(c.env);
      return c.json({ org_ids: orgIds, count: orgIds.length });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load spam org IDs",
        },
        502,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// GET /bans
// ---------------------------------------------------------------------------

routes.get(
  "/bans",
  openApi({
    summary: "List active bans",
    request: { query: BansQuerySchema },
    responses: {
      200: z.object({
        data: z.array(BanRecordSchema),
        cursor: z.string().optional(),
      }),
    },
  }),
  async (c) => {
    const query = c.req.valid("query");
    const result = await listBanRecords(c.env.APP_KV, query);
    return c.json({ data: result.records, cursor: result.cursor });
  },
);

routes.get(
  "/bans/:scope/:id",
  openApi({
    summary: "Get ban by scope + target id",
    responses: {
      200: BanRecordSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const scope = c.req.param("scope");
    const targetId = c.req.param("id");
    const record =
      scope === "user"
        ? await getUserBanById(c.env.APP_KV, targetId)
        : scope === "org"
          ? await getOrgBanById(c.env.APP_KV, targetId)
          : null;

    if (!record) {
      return c.json({ error: "Ban not found" }, 404);
    }
    return c.json(record);
  },
);

routes.post(
  "/users/:id/ban",
  openApi({
    summary: "Ban user and purge data",
    request: { json: CreateBanBodySchema },
    responses: {
      200: BanStartResponseSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const userId = c.req.param("id");
    const body = c.req.valid("json");
    try {
      const job = await startAdminUserBanAndPurgeWithEnv(
        c.env as never,
        userId,
        {
          reason: body.reason,
          actorId: "admin-api",
        },
      );
      waitUntil(
        runAdminUserBanAndPurgeWithEnv(c.env as never, job, "admin-api").catch(
          (error) => {
            console.error("[admin-api] user ban purge failed", {
              userId,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        ),
      );
      return c.json({
        ok: true,
        scope: "user",
        target_id: userId,
        ban_status: "active",
        purge_status: "pending",
        job_id: job.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        { error: message },
        message === "User not found" ? 404 : 400,
      );
    }
  },
);

routes.post(
  "/orgs/:id/ban",
  openApi({
    summary: "Ban org and purge data",
    request: { json: CreateBanBodySchema },
    responses: {
      200: BanStartResponseSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param("id");
    const body = c.req.valid("json");
    try {
      const job = await startAdminOrgBanAndPurgeWithEnv(c.env as never, orgId, {
        reason: body.reason,
        actorId: "admin-api",
      });
      waitUntil(
        runAdminOrgBanAndPurgeWithEnv(c.env as never, job, "admin-api").catch(
          (error) => {
            console.error("[admin-api] org ban purge failed", {
              orgId,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        ),
      );
      return c.json({
        ok: true,
        scope: "org",
        target_id: orgId,
        ban_status: "active",
        purge_status: "pending",
        job_id: job.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        { error: message },
        message === "Organization not found" ? 404 : 400,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// GET /orgs
// ---------------------------------------------------------------------------

routes.get(
  "/orgs",
  openApi({
    summary: "List orgs (paginated)",
    request: {
      query: OrgsQuerySchema,
    },
    responses: {
      200: paginatedList(AdminOrgListItemSchema),
      502: ErrorSchema,
    },
  }),
  async (c) => {
    try {
      const {
        limit,
        offset,
        search,
        archived,
        exclude_spam,
        exclude_internal_domains,
        include_usage,
        include_spend_30d,
        include_llm_provider,
        sort_by,
        sort_dir,
      } = c.req.valid("query");
      const adminIndex = getAdminIndexStub(
        c.env,
      ) as unknown as AdminOrgDirectoryLookup;
      const internalDomains = exclude_internal_domains
        ? Array.from(normalizeInternalDomains(exclude_internal_domains))
        : [];
      // /orgs is an additive admin list endpoint, so internal-domain filtering
      // stays opt-in here instead of defaulting to camelai.com.
      const spamOrgIds = exclude_spam ? await fetchSpamOrgIds(c.env) : [];
      const result = await adminIndex.getOrgDirectoryPaginated(
        offset,
        limit,
        search,
        {
          archived,
          sort_by,
          sort_dir,
          exclude_creator_domains: internalDomains,
          exclude_org_ids: spamOrgIds,
        },
      );
      const pagedOrgs = result.items;
      const needsUsage = include_usage === true || include_spend_30d === true;
      const usageByOrgId = needsUsage
        ? await fetchOrgUsageAnalytics(
            c.env,
            pagedOrgs.map((org) => org.id),
            { includeWindows: include_usage === true },
          )
        : new Map<string, OrgUsageAnalyticsItem>();
      const llmProviderByOrgId =
        include_llm_provider === true
          ? await getAdminOrgLlmProviderMap(
              c.env,
              pagedOrgs.map((org) => org.id),
            )
          : undefined;

      return c.json({
        items: enrichOrgListItems(pagedOrgs, usageByOrgId, {
          includeUsage: include_usage === true,
          includeSpend30d: include_spend_30d === true,
          llmProviderByOrgId,
        }),
        total: result.total,
        offset: result.offset,
        limit: result.limit,
      });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load organizations",
        },
        502,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/llm-providers
// ---------------------------------------------------------------------------

routes.get(
  "/orgs/llm-providers",
  openApi({
    summary: "List orgs with bring-your-own-key LLM providers configured",
    request: {
      query: OrgLlmProvidersQuerySchema,
    },
    responses: {
      200: paginatedList(AdminOrgLlmProviderListItemSchema),
      502: ErrorSchema,
    },
  }),
  async (c) => {
    try {
      const { limit, offset, search, provider } = c.req.valid("query");
      const adminIndex = getAdminIndexStub(
        c.env,
      ) as unknown as AdminOrgDirectoryLookup;
      const result = await adminIndex.getOrgLlmProviderDirectoryPaginated(
        offset,
        limit,
        search,
        provider,
      );
      const orgs = result.items;
      const providerByOrgId = await getAdminOrgLlmProviderMap(
        c.env,
        orgs.map((org) => org.id),
      );
      const configuredOrgs = orgs
        .map((org) => ({ org, llmProvider: providerByOrgId.get(org.id) }))
        .filter(
          (
            row,
          ): row is {
            org: AdminOrgDirectoryRow;
            llmProvider: NonNullable<
              Awaited<ReturnType<typeof getAdminOrgLlmProvider>>
            >;
          } =>
            Boolean(row.llmProvider) &&
            (!provider || row.llmProvider?.provider === provider),
        );

      return c.json({
        items: configuredOrgs.map(({ org, llmProvider }) => ({
          id: org.id,
          name: org.name,
          slug: org.slug ?? null,
          created_by: org.created_by,
          created_at: org.created_at,
          archived: org.archived,
          billing_status: org.billing_status ?? null,
          member_count: org.member_count,
          workspace_count: org.workspace_count,
          has_llm_provider: true,
          llm_provider: llmProvider,
        })),
        total: result.total,
        offset: result.offset,
        limit: result.limit,
      });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load BYOK organizations",
        },
        502,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/:id
// ---------------------------------------------------------------------------

routes.get(
  "/orgs/:id",
  openApi({
    summary: "Org detail with recent activity",
    responses: {
      200: OrgDetailSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param("id");
    const adminIndex = getAdminIndexStub(c.env);

    // Get org metadata, including member_count and workspace_count, from D1.
    const orgInfo = await adminIndex.getOrgById(orgId);
    if (!orgInfo) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const [activity, llmProvider] = await Promise.all([
      adminIndex.getOrgRecentActivity(orgId),
      getAdminOrgLlmProvider(c.env, orgId),
    ]);

    return c.json({
      id: orgInfo.id,
      name: orgInfo.name,
      slug: orgInfo.slug ?? null,
      created_by: orgInfo.created_by,
      created_at: orgInfo.created_at,
      archived: orgInfo.archived,
      member_count: orgInfo.member_count ?? 0,
      workspace_count: orgInfo.workspace_count ?? 0,
      has_llm_provider: Boolean(llmProvider),
      llm_provider: llmProvider,
      threads: activity.threads.map(normalizeAdminThreadResponse),
      apps: activity.apps,
      threadCount: activity.threadCount,
      appCount: activity.appCount,
    });
  },
);

// ---------------------------------------------------------------------------
// PUT /orgs/:id/model-access
// ---------------------------------------------------------------------------

routes.put(
  "/orgs/:id/model-access",
  openApi({
    summary: "Update org model access",
    request: {
      json: UpdateOrgModelAccessBodySchema,
    },
    responses: {
      200: OrgModelAccessSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param("id");
    const body = c.req.valid("json");
    const orgStub = getOrgStub(c.env, orgId);
    const orgInfo = await orgStub.getInfo();
    if (!orgInfo) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const settings = await orgStub.setExperimentalSettings({
      claude_proxy_models: body.claude_proxy_models,
    });

    return c.json({
      org_id: orgId,
      claude_proxy_models: settings.claude_proxy_models,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /orgs/:id/credits
// ---------------------------------------------------------------------------

routes.post(
  "/orgs/:id/credits",
  openApi({
    summary: "Grant org credits manually",
    request: {
      json: GrantOrgCreditsBodySchema,
    },
    responses: {
      200: GrantOrgCreditsResponseSchema,
      400: ErrorSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param("id");
    const body = c.req.valid("json");
    const orgStub = getOrgStub(c.env, orgId);
    const orgInfo = await orgStub.getInfo();
    if (!orgInfo) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const idempotencyKey =
      body.idempotency_key ?? c.req.header("Idempotency-Key") ?? null;
    const result = await orgStub.applyManualCreditGrant(
      body.amount_cents,
      body.reason ?? null,
      idempotencyKey,
      { source: "admin-api" },
    );
    if (!result) {
      return c.json({ error: "Credit grant amount must be positive" }, 400);
    }

    return c.json({
      org_id: orgId,
      applied: result.applied,
      grant_id: result.grantId,
      amount_cents: result.amountCents,
      reason: result.reason,
      created_at: result.createdAt,
      created_by: result.createdBy,
      source: result.source,
      billing_credit_grant_total_cents:
        result.org.billing_credit_grant_total_cents ?? 0,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /orgs/:id/custom-domain/refresh
// ---------------------------------------------------------------------------

routes.post(
  "/orgs/:id/custom-domain/refresh",
  openApi({
    summary:
      "Refresh Cloudflare custom hostname validation for an org custom domain",
    request: {
      json: RefreshOrgCustomDomainBodySchema,
    },
    responses: {
      200: RefreshOrgCustomDomainResponseSchema,
      404: ErrorSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param("id");
    const body = c.req.valid("json");

    try {
      const result = await refreshOrgCustomDomainHostnamesForAdmin(
        c.env,
        orgId,
        {
          includeActive: body.include_active,
        },
      );
      if (!result) {
        return c.json({ error: "Organization not found" }, 404);
      }
      return c.json(result);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to refresh custom domain hostnames",
        },
        502,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// POST /orgs/:id/members
// ---------------------------------------------------------------------------

routes.post(
  "/orgs/:id/members",
  openApi({
    summary: "Add member to org",
    request: { json: AddMemberBodySchema },
    responses: {
      201: AddMemberResponseSchema,
      400: ErrorSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const env = c.env;
    const orgId = c.req.param("id");
    const body = c.req.valid("json");

    const orgStub = getOrgStub(env, orgId);
    const orgInfo = await orgStub.getInfo();
    if (!orgInfo) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const userStub = getUserStub(env, body.user_id);
    const profile = await userStub.getProfile();
    if (!profile) {
      return c.json({ error: "User not found" }, 404);
    }

    await orgStub.addMember(body.user_id, body.role, "admin-api");
    await userStub.addOrg(orgId, body.role, null);

    return c.json(
      { org_id: orgId, user_id: body.user_id, role: body.role },
      201,
    );
  },
);

// ---------------------------------------------------------------------------
// PUT /signup-blocked-ips/:ip
// ---------------------------------------------------------------------------

routes.put(
  "/signup-blocked-ips/:ip",
  openApi({
    summary: "Block signup attempts from an IP address",
    request: {
      json: BlockSignupIpBodySchema,
    },
    responses: {
      200: BlockedSignupIpSchema,
      400: ErrorSchema,
    },
  }),
  async (c) => {
    const rawIp = decodeURIComponent(c.req.param("ip"));
    const normalizedIp = rawIp.trim().toLowerCase();
    if (!normalizedIp) {
      return c.json({ error: "IP required" }, 400);
    }

    const body = c.req.valid("json");
    const blockedBy = body.blocked_by?.trim() || null;
    const reason = body.reason?.trim() || null;
    const blockedAt = Date.now();
    const adminIndex = getAdminIndexStub(c.env);

    await adminIndex.blockSignupIp(normalizedIp, blockedBy, reason);

    return c.json({
      ip: normalizedIp,
      blocked: true,
      blocked_at: blockedAt,
      blocked_by: blockedBy,
      reason,
    });
  },
);

// ---------------------------------------------------------------------------
// DELETE /signup-blocked-ips/:ip
// ---------------------------------------------------------------------------

routes.delete(
  "/signup-blocked-ips/:ip",
  openApi({
    summary: "Remove an IP address from the signup blocklist",
    responses: {
      200: BlockedSignupIpSchema,
      400: ErrorSchema,
    },
  }),
  async (c) => {
    const rawIp = decodeURIComponent(c.req.param("ip"));
    const normalizedIp = rawIp.trim().toLowerCase();
    if (!normalizedIp) {
      return c.json({ error: "IP required" }, 400);
    }

    const adminIndex = getAdminIndexStub(c.env);
    await adminIndex.unblockSignupIp(normalizedIp);

    return c.json({
      ip: normalizedIp,
      blocked: false,
      blocked_at: null,
      blocked_by: null,
      reason: null,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /threads
// ---------------------------------------------------------------------------

routes.get(
  "/threads",
  openApi({
    summary: "List threads (paginated)",
    request: {
      query: ThreadsQuerySchema,
    },
    responses: {
      200: paginatedList(ThreadSchema),
    },
  }),
  async (c) => {
    const {
      limit,
      offset,
      search,
      org_id,
      workspace_id,
      created_by,
      sort_by,
      sort_dir,
    } = c.req.valid("query");
    const adminIndex = getAdminIndexStub(c.env);
    const filters: ThreadFilters = { sort_by, sort_dir };
    if (org_id) filters.org_id = org_id;
    if (workspace_id) filters.workspace_id = workspace_id;
    if (created_by) filters.created_by = created_by;

    const result = await adminIndex.getThreadsPaginated(
      offset,
      limit,
      search,
      filters,
    );
    return c.json(normalizeAdminThreadPage(result));
  },
);

// ---------------------------------------------------------------------------
// GET /threads/:id/messages
// ---------------------------------------------------------------------------

routes.get(
  "/threads/:id/messages",
  openApi({
    summary: "Get parsed thread messages",
    responses: {
      200: ThreadMessagesResponseSchema,
      400: ErrorSchema,
      404: ErrorSchema,
      500: ErrorSchema,
    },
  }),
  async (c) => {
    return loadAdminThreadMessagesResponse(c.env, c.req.param("id"));
  },
);

// ---------------------------------------------------------------------------
// PATCH /threads/:id
// ---------------------------------------------------------------------------

routes.patch(
  "/threads/:id",
  openApi({
    summary: "Update thread title, model, or creator",
    request: {
      json: UpdateThreadBodySchema,
    },
    responses: {
      200: ThreadSchema,
      400: ErrorSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const env = c.env;
    const threadId = c.req.param("id");
    const body = c.req.valid("json");

    if (!body.title && !body.created_by && !body.model) {
      return c.json(
        { error: "At least one of title, created_by, or model is required" },
        400,
      );
    }

    // Try the D1 index first (fast single-SQL lookup).
    const adminIndex = getAdminIndexStub(env);
    const threadContext = await adminIndex.getThreadContextById(threadId);

    if (threadContext) {
      const orgStub = getOrgStub(env, threadContext.org_id);
      const existingThread = await orgStub.getThread(threadId);
      const existingModel = existingThread
        ? normalizeLlmModel(existingThread.model)
        : null;
      if (body.model && existingModel && body.model !== existingModel) {
        return c.json({ error: THREAD_MODEL_LOCK_MESSAGE }, 400);
      }
      let result;
      try {
        result = await orgStub.adminUpdateThread(threadId, body, "admin-api");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === THREAD_MODEL_LOCK_MESSAGE) {
          return c.json({ error: message }, 400);
        }
        throw error;
      }
      if (result) {
        await notifyThreadMetadataChange(env, threadId, body, result.updated_at);
        return c.json(normalizeAdminThreadResponse(result));
      }
    }

    // Fallback: index may be stale, so scan indexed orgs.
    const orgsResult = await adminIndex.getOrgsPaginated(0, 1000);
    for (const org of orgsResult.items) {
      const orgStub = getOrgStub(env, org.id);
      const existingThread = await orgStub.getThread(threadId);
      const existingModel = existingThread
        ? normalizeLlmModel(existingThread.model)
        : null;
      if (body.model && existingModel && body.model !== existingModel) {
        return c.json({ error: THREAD_MODEL_LOCK_MESSAGE }, 400);
      }
      let result;
      try {
        result = await orgStub.adminUpdateThread(threadId, body, "admin-api");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === THREAD_MODEL_LOCK_MESSAGE) {
          return c.json({ error: message }, 400);
        }
        throw error;
      }
      if (result) {
        await notifyThreadMetadataChange(env, threadId, body, result.updated_at);
        return c.json(normalizeAdminThreadResponse(result));
      }
    }

    return c.json({ error: "Thread not found" }, 404);
  },
);

// ---------------------------------------------------------------------------
// GET /workspaces
// ---------------------------------------------------------------------------

routes.get(
  "/workspaces",
  openApi({
    summary: "List workspaces (paginated)",
    request: {
      query: WorkspacesQuerySchema,
    },
    responses: {
      200: paginatedList(WorkspaceSchema),
    },
  }),
  async (c) => {
    const { limit, offset, search, org_id, archived, sort_by, sort_dir } =
      c.req.valid("query");
    const adminIndex = getAdminIndexStub(c.env);
    const filters: WorkspaceFilters = { sort_by, sort_dir };
    if (org_id) filters.org_id = org_id;
    if (archived !== undefined) filters.archived = archived;

    const result = await adminIndex.getWorkspacesPaginated(
      offset,
      limit,
      search,
      filters,
    );
    return c.json(result);
  },
);

// ---------------------------------------------------------------------------
// GET /apps
// ---------------------------------------------------------------------------

routes.get(
  "/apps",
  openApi({
    summary: "List apps (paginated)",
    request: {
      query: AppsQuerySchema,
    },
    responses: {
      200: paginatedList(AppSchema),
    },
  }),
  async (c) => {
    const {
      limit,
      offset,
      search,
      org_id,
      workspace_id,
      is_public,
      sort_by,
      sort_dir,
    } = c.req.valid("query");
    const adminIndex = getAdminIndexStub(c.env);
    const filters: AppFilters = { sort_by, sort_dir };
    if (org_id) filters.org_id = org_id;
    if (workspace_id) filters.workspace_id = workspace_id;
    if (is_public !== undefined) filters.is_public = is_public;

    const result = await adminIndex.getAppsPaginated(
      offset,
      limit,
      search,
      filters,
    );
    return c.json(result);
  },
);

// ---------------------------------------------------------------------------
// GET /dashboard/top-orgs
// ---------------------------------------------------------------------------

routes.get(
  "/dashboard/top-orgs",
  openApi({
    summary: "Top orgs ranked by spend or member count",
    request: {
      query: DashboardTopOrgsQuerySchema,
    },
    responses: {
      200: DashboardTopOrgsResponseSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    try {
      const { limit, exclude_spam, exclude_internal_domains, sort_by } =
        c.req.valid("query");

      const adminIndex = getAdminIndexStub(
        c.env,
      ) as unknown as AdminOrgDirectoryLookup;
      let orgs = await adminIndex.getOrgDirectoryRows();
      const internalDomains = normalizeInternalDomains(
        exclude_internal_domains,
        ["camelai.com"],
      );
      orgs = orgs.filter(
        (org) => !isOrgExcludedByInternalDomains(org, internalDomains),
      );

      if (exclude_spam !== false) {
        const spamOrgIds = new Set(await fetchSpamOrgIds(c.env));
        orgs = orgs.filter((org) => !spamOrgIds.has(org.id));
      }

      // Top-org ranking depends on member_count being current. The org directory
      // row can be present before membership deltas finish indexing, so force the
      // membership snapshot to catch up before we sort or return counts.
      await adminIndex.getUsersByOrgIds(orgs.map((org) => org.id));

      // Two-pass: rank without windows first, then fetch windows for top-N only.
      const rankingUsage = await fetchOrgUsageAnalytics(
        c.env,
        orgs.map((org) => org.id),
        { includeWindows: false },
      );

      const ranked = orgs
        .map((org) => ({ org, usage: rankingUsage.get(org.id) }))
        .sort((left, right) => {
          if (sort_by === "member_count") {
            if (right.org.member_count !== left.org.member_count) {
              return right.org.member_count - left.org.member_count;
            }
            const leftSpend = left.usage?.spend_30d ?? 0;
            const rightSpend = right.usage?.spend_30d ?? 0;
            if (rightSpend !== leftSpend) {
              return rightSpend - leftSpend;
            }
            return left.org.id.localeCompare(right.org.id);
          }

          const leftSpend =
            sort_by === "spend_30d"
              ? (left.usage?.spend_30d ?? 0)
              : (left.usage?.spend_7d ?? 0);
          const rightSpend =
            sort_by === "spend_30d"
              ? (right.usage?.spend_30d ?? 0)
              : (right.usage?.spend_7d ?? 0);
          if (rightSpend !== leftSpend) {
            return rightSpend - leftSpend;
          }
          if (right.org.member_count !== left.org.member_count) {
            return right.org.member_count - left.org.member_count;
          }
          return left.org.id.localeCompare(right.org.id);
        })
        .slice(0, limit);

      const topOrgIds = ranked.map(({ org }) => org.id);
      const windowUsage =
        topOrgIds.length > 0
          ? await fetchOrgUsageAnalytics(c.env, topOrgIds, {
              includeWindows: true,
            })
          : new Map<string, OrgUsageAnalyticsItem>();

      const items = ranked.map(({ org }) =>
        toDashboardTopOrgItem(org, windowUsage.get(org.id)),
      );

      return c.json({
        items,
        count: items.length,
        limit,
        sort_by,
      });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to load top orgs",
        },
        502,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// GET /dashboard/daily-spend
// ---------------------------------------------------------------------------

routes.get(
  "/dashboard/daily-spend",
  openApi({
    summary: "Cross-org daily spend dashboard metrics",
    request: {
      query: DashboardDailySpendQuerySchema,
    },
    responses: {
      200: DashboardDailySpendResponseSchema,
      400: ErrorSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const { date, top_orgs_limit } = c.req.valid("query");
    const selectedDate = date ?? new Date().toISOString().slice(0, 10);
    if (parseDateOnlyUtc(selectedDate) === null) {
      return c.json({ error: "Invalid date. Expected YYYY-MM-DD." }, 400);
    }

    try {
      const adminIndex = getAdminIndexStub(
        c.env,
      ) as unknown as AdminOrgDirectoryLookup;
      const includedOrgs = await adminIndex.getOrgDirectoryRows();
      const orgById = new Map(includedOrgs.map((org) => [org.id, org]));

      const dailySpend = await fetchDailySpendAnalytics(c.env, {
        date: selectedDate,
        topOrgsLimit: top_orgs_limit,
        orgIds: includedOrgs.map((org) => org.id),
      });

      const response: DailySpendDashboardResponse = {
        ...dailySpend,
        model_breakdown: dailySpend.model_breakdown.map((item) => ({
          ...item,
          pct_of_total: toDailySpendPct(
            item.spend_usd,
            dailySpend.total_spend_usd,
          ),
        })),
        top_orgs: dailySpend.top_orgs.map((item) => {
          const org = orgById.get(item.org_id);
          return {
            org_id: item.org_id,
            org_name: org?.name ?? item.org_id,
            org_slug: org?.slug ?? null,
            spend_usd: item.spend_usd,
            requests: item.requests,
            is_spam: item.is_spam,
            billing_plan: toDailySpendBillingPlan(org?.billing_status),
          };
        }),
      };

      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load daily spend metrics",
        },
        502,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// GET /dashboard/summary
// ---------------------------------------------------------------------------

routes.get(
  "/dashboard/summary",
  openApi({
    summary: "Dashboard summary",
    request: {
      query: DashboardSummaryQuerySchema,
    },
    responses: {
      200: DashboardSummaryResponseSchema,
      400: ErrorSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const { date, exclude_spam, exclude_internal_domains } =
      c.req.valid("query");
    const selectedDate = date ?? new Date().toISOString().slice(0, 10);
    if (parseDateOnlyUtc(selectedDate) === null) {
      return c.json({ error: "Invalid date. Expected YYYY-MM-DD." }, 400);
    }

    try {
      const adminIndex = getAdminIndexStub(
        c.env,
      ) as unknown as DashboardMetricsLookup;
      const spamOrgIds =
        exclude_spam !== false ? await fetchSpamOrgIds(c.env) : [];
      const internalDomains = Array.from(
        normalizeInternalDomains(exclude_internal_domains, ["camelai.com"]),
      );

      const summary = await adminIndex.computeDashboardSummary({
        selectedDate,
        spamOrgIds,
        internalDomains,
      });
      return c.json(normalizeAdminDashboardSummary(summary));
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load dashboard summary",
        },
        502,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// GET /dashboard/retention
// ---------------------------------------------------------------------------

routes.get(
  "/dashboard/retention",
  openApi({
    summary: "Dashboard retention",
    request: {
      query: DashboardRetentionQuerySchema,
    },
    responses: {
      200: DashboardRetentionResponseSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const { exclude_spam, exclude_internal_domains } = c.req.valid("query");

    try {
      const adminIndex = getAdminIndexStub(
        c.env,
      ) as unknown as DashboardMetricsLookup;
      const spamOrgIds =
        exclude_spam !== false ? await fetchSpamOrgIds(c.env) : [];
      const internalDomains = Array.from(
        normalizeInternalDomains(exclude_internal_domains, ["camelai.com"]),
      );

      const retention = await adminIndex.computeRetentionData({
        spamOrgIds,
        internalDomains,
      });
      return c.json(retention);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load dashboard retention",
        },
        502,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// GET /dashboard/spam-summary
// ---------------------------------------------------------------------------

routes.get(
  "/dashboard/spam-summary",
  openApi({
    summary: "Dashboard spam summary for spam-flagged orgs",
    responses: {
      200: DashboardSpamSummaryResponseSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    try {
      const adminIndex = getAdminIndexStub(
        c.env,
      ) as unknown as AdminOrgDirectoryLookup;
      const spamOrgIds = await fetchSpamOrgIds(c.env);

      let [users, threads, apps, orgs, usageByOrgId] = await Promise.all([
        adminIndex.getUsersByOrgIds(spamOrgIds),
        adminIndex.getThreadsByOrgIds(spamOrgIds),
        adminIndex.getAppsByOrgIds(spamOrgIds),
        adminIndex.getOrgDirectoryByIds(spamOrgIds),
        fetchOrgUsageAnalytics(c.env, spamOrgIds, { includeWindows: true }),
      ]);
      if (users.length === 0 && spamOrgIds.length > 0) {
        const memberRows = await Promise.all(
          spamOrgIds.map(async (orgId) => {
            try {
              return await getOrgStub(c.env, orgId).getMembers();
            } catch {
              return [];
            }
          }),
        );
        users = Array.from(
          new Map(
            (await Promise.all(
              memberRows
                .flat()
                .map(async (member: any) => {
                  const profile = await getUserStub(c.env, member.user_id).getProfile().catch(() => null);
                  if (!profile) return null;
                  return [
                    profile.id,
                    {
                      ...profile,
                      org_count: 1,
                      signup_ip: null,
                    },
                  ] as const;
                }),
            )).filter((entry): entry is readonly [string, any] => entry !== null),
          ).values(),
        );
      }

      const org_usage = orgs
        .map((org) => toDashboardTopOrgItem(org, usageByOrgId.get(org.id)))
        .sort((left, right) => {
          if (right.spend_30d !== left.spend_30d) {
            return right.spend_30d - left.spend_30d;
          }
          if (right.created_at !== left.created_at) {
            return right.created_at - left.created_at;
          }
          return left.org_id.localeCompare(right.org_id);
        });

      return c.json({
        // The spam tab is investigative: include any user attached to a spam
        // org, even if that user also belongs to non-spam orgs elsewhere.
        users,
        threads: threads.map(normalizeAdminThreadResponse),
        apps,
        orgs: orgs.map((org) => ({
          id: org.id,
          name: org.name,
          slug: org.slug ?? null,
          created_by: org.created_by,
          created_at: org.created_at,
          archived: org.archived,
          billing_status: normalizeBillingStatus(org.billing_status),
          member_count: org.member_count,
          workspace_count: org.workspace_count,
        })),
        org_usage,
      });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load spam summary",
        },
        502,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// GET /kv
// ---------------------------------------------------------------------------

routes.get(
  "/kv",
  openApi({
    summary: "List KV keys",
    request: {
      query: z.object({ prefix: z.string().optional() }),
    },
    responses: {
      200: dataList(KvEntrySchema),
    },
  }),
  async (c) => {
    const env = c.env;
    const { prefix } = c.req.valid("query");
    const keys: Array<{ name: string; metadata?: unknown }> = [];
    let cursor: string | undefined;

    while (true) {
      const list = await env.EMAIL_TO_USER.list({ prefix, cursor });
      for (const key of list.keys) {
        keys.push({ name: key.name, metadata: key.metadata });
      }
      if (list.list_complete) break;
      cursor = list.cursor;
    }

    return c.json({ data: keys });
  },
);

// ---------------------------------------------------------------------------
// GET /kv/:key
// ---------------------------------------------------------------------------

routes.get(
  "/kv/:key",
  openApi({
    summary: "Get KV value by key",
    responses: {
      200: KvValueSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const key = c.req.param("key");
    const value = await c.env.EMAIL_TO_USER.get(key);

    if (value === null) {
      return c.json({ error: "Key not found" }, 404);
    }

    try {
      const parsed = JSON.parse(value);
      return c.json({ key, value: parsed, type: "json" as const });
    } catch {
      return c.json({ key, value, type: "string" as const });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /r2
// ---------------------------------------------------------------------------

routes.get(
  "/r2",
  openApi({
    summary: "List R2 objects",
    request: {
      query: z.object({ prefix: z.string().optional() }),
    },
    responses: {
      200: dataList(R2ObjectSummarySchema),
    },
  }),
  async (c) => {
    const env = c.env;
    const { prefix } = c.req.valid("query");
    const objects: Array<{
      key: string;
      size: number;
      lastModified: string;
      etag: string;
    }> = [];
    let cursor: string | undefined;

    while (true) {
      const list = await env.R2_BUCKET.list({ prefix, cursor, limit: 1000 });
      for (const obj of list.objects) {
        objects.push({
          key: obj.key,
          size: obj.size,
          lastModified: obj.uploaded.toISOString(),
          etag: obj.etag,
        });
      }
      if (!list.truncated) break;
      cursor = list.cursor;
    }

    return c.json({ data: objects });
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/:id/usage/spend
// ---------------------------------------------------------------------------

routes.get(
  "/orgs/:id/usage/spend",
  openApi({
    summary: "Org spend totals and rolling window status",
    responses: {
      200: OrgUsageSpendSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param("id");
    return c.json(await getOrgStub(c.env, orgId).getUsageSpend());
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/:id/usage/limits
// ---------------------------------------------------------------------------

routes.get(
  "/orgs/:id/usage/limits",
  openApi({
    summary: "Org effective spend limits",
    responses: {
      200: OrgUsageLimitsSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param("id");
    return c.json(await getOrgStub(c.env, orgId).getUsageLimits());
  },
);

// ---------------------------------------------------------------------------
// PUT /orgs/:id/usage/limits
// ---------------------------------------------------------------------------

routes.put(
  "/orgs/:id/usage/limits",
  openApi({
    summary: "Set org spend limit overrides",
    request: {
      json: SetOrgLimitsBodySchema,
    },
    responses: {
      200: OrgUsageLimitsSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param("id");
    const body = c.req.valid("json");
    return c.json(await getOrgStub(c.env, orgId).setUsageLimits(body.limits));
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/:id/usage/log
// ---------------------------------------------------------------------------

routes.get(
  "/orgs/:id/usage/log",
  openApi({
    summary: "Org recent usage log entries (paginated)",
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        cursor: z.string().optional(),
        from: z.coerce
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Start timestamp (ms since epoch, inclusive)"),
        to: z.coerce
          .number()
          .int()
          .min(0)
          .optional()
          .describe("End timestamp (ms since epoch, exclusive)"),
      }),
    },
    responses: {
      200: OrgUsageLogSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param("id");
    const { limit, cursor, from, to } = c.req.valid("query");
    return c.json(
      await getOrgStub(c.env, orgId).getUsageLog({ limit, cursor, from, to }),
    );
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/:id/usage/log/sum — sum spend between dates
// ---------------------------------------------------------------------------

routes.get(
  "/orgs/:id/usage/log/sum",
  openApi({
    summary: "Sum of usage costs between dates",
    request: {
      query: z.object({
        from: z.coerce
          .number()
          .int()
          .min(0)
          .describe("Start timestamp (ms since epoch, inclusive)"),
        to: z.coerce
          .number()
          .int()
          .min(0)
          .describe("End timestamp (ms since epoch, exclusive)"),
        chargeable_only: z
          .preprocess((value) => {
            if (value === undefined) return undefined;
            if (typeof value === "boolean") return value;
            if (typeof value === "string") {
              const normalized = value.trim().toLowerCase();
              if (normalized === "true" || normalized === "1") return true;
              if (normalized === "false" || normalized === "0") return false;
            }
            return value;
          }, z.boolean().optional()),
      }),
    },
    responses: {
      200: OrgUsageLogSumSchema,
      502: ErrorSchema,
    },
  }),
  async (c) => {
    const orgId = c.req.param("id");
    const { from, to, chargeable_only } = c.req.valid("query");
    return c.json(
      await getOrgStub(c.env, orgId).getUsageLogSum(
        from,
        to,
        chargeable_only === true,
      ),
    );
  },
);

// ---------------------------------------------------------------------------
// GET /email-domain-blocklist
// ---------------------------------------------------------------------------

routes.get(
  "/email-domain-blocklist",
  openApi({
    summary: "Get email domain blocklist from KV",
    responses: {
      200: EmailDomainBlocklistSchema,
    },
  }),
  async (c) => {
    const domains = await getBlocklistDomainsFromKV(c.env.APP_KV);
    return c.json({ domains });
  },
);

// ---------------------------------------------------------------------------
// PUT /email-domain-blocklist
// ---------------------------------------------------------------------------

routes.put(
  "/email-domain-blocklist",
  openApi({
    summary: "Replace email domain blocklist in KV",
    request: { json: EmailDomainBlocklistSchema },
    responses: {
      200: EmailDomainBlocklistSchema,
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const domains = await setBlocklistInKV(c.env.APP_KV, body.domains);
    return c.json({ domains });
  },
);

// ---------------------------------------------------------------------------
// POST /email-domain-blocklist
// ---------------------------------------------------------------------------

routes.post(
  "/email-domain-blocklist",
  openApi({
    summary: "Add a domain to the email domain blocklist in KV",
    request: { json: AddEmailDomainBodySchema },
    responses: {
      200: EmailDomainBlocklistSchema,
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const existing = await getBlocklistDomainsFromKV(c.env.APP_KV);
    const domains = await setBlocklistInKV(c.env.APP_KV, [
      ...existing,
      body.domain,
    ]);
    return c.json({ domains });
  },
);

// ---------------------------------------------------------------------------
// DELETE /email-domain-blocklist/:domain
// ---------------------------------------------------------------------------

routes.delete(
  "/email-domain-blocklist/:domain",
  openApi({
    summary: "Remove a domain from the email domain blocklist in KV",
    responses: {
      200: EmailDomainBlocklistSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    const domainToRemove = decodeURIComponent(c.req.param("domain"))
      .trim()
      .toLowerCase()
      .replace(/^@+/, "")
      .replace(/\.+$/, "");
    const existing = await getBlocklistDomainsFromKV(c.env.APP_KV);
    if (!existing.includes(domainToRemove)) {
      return c.json({ error: "Domain not found in blocklist" }, 404);
    }
    const filtered = existing.filter((d) => d !== domainToRemove);
    const domains = await setBlocklistInKV(c.env.APP_KV, filtered);
    return c.json({ domains });
  },
);

// ---------------------------------------------------------------------------
// GET /r2/* (wildcard — key may contain slashes)
// ---------------------------------------------------------------------------

routes.get(
  "/r2/*",
  openApi({
    summary: "R2 object head metadata",
    responses: {
      200: R2ObjectDetailSchema,
      404: ErrorSchema,
    },
  }),
  async (c) => {
    // Extract everything after /r2/ from the full path.
    // basePath is /api/admin, so c.req.path is /api/admin/r2/some/key
    const fullPath = c.req.path;
    const r2Prefix = "/r2/";
    const idx = fullPath.indexOf(r2Prefix);
    const key =
      idx >= 0 ? decodeURIComponent(fullPath.slice(idx + r2Prefix.length)) : "";

    if (!key) {
      return c.json({ error: "Not found" }, 404);
    }

    const obj = await c.env.R2_BUCKET.head(key);
    if (!obj) {
      return c.json({ error: "Object not found" }, 404);
    }

    return c.json({
      key: obj.key,
      size: obj.size,
      lastModified: obj.uploaded.toISOString(),
      etag: obj.etag,
      httpMetadata: obj.httpMetadata,
      customMetadata: obj.customMetadata,
    });
  },
);
