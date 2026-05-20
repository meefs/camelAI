/**
 * OAuth-protected remote MCP server for the admin API.
 */

import type { Env, RouteContext } from "../types.js";
import type { PiCoreMessageHistoryRepairReport, PiCoreMessageRow } from "../chat-thread-do.js";
import {
  ADMIN_MCP_SCOPE,
  AdminMcpOAuthProvider,
  type AdminMcpTokenGrantRecord,
} from "../admin-mcp-oauth.js";
import { fetchAdminApiWithValidatedAuth } from "./admin/index.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
};

const TOOL_ADMIN_API_REQUEST = "admin_api_request";
const TOOL_ADMIN_OPENAPI = "admin_openapi";
const TOOL_GET_ADMIN_STATS = "get_admin_stats";
const TOOL_SEARCH_USERS = "search_users";
const TOOL_GET_USER_ORGS = "get_user_orgs";
const TOOL_SEARCH_ORGS = "search_orgs";
const TOOL_GET_ORG_DETAIL = "get_org_detail";
const TOOL_UPDATE_ORG_MODEL_ACCESS = "update_org_model_access";
const TOOL_SEARCH_THREADS = "search_threads";
const TOOL_GET_THREAD_MESSAGES = "get_thread_messages";
const TOOL_MANAGE_THREAD_MESSAGE_ROWS = "manage_thread_message_rows";
const TOOL_REPAIR_PI_MESSAGE_HISTORY = "repair_pi_message_history";
const TOOL_UPDATE_THREAD = "update_thread";
const TOOL_SEARCH_WORKSPACES = "search_workspaces";
const TOOL_SEARCH_APPS = "search_apps";
const TOOL_GET_DASHBOARD_SUMMARY = "get_dashboard_summary";
const TOOL_GET_TOP_ORGS = "get_top_orgs";
const TOOL_LIST_BANS = "list_bans";
const TOOL_GET_BAN = "get_ban";
const TOOL_BLOCK_SIGNUP_IP = "block_signup_ip";
const TOOL_UNBLOCK_SIGNUP_IP = "unblock_signup_ip";
const TOOL_GET_ORG_USAGE = "get_org_usage";
const TOOL_SET_USER_CREDITS = "set_user_credits";

function getBaseUrl(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function getAdminMcpResource(req: Request): string {
  return `${getBaseUrl(req)}/api/admin/mcp`;
}

function getProtectedResourceMetadataUrl(req: Request): string {
  const url = new URL("/.well-known/oauth-protected-resource", getBaseUrl(req));
  url.searchParams.set("resource", getAdminMcpResource(req));
  return url.toString();
}

function unauthorized(req: Request, description = "Authorization required"): Response {
  return Response.json(
    { error: "Unauthorized", details: description },
    {
      status: 401,
      headers: {
        ...JSON_HEADERS,
        "www-authenticate": `Bearer realm="admin-mcp", resource_metadata="${getProtectedResourceMetadataUrl(req)}"`,
      },
    },
  );
}

function jsonRpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function toolText(data: unknown, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

function parseStaticRedirectUris(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function verifyAdminMcpAuth(
  req: Request,
  env: Env,
): Promise<AdminMcpTokenGrantRecord | Response> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return unauthorized(req);

  const oauth = new AdminMcpOAuthProvider(
    env.APP_KV,
    env.ADMIN_MCP_CLIENT_ID,
    parseStaticRedirectUris(env.ADMIN_MCP_REDIRECT_URIS),
  );
  const grant = await oauth.verifyAccessToken(auth.slice(7), getAdminMcpResource(req));
  if (!grant) return unauthorized(req, "Invalid or expired token");
  if (!grant.scopes.includes(ADMIN_MCP_SCOPE)) {
    return Response.json(
      { error: "Forbidden", details: "Missing admin MCP scope" },
      { status: 403, headers: JSON_HEADERS },
    );
  }

  const user = await env.USER.get(env.USER.idFromName(grant.user_id)).getProfile();
  if (!user?.is_superuser) {
    return Response.json(
      { error: "Forbidden", details: "Admin access required" },
      { status: 403, headers: JSON_HEADERS },
    );
  }

  return grant;
}

function adminTools() {
  const pagination = {
    limit: { type: "number", minimum: 1, maximum: 100, description: "Page size. Defaults to 50." },
    offset: { type: "number", minimum: 0, description: "Zero-based pagination offset. Defaults to 0." },
    search: { type: "string", description: "Optional search term." },
  };

  return [
    {
      name: TOOL_ADMIN_OPENAPI,
      description: "Return the camelAI admin API OpenAPI document.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: TOOL_GET_ADMIN_STATS,
      description: "Get aggregate admin counts for users, orgs, memberships, workspaces, integrations, and orphaned users.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: TOOL_SEARCH_USERS,
      description: "Search and filter users.",
      inputSchema: {
        type: "object",
        properties: {
          ...pagination,
          is_superuser: { type: "boolean" },
          is_orphaned: { type: "boolean" },
          sort_by: { type: "string", enum: ["created_at", "email", "name"] },
          sort_dir: { type: "string", enum: ["asc", "desc"] },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_GET_USER_ORGS,
      description: "List org memberships for one user.",
      inputSchema: {
        type: "object",
        properties: { user_id: { type: "string" } },
        required: ["user_id"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_SEARCH_ORGS,
      description: "Search and filter organizations, optionally including usage and 30-day spend.",
      inputSchema: {
        type: "object",
        properties: {
          ...pagination,
          archived: { type: "boolean" },
          exclude_spam: { type: "boolean" },
          exclude_internal_domains: { type: "string" },
          include_usage: { type: "boolean" },
          include_spend_30d: { type: "boolean" },
          sort_by: { type: "string", enum: ["created_at", "name"] },
          sort_dir: { type: "string", enum: ["asc", "desc"] },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_GET_ORG_DETAIL,
      description: "Get organization metadata and recent activity.",
      inputSchema: {
        type: "object",
        properties: { org_id: { type: "string" } },
        required: ["org_id"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_UPDATE_ORG_MODEL_ACCESS,
      description: "Enable or disable Claude proxy model access for an organization.",
      inputSchema: {
        type: "object",
        properties: {
          org_id: { type: "string" },
          claude_proxy_models: { type: "boolean" },
        },
        required: ["org_id", "claude_proxy_models"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_SEARCH_THREADS,
      description: "Search and filter chat threads.",
      inputSchema: {
        type: "object",
        properties: {
          ...pagination,
          org_id: { type: "string" },
          workspace_id: { type: "string" },
          created_by: { type: "string" },
          sort_by: { type: "string", enum: ["created_at", "updated_at"] },
          sort_dir: { type: "string", enum: ["asc", "desc"] },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_GET_THREAD_MESSAGES,
      description: "Get parsed messages for one thread.",
      inputSchema: {
        type: "object",
        properties: { thread_id: { type: "string" } },
        required: ["thread_id"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_MANAGE_THREAD_MESSAGE_ROWS,
      description:
        "Inspect or repair persisted pi_core_messages rows for any chat thread. Use read mode to inspect and write mode to insert/update a row by index.",
      inputSchema: {
        type: "object",
        properties: {
          thread_id: { type: "string", description: "Thread ID whose pi_core_messages rows should be inspected or repaired." },
          mode: { type: "string", enum: ["read", "write"], description: "Whether to read rows or write one row." },
          limit: { type: "integer", minimum: 1, maximum: 2000, description: "For read mode: max rows to return. Defaults to 200." },
          idx: { type: "integer", minimum: 0, description: "For write mode: row index to insert/update." },
          payload: { type: "string", description: "For write mode: JSON string payload for the pi_core_messages row." },
          created_at: { type: "integer", description: "For write mode: optional millisecond timestamp override." },
        },
        required: ["thread_id", "mode"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_REPAIR_PI_MESSAGE_HISTORY,
      description:
        "Dry-run or persistently repair stored pi_core_messages for a chat thread. Dry-run reports dropped/orphan tool results, synthetic missing tool results, trimmed assistant tail blocks, and invalid rows without writing. Repair rewrites pi_core_messages atomically with normalized repaired history.",
      inputSchema: {
        type: "object",
        properties: {
          thread_id: { type: "string", description: "Thread ID whose persisted pi_core_messages should be audited or repaired." },
          mode: { type: "string", enum: ["dry_run", "repair"], description: "Use dry_run to inspect only, or repair to persist normalized repaired pi_core_messages. Defaults to dry_run." },
        },
        required: ["thread_id"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_UPDATE_THREAD,
      description: "Update a thread title, creator, or model where allowed by admin API rules.",
      inputSchema: {
        type: "object",
        properties: {
          thread_id: { type: "string" },
          title: { type: "string" },
          created_by: { type: "string" },
          model: { type: "string", enum: ["sonnet", "opus", "gpt-5.4", "gpt-5.4-mini"] },
        },
        required: ["thread_id"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_SEARCH_WORKSPACES,
      description: "Search and filter workspaces.",
      inputSchema: {
        type: "object",
        properties: {
          ...pagination,
          org_id: { type: "string" },
          archived: { type: "boolean" },
          sort_by: { type: "string", enum: ["created_at", "name"] },
          sort_dir: { type: "string", enum: ["asc", "desc"] },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_SEARCH_APPS,
      description: "Search and filter deployed apps.",
      inputSchema: {
        type: "object",
        properties: {
          ...pagination,
          org_id: { type: "string" },
          workspace_id: { type: "string" },
          is_public: { type: "boolean" },
          sort_by: { type: "string", enum: ["created_at", "updated_at"] },
          sort_dir: { type: "string", enum: ["asc", "desc"] },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_GET_DASHBOARD_SUMMARY,
      description: "Get dashboard summary metrics for a date.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          exclude_spam: { type: "boolean" },
          exclude_internal_domains: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_GET_TOP_ORGS,
      description: "Get top organizations by spend or member count.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", minimum: 1, maximum: 100 },
          exclude_spam: { type: "boolean" },
          exclude_internal_domains: { type: "string" },
          sort_by: { type: "string", enum: ["spend_7d", "spend_30d", "member_count"] },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_LIST_BANS,
      description: "List active user or org bans.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["user", "org"] },
          limit: { type: "number", minimum: 1, maximum: 100 },
          cursor: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_GET_BAN,
      description: "Get one active ban by scope and target id.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["user", "org"] },
          target_id: { type: "string" },
        },
        required: ["scope", "target_id"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_BLOCK_SIGNUP_IP,
      description: "Block signup attempts from an IP address.",
      inputSchema: {
        type: "object",
        properties: {
          ip: { type: "string" },
          reason: { type: "string" },
          blocked_by: { type: "string" },
        },
        required: ["ip"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_UNBLOCK_SIGNUP_IP,
      description: "Remove an IP address from the signup blocklist.",
      inputSchema: {
        type: "object",
        properties: { ip: { type: "string" } },
        required: ["ip"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_GET_ORG_USAGE,
      description: "Get org usage data: spend, limits, recent log entries, or a summed date range.",
      inputSchema: {
        type: "object",
        properties: {
          org_id: { type: "string" },
          view: { type: "string", enum: ["spend", "limits", "log", "log_sum"] },
          limit: { type: "number", minimum: 1, maximum: 1000 },
          cursor: { type: "string" },
          from: { type: "number", description: "Start timestamp in milliseconds." },
          to: { type: "number", description: "End timestamp in milliseconds." },
        },
        required: ["org_id", "view"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_SET_USER_CREDITS,
      description:
        "Set credits for a user's organization. Pass available_credits_cents to set the visible remaining balance, or override raw purchase/grant totals. org_id is required if the user belongs to multiple orgs.",
      inputSchema: {
        type: "object",
        properties: {
          user_id: { type: "string" },
          org_id: { type: "string" },
          available_credits_cents: { type: "number", minimum: 0 },
          billing_credit_purchase_total_cents: { type: "number" },
          billing_credit_grant_total_cents: { type: "number" },
          billing_credit_usage_started_at: { type: ["number", "null"] },
        },
        required: ["user_id"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_ADMIN_API_REQUEST,
      description:
        "Call a camelAI admin API endpoint. The path must start with /api/admin/ and cannot target OAuth or MCP endpoints.",
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
            description: "HTTP method.",
          },
          path: {
            type: "string",
            description: "Admin API path, for example /api/admin/users.",
          },
          query: {
            type: "object",
            additionalProperties: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "null" },
                { type: "array", items: { type: ["string", "number", "boolean"] } },
              ],
            },
          },
          body: {
            description: "JSON body for POST, PUT, and PATCH requests.",
          },
        },
        required: ["method", "path"],
        additionalProperties: false,
      },
    },
  ];
}

function appendQuery(url: URL, query: unknown) {
  if (!isRecord(query)) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

function asArgs(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {};
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) ? value : null;
}

function requiredStringArg(args: Record<string, unknown>, key: string): string | { error: string } {
  const value = stringArg(args, key);
  return value ?? { error: `${key} is required` };
}

function pickQuery(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined) query[key] = args[key];
  }
  return query;
}

function pickBody(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  return body;
}

function normalizeAdminApiPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed.startsWith("/api/admin/")) return null;
  if (
    trimmed === "/api/admin/mcp" ||
    trimmed.startsWith("/api/admin/mcp/") ||
    trimmed.startsWith("/api/admin/oauth/")
  ) {
    return null;
  }
  return trimmed;
}

type ChatThreadMessageRowsStub = {
  getPiCoreMessageRows(limit?: number): Promise<PiCoreMessageRow[]> | PiCoreMessageRow[];
  repairPiCoreMessageHistory(input?: {
    mode?: "dry_run" | "repair";
  }): Promise<PiCoreMessageHistoryRepairReport> | PiCoreMessageHistoryRepairReport;
  putPiCoreMessageRow(input: {
    idx: number;
    payload: string;
    created_at?: number;
  }): Promise<{ ok: true; inserted: boolean; idx: number }> | { ok: true; inserted: boolean; idx: number };
};

function getChatThreadMessageRowsStub(env: Env, threadId: string): ChatThreadMessageRowsStub | null {
  if (!("CHAT_THREAD" in env) || !env.CHAT_THREAD) return null;
  return env.CHAT_THREAD.get(
    env.CHAT_THREAD.idFromName(threadId),
  ) as unknown as ChatThreadMessageRowsStub;
}

async function repairPiMessageHistoryTool(env: Env, args: Record<string, unknown>) {
  const threadId = requiredStringArg(args, "thread_id");
  if (typeof threadId !== "string") return toolText(threadId, true);

  const mode = stringArg(args, "mode") ?? "dry_run";
  if (mode !== "dry_run" && mode !== "repair") {
    return toolText({ error: "mode must be dry_run or repair" }, true);
  }

  const chatThreadStub = getChatThreadMessageRowsStub(env, threadId);
  if (!chatThreadStub) {
    return toolText({ error: "CHAT_THREAD binding is not available" }, true);
  }

  try {
    const result = await Promise.resolve(
      chatThreadStub.repairPiCoreMessageHistory({ mode }),
    );
    return toolText({
      success: true,
      thread_id: threadId,
      ...result,
    });
  } catch (error) {
    return toolText(
      { error: error instanceof Error ? error.message : "Failed to repair Pi message history" },
      true,
    );
  }
}

async function manageThreadMessageRowsTool(env: Env, args: Record<string, unknown>) {
  const threadId = requiredStringArg(args, "thread_id");
  if (typeof threadId !== "string") return toolText(threadId, true);

  const mode = stringArg(args, "mode");
  if (mode !== "read" && mode !== "write") {
    return toolText({ error: "mode must be read or write" }, true);
  }

  const chatThreadStub = getChatThreadMessageRowsStub(env, threadId);
  if (!chatThreadStub) {
    return toolText({ error: "CHAT_THREAD binding is not available" }, true);
  }

  try {
    if (mode === "read") {
      const rows = await Promise.resolve(
        chatThreadStub.getPiCoreMessageRows(integerArg(args, "limit") ?? undefined),
      );
      return toolText({
        success: true,
        thread_id: threadId,
        count: rows.length,
        rows,
      });
    }

    const idx = integerArg(args, "idx");
    const payload = stringArg(args, "payload");
    if (idx === null || payload === null) {
      return toolText({ error: "idx and payload are required for write mode" }, true);
    }

    const result = await Promise.resolve(
      chatThreadStub.putPiCoreMessageRow({
        idx,
        payload,
        created_at: integerArg(args, "created_at") ?? undefined,
      }),
    );
    return toolText({
      success: true,
      thread_id: threadId,
      ...result,
    });
  } catch (error) {
    return toolText(
      { error: error instanceof Error ? error.message : "Failed to manage thread message rows" },
      true,
    );
  }
}

async function fetchAdminApiTool(
  req: Request,
  env: Env,
  grant: AdminMcpTokenGrantRecord,
  args: unknown,
) {
  if (!isRecord(args)) {
    return toolText({ error: "Tool arguments must be an object" }, true);
  }

  const method = typeof args.method === "string" ? args.method.toUpperCase() : "";
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return toolText({ error: "Unsupported method" }, true);
  }

  const path = normalizeAdminApiPath(args.path);
  if (!path) {
    return toolText({ error: "Path must be an admin API path and cannot target MCP/OAuth endpoints" }, true);
  }

  const url = new URL(path, getBaseUrl(req));
  appendQuery(url, args.query);

  const headers = new Headers({
    accept: "application/json",
    "x-admin-mcp-user-id": grant.user_id,
  });
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "DELETE" && args.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(args.body);
  }

  const adminRequest = new Request(url.toString(), { method, headers, body });
  const response = await fetchAdminApiWithValidatedAuth(adminRequest, env);
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "text/plain";
  let bodyJson: unknown;
  if (contentType.includes("json") && text) {
    try {
      bodyJson = JSON.parse(text);
    } catch {}
  }
  const payload = {
    status: response.status,
    ok: response.ok,
    content_type: contentType,
    ...(bodyJson === undefined
      ? { body: text.length > 120_000 ? `${text.slice(0, 120_000)}\n...[truncated]` : text }
      : { body_json: bodyJson }),
  };
  return toolText(payload, !response.ok);
}

async function callTool(
  req: Request,
  env: Env,
  grant: AdminMcpTokenGrantRecord,
  name: unknown,
  args: unknown,
) {
  const input = asArgs(args);

  if (name === TOOL_ADMIN_OPENAPI) {
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: "/api/admin/openapi.json",
    });
  }
  if (name === TOOL_GET_ADMIN_STATS) {
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: "/api/admin/stats",
    });
  }
  if (name === TOOL_SEARCH_USERS) {
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: "/api/admin/users",
      query: pickQuery(input, ["limit", "offset", "search", "is_superuser", "is_orphaned", "sort_by", "sort_dir"]),
    });
  }
  if (name === TOOL_GET_USER_ORGS) {
    const userId = requiredStringArg(input, "user_id");
    if (typeof userId !== "string") return toolText(userId, true);
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: `/api/admin/users/${encodeURIComponent(userId)}/orgs`,
    });
  }
  if (name === TOOL_SEARCH_ORGS) {
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: "/api/admin/orgs",
      query: pickQuery(input, [
        "limit",
        "offset",
        "search",
        "archived",
        "exclude_spam",
        "exclude_internal_domains",
        "include_usage",
        "include_spend_30d",
        "sort_by",
        "sort_dir",
      ]),
    });
  }
  if (name === TOOL_GET_ORG_DETAIL) {
    const orgId = requiredStringArg(input, "org_id");
    if (typeof orgId !== "string") return toolText(orgId, true);
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: `/api/admin/orgs/${encodeURIComponent(orgId)}`,
    });
  }
  if (name === TOOL_UPDATE_ORG_MODEL_ACCESS) {
    const orgId = requiredStringArg(input, "org_id");
    if (typeof orgId !== "string") return toolText(orgId, true);
    return fetchAdminApiTool(req, env, grant, {
      method: "PUT",
      path: `/api/admin/orgs/${encodeURIComponent(orgId)}/model-access`,
      body: pickBody(input, ["claude_proxy_models"]),
    });
  }
  if (name === TOOL_SEARCH_THREADS) {
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: "/api/admin/threads",
      query: pickQuery(input, ["limit", "offset", "search", "org_id", "workspace_id", "created_by", "sort_by", "sort_dir"]),
    });
  }
  if (name === TOOL_GET_THREAD_MESSAGES) {
    const threadId = requiredStringArg(input, "thread_id");
    if (typeof threadId !== "string") return toolText(threadId, true);
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: `/api/admin/threads/${encodeURIComponent(threadId)}/messages`,
    });
  }
  if (name === TOOL_MANAGE_THREAD_MESSAGE_ROWS) {
    return manageThreadMessageRowsTool(env, input);
  }
  if (name === TOOL_REPAIR_PI_MESSAGE_HISTORY) {
    return repairPiMessageHistoryTool(env, input);
  }
  if (name === TOOL_UPDATE_THREAD) {
    const threadId = requiredStringArg(input, "thread_id");
    if (typeof threadId !== "string") return toolText(threadId, true);
    return fetchAdminApiTool(req, env, grant, {
      method: "PATCH",
      path: `/api/admin/threads/${encodeURIComponent(threadId)}`,
      body: pickBody(input, ["title", "created_by", "model"]),
    });
  }
  if (name === TOOL_SEARCH_WORKSPACES) {
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: "/api/admin/workspaces",
      query: pickQuery(input, ["limit", "offset", "search", "org_id", "archived", "sort_by", "sort_dir"]),
    });
  }
  if (name === TOOL_SEARCH_APPS) {
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: "/api/admin/apps",
      query: pickQuery(input, ["limit", "offset", "search", "org_id", "workspace_id", "is_public", "sort_by", "sort_dir"]),
    });
  }
  if (name === TOOL_GET_DASHBOARD_SUMMARY) {
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: "/api/admin/dashboard/summary",
      query: pickQuery(input, ["date", "exclude_spam", "exclude_internal_domains"]),
    });
  }
  if (name === TOOL_GET_TOP_ORGS) {
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: "/api/admin/dashboard/top-orgs",
      query: pickQuery(input, ["limit", "exclude_spam", "exclude_internal_domains", "sort_by"]),
    });
  }
  if (name === TOOL_LIST_BANS) {
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: "/api/admin/bans",
      query: pickQuery(input, ["scope", "limit", "cursor"]),
    });
  }
  if (name === TOOL_GET_BAN) {
    const scope = requiredStringArg(input, "scope");
    if (typeof scope !== "string") return toolText(scope, true);
    const targetId = requiredStringArg(input, "target_id");
    if (typeof targetId !== "string") return toolText(targetId, true);
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: `/api/admin/bans/${encodeURIComponent(scope)}/${encodeURIComponent(targetId)}`,
    });
  }
  if (name === TOOL_BLOCK_SIGNUP_IP) {
    const ip = requiredStringArg(input, "ip");
    if (typeof ip !== "string") return toolText(ip, true);
    return fetchAdminApiTool(req, env, grant, {
      method: "PUT",
      path: `/api/admin/signup-blocked-ips/${encodeURIComponent(ip)}`,
      body: pickBody(input, ["reason", "blocked_by"]),
    });
  }
  if (name === TOOL_UNBLOCK_SIGNUP_IP) {
    const ip = requiredStringArg(input, "ip");
    if (typeof ip !== "string") return toolText(ip, true);
    return fetchAdminApiTool(req, env, grant, {
      method: "DELETE",
      path: `/api/admin/signup-blocked-ips/${encodeURIComponent(ip)}`,
    });
  }
  if (name === TOOL_GET_ORG_USAGE) {
    const orgId = requiredStringArg(input, "org_id");
    if (typeof orgId !== "string") return toolText(orgId, true);
    const view = stringArg(input, "view") ?? "spend";
    const encodedOrgId = encodeURIComponent(orgId);
    if (view === "spend") {
      return fetchAdminApiTool(req, env, grant, {
        method: "GET",
        path: `/api/admin/orgs/${encodedOrgId}/usage/spend`,
      });
    }
    if (view === "limits") {
      return fetchAdminApiTool(req, env, grant, {
        method: "GET",
        path: `/api/admin/orgs/${encodedOrgId}/usage/limits`,
      });
    }
    if (view === "log") {
      return fetchAdminApiTool(req, env, grant, {
        method: "GET",
        path: `/api/admin/orgs/${encodedOrgId}/usage/log`,
        query: pickQuery(input, ["limit", "cursor", "from", "to"]),
      });
    }
    if (view === "log_sum") {
      return fetchAdminApiTool(req, env, grant, {
        method: "GET",
        path: `/api/admin/orgs/${encodedOrgId}/usage/log/sum`,
        query: pickQuery(input, ["from", "to"]),
      });
    }
    return toolText({ error: "view must be one of spend, limits, log, or log_sum" }, true);
  }
  if (name === TOOL_SET_USER_CREDITS) {
    const userId = requiredStringArg(input, "user_id");
    if (typeof userId !== "string") return toolText(userId, true);
    return fetchAdminApiTool(req, env, grant, {
      method: "PUT",
      path: `/api/admin/users/${encodeURIComponent(userId)}/credits`,
      body: pickBody(input, [
        "org_id",
        "available_credits_cents",
        "billing_credit_purchase_total_cents",
        "billing_credit_grant_total_cents",
        "billing_credit_usage_started_at",
      ]),
    });
  }
  if (name === TOOL_ADMIN_API_REQUEST) {
    return fetchAdminApiTool(req, env, grant, args);
  }
  return toolText({ error: `Unknown tool: ${String(name)}` }, true);
}

async function handleJsonRpcRequest(
  rpc: JsonRpcRequest,
  req: Request,
  env: Env,
  grant: AdminMcpTokenGrantRecord,
) {
  if (!rpc.method) {
    return jsonRpcError(rpc.id, -32600, "Invalid Request");
  }

  switch (rpc.method) {
    case "initialize":
      return jsonRpcResult(rpc.id, {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "camelai-admin",
          version: "1.0.0",
        },
      });
    case "ping":
      return jsonRpcResult(rpc.id, {});
    case "tools/list":
      return jsonRpcResult(rpc.id, { tools: adminTools() });
    case "tools/call": {
      const params = isRecord(rpc.params) ? rpc.params : {};
      return jsonRpcResult(
        rpc.id,
        await callTool(req, env, grant, params.name, params.arguments),
      );
    }
    default:
      return jsonRpcError(rpc.id, -32601, "Method not found");
  }
}

function isNotificationOrResponse(rpc: JsonRpcRequest): boolean {
  return rpc.id === undefined;
}

async function handlePost(req: Request, env: Env, grant: AdminMcpTokenGrantRecord): Promise<Response> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json(jsonRpcError(null, -32700, "Parse error"), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  if (!messages.every(isRecord)) {
    return Response.json(jsonRpcError(null, -32600, "Invalid Request"), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  const requests = messages as JsonRpcRequest[];
  if (requests.every(isNotificationOrResponse)) {
    return new Response(null, { status: 202 });
  }

  const responses = await Promise.all(
    requests
      .filter((rpc) => !isNotificationOrResponse(rpc))
      .map((rpc) => handleJsonRpcRequest(rpc, req, env, grant)),
  );

  return Response.json(Array.isArray(payload) ? responses : responses[0], {
    headers: JSON_HEADERS,
  });
}

export async function handleAdminMcp({ req, env }: RouteContext): Promise<Response | null> {
  if (!validateOrigin(req)) {
    return Response.json(jsonRpcError(null, -32000, "Invalid Origin"), {
      status: 403,
      headers: JSON_HEADERS,
    });
  }

  const auth = await verifyAdminMcpAuth(req, env);
  if (auth instanceof Response) return auth;

  if (req.method === "GET" || req.method === "DELETE") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  if (req.method !== "POST") return null;

  return handlePost(req, env, auth);
}
