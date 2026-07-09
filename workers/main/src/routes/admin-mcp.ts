/**
 * OAuth-protected remote MCP server for the admin API.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env, RouteContext } from "../types.js";
import type {
  PiCoreMessageHistoryRepairReport,
  PiCoreMessageRow,
} from "../chat-thread-do.js";
import {
  ADMIN_MCP_SCOPE,
  AdminMcpOAuthProvider,
  type AdminMcpTokenGrantRecord,
} from "../admin-mcp-oauth.js";
import { fetchAdminApiWithValidatedAuth } from "./admin/index.js";
import { getAdminIndexStub } from "./admin/helpers.js";

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
const TOOL_QUERY_CHAT_ERRORS = "query_chat_errors";
const TOOL_GET_THREAD_MESSAGES = "get_thread_messages";
const TOOL_GET_THREAD_JSONL = "get_thread_jsonl";
const TOOL_MANAGE_THREAD_MESSAGE_ROWS = "manage_thread_message_rows";
const TOOL_REPAIR_PI_MESSAGE_HISTORY = "repair_pi_message_history";
const TOOL_UPDATE_THREAD = "update_thread";
const TOOL_SEARCH_WORKSPACES = "search_workspaces";
const TOOL_MIGRATE_VM_PROJECTS = "migrate_vm_projects";
const TOOL_VERIFY_PROJECT_BUILD = "verify_project_build";
const TOOL_SEARCH_APPS = "search_apps";
const TOOL_GET_DASHBOARD_SUMMARY = "get_dashboard_summary";
const TOOL_GET_TOP_ORGS = "get_top_orgs";
const TOOL_LIST_BANS = "list_bans";
const TOOL_GET_BAN = "get_ban";
const TOOL_BLOCK_SIGNUP_IP = "block_signup_ip";
const TOOL_UNBLOCK_SIGNUP_IP = "unblock_signup_ip";
const TOOL_GET_ORG_USAGE = "get_org_usage";
const TOOL_GRANT_ORG_CREDITS = "grant_org_credits";
const TOOL_SET_USER_CREDITS = "set_user_credits";
const TOOL_ADMIN_JS_EXEC = "admin_js_exec";

const ADMIN_JS_EXEC_COMPATIBILITY_DATE = "2025-06-18";
const ADMIN_JS_EXEC_DEFAULT_TIMEOUT_MS = 30_000;
const ADMIN_JS_EXEC_MAX_TIMEOUT_MS = 120_000;
const ADMIN_JS_EXEC_DEFAULT_MAX_OUTPUT_CHARACTERS = 120_000;
const ADMIN_JS_EXEC_MAX_OUTPUT_CHARACTERS = 1_000_000;
const ADMIN_JS_EXEC_DO_BRIDGE_BINDING = "ADMIN_DO";
const ADMIN_JS_EXEC_DO_NAMESPACES_BINDING = "ADMIN_DO_NAMESPACES";

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
      description: "Search and filter chat threads by raw thread ID, title, model, org name, or workspace name.",
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
      name: TOOL_QUERY_CHAT_ERRORS,
      description:
        "Query user-visible chat errors recorded in the admin error dashboard. Returns summaries, grouped fingerprints, optional dimension breakdowns, optional affected threads, and optional recent event samples. Use fingerprint plus include_threads to drill into one grouped error; use include_events for concrete examples before fetching thread messages.",
      inputSchema: {
        type: "object",
        properties: {
          range: { type: "string", enum: ["1h", "6h", "24h", "7d", "30d"] },
          from: { type: "integer", minimum: 0, description: "Start timestamp in milliseconds since epoch." },
          to: { type: "integer", minimum: 0, description: "End timestamp in milliseconds since epoch." },
          fingerprint: { type: "string" },
          org_id: { type: "string" },
          workspace_id: { type: "string" },
          thread_id: { type: "string" },
          user_id: { type: "string" },
          source: { type: "string" },
          error_kind: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          status: { type: "integer" },
          search: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Grouped fingerprint limit. Defaults to 50." },
          offset: { type: "integer", minimum: 0, description: "Grouped fingerprint offset. Defaults to 0." },
          threads_limit: { type: "integer", minimum: 1, maximum: 200, description: "Affected thread limit. Defaults to 50." },
          threads_offset: { type: "integer", minimum: 0, description: "Affected thread offset. Defaults to 0." },
          events_limit: { type: "integer", minimum: 0, maximum: 200, description: "Recent event limit. Defaults to 0." },
          events_offset: { type: "integer", minimum: 0, description: "Recent event offset. Defaults to 0." },
          include_threads: { type: "boolean", description: "Defaults to true when fingerprint is supplied." },
          include_events: { type: "boolean", description: "Defaults to false." },
          include_breakdowns: { type: "boolean", description: "Defaults to true." },
          sort_by: { type: "string", enum: ["count", "affected_threads", "last_seen", "first_seen"] },
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
      name: TOOL_GET_THREAD_JSONL,
      description:
        "Get a reconstructed JSONL transcript for one Pi-backed thread. The text content is raw JSONL with one parsed message per line.",
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
          model: { type: "string", enum: ["sonnet", "opus-4.8", "gpt-5.4", "gpt-5.4-mini"] },
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
      name: TOOL_MIGRATE_VM_PROJECTS,
      description:
        "Migrate a workspace's legacy VM-backed projects to DO+R2 storage (copies VM source files, seeds a snapshot, flips backend to do-r2). VM checkouts are never modified, so a migration is reversible by flipping the backend back. Defaults to dry_run: true, which reports what would migrate without writing.",
      inputSchema: {
        type: "object",
        properties: {
          workspace_id: { type: "string", description: "Workspace to migrate." },
          project: { type: "string", description: "Optional project name; omit to migrate every legacy project in the workspace." },
          dry_run: { type: "boolean", description: "Defaults to true. Pass false to actually migrate." },
          max_file_bytes: { type: "integer", description: "Per-file size cap; larger files are skipped and recorded. Defaults to 1 GiB. Files above ~20 MiB stream VM -> R2 instead of going through the RPC write path." },
          max_project_bytes: { type: "integer", description: "Per-project total cap; exceeding it fails the project. Defaults to 4 GiB." },
          force: { type: "boolean", description: "Re-migrate a project already on do-r2 (clears its DO tree first). Defaults to false." },
          lift_nested_root: { type: "boolean", description: "Lift a single nested app directory to the project root. Defaults to true." },
        },
        required: ["workspace_id"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_VERIFY_PROJECT_BUILD,
      description:
        "Run a validation build (bun install + bun run build in the platform build sandbox, no deploy) for a DO-backed project. Use after migrate_vm_projects to confirm a migrated project still builds. Only meaningful for projects with a root package.json build script; notebook projects deploy without a build.",
      inputSchema: {
        type: "object",
        properties: {
          workspace_id: { type: "string" },
          project: { type: "string", description: "Project name within the workspace." },
          org_id: { type: "string", description: "Org owning the workspace; keys the per-org build sandbox." },
          timeout_ms: { type: "integer", description: "Build timeout in milliseconds." },
        },
        required: ["workspace_id", "project", "org_id"],
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
      name: TOOL_GRANT_ORG_CREDITS,
      description:
        "Grant usage credits to an organization and record the grant in the admin credit ledger.",
      inputSchema: {
        type: "object",
        properties: {
          org_id: { type: "string" },
          amount_cents: { type: "integer", minimum: 1 },
          reason: { type: "string", maxLength: 500 },
          idempotency_key: { type: "string", maxLength: 200 },
        },
        required: ["org_id", "amount_cents"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_SET_USER_CREDITS,
      description:
        "Debug override: set credits for a user's organization without creating a grant ledger row. Prefer grant_org_credits for normal admin-issued usage credits. Pass available_credits_cents to set the visible remaining balance, or override raw purchase/grant totals. org_id is required if the user belongs to multiple orgs.",
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
      name: TOOL_ADMIN_JS_EXEC,
      description:
        "Run admin-only JavaScript in an ephemeral Worker with Durable Object RPC helpers. Available globals: DO.namespaces, DO.stub(namespace, id, { idFrom }), DO.call(namespace, id, method, args, { idFrom }), and text(value). idFrom defaults to name and can be name or string.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "JavaScript function body. Use return for the final result, for example: return await DO.call('ORG', 'org_id', 'getInfo');",
          },
          timeout_ms: {
            type: "integer",
            minimum: 100,
            maximum: ADMIN_JS_EXEC_MAX_TIMEOUT_MS,
            description: `Wall-clock timeout in milliseconds. Defaults to ${ADMIN_JS_EXEC_DEFAULT_TIMEOUT_MS}.`,
          },
          max_output_characters: {
            type: "integer",
            minimum: 1000,
            maximum: ADMIN_JS_EXEC_MAX_OUTPUT_CHARACTERS,
            description:
              `Maximum JSON output characters returned by the tool. Defaults to ${ADMIN_JS_EXEC_DEFAULT_MAX_OUTPUT_CHARACTERS}.`,
          },
        },
        required: ["code"],
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

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
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

type ChatThreadParsedMessagesStub = {
  getPiCoreParsedMessages(threadId: string): Promise<unknown[]> | unknown[];
};

type AdminThreadContext = {
  id?: string;
  title?: string | null;
  org_id: string;
  workspace_id: string;
  updated_at?: number | string | null;
};

type AdminThreadContextLookup = {
  getThreadContextById(threadId: string): Promise<AdminThreadContext | null>;
};

function getChatThreadMessageRowsStub(env: Env, threadId: string): ChatThreadMessageRowsStub | null {
  if (!("CHAT_THREAD" in env) || !env.CHAT_THREAD) return null;
  return env.CHAT_THREAD.get(
    env.CHAT_THREAD.idFromName(threadId),
  ) as unknown as ChatThreadMessageRowsStub;
}

function getChatThreadParsedMessagesStub(env: Env, threadId: string): ChatThreadParsedMessagesStub | null {
  if (!("CHAT_THREAD" in env) || !env.CHAT_THREAD) return null;
  return env.CHAT_THREAD.get(
    env.CHAT_THREAD.idFromName(threadId),
  ) as unknown as ChatThreadParsedMessagesStub;
}

function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace {
  return isRecord(value) &&
    typeof value.get === "function" &&
    typeof value.idFromName === "function" &&
    typeof value.idFromString === "function";
}

function adminJsExecNamespaceNames(env: Env): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (isDurableObjectNamespace(value)) names.push(key);
  }
  return names.sort();
}

type AdminJsExecDoCallOptions = {
  idFrom?: "name" | "string";
};

type AdminJsExecDoBridge = {
  call(
    namespace: string,
    id: string,
    method: string,
    args?: unknown[],
    options?: AdminJsExecDoCallOptions,
  ): Promise<unknown>;
};

function getAdminJsExecDoNamespace(env: Env, namespace: string): DurableObjectNamespace {
  const value = (env as unknown as Record<string, unknown>)[namespace];
  if (!isDurableObjectNamespace(value)) {
    throw new Error(`Unknown Durable Object namespace: ${namespace}`);
  }
  return value;
}

function getAdminJsExecDoStub(
  env: Env,
  namespace: string,
  id: string,
  options: AdminJsExecDoCallOptions = {},
): DurableObjectStub {
  if (typeof namespace !== "string" || !namespace) {
    throw new Error("Durable Object namespace must be a non-empty string");
  }
  if (typeof id !== "string" || !id) {
    throw new Error("Durable Object id must be a non-empty string");
  }
  const binding = getAdminJsExecDoNamespace(env, namespace);
  const mode = options.idFrom || "name";
  if (mode === "name") return binding.get(binding.idFromName(id));
  if (mode === "string") return binding.get(binding.idFromString(id));
  throw new Error("idFrom must be one of: name, string");
}

export class AdminJsExecDoBinding extends WorkerEntrypoint<Env> {
  namespaces(): string[] {
    return adminJsExecNamespaceNames(this.env);
  }

  async call(
    namespace: string,
    id: string,
    method: string,
    args: unknown[] = [],
    options: AdminJsExecDoCallOptions = {},
  ): Promise<unknown> {
    if (typeof method !== "string" || !method) {
      throw new Error("Durable Object RPC method must be a non-empty string");
    }
    const stub = getAdminJsExecDoStub(this.env, namespace, id, options);
    const fn = (stub as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      throw new Error(`RPC method not found on ${namespace}: ${method}`);
    }
    const callArgs = Array.isArray(args) ? args : [args];
    return await (stub as unknown as Record<string, (...args: unknown[]) => Promise<unknown> | unknown>)[method]!(
      ...callArgs,
    );
  }
}

function createAdminJsExecDoBridge(
  ctx: ExecutionContext,
  env: Env,
): { binding: AdminJsExecDoBridge; namespaces: string[] } | null {
  const factory = (ctx as unknown as {
    exports?: {
      AdminJsExecDoBinding?: (options?: { props?: Record<string, never> }) => AdminJsExecDoBridge;
    };
  }).exports?.AdminJsExecDoBinding;
  if (typeof factory !== "function") {
    return null;
  }
  return {
    binding: factory({ props: {} }),
    namespaces: adminJsExecNamespaceNames(env),
  };
}

function adminJsExecWorkerModule(userCode: string): string {
  return `${String.raw`
import { WorkerEntrypoint } from "cloudflare:workers";

function stringifyOutput(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function stringifyConsoleArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  return stringifyOutput(value);
}

function serializeResult(value) {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : JSON.parse(json);
  } catch {
    return stringifyOutput(value);
  }
}

function createOutputConsole(output) {
  const originalConsole = globalThis.console || {};
  const capture = (...args) => {
    output.push(args.map(stringifyConsoleArg).join(" "));
  };
  return Object.freeze({
    ...originalConsole,
    log: capture,
    info: capture,
    warn: capture,
    error: capture,
  });
}

function createDoFacade(bridge, namespaceNames) {
  if (!bridge || typeof bridge.call !== "function") {
    throw new Error("Admin Durable Object bridge is not configured");
  }
  const namespaces = Object.freeze(
    Array.isArray(namespaceNames)
      ? namespaceNames.filter((name) => typeof name === "string" && name.length > 0)
      : [],
  );

  const assertNamespace = (namespace) => {
    if (typeof namespace !== "string" || !namespace) {
      throw new Error("Durable Object namespace must be a non-empty string");
    }
    if (!namespaces.includes(namespace)) {
      throw new Error("Unknown Durable Object namespace: " + namespace);
    }
  };

  const getStub = (namespace, id, options = {}) => {
    assertNamespace(namespace);
    if (typeof id !== "string" || !id) {
      throw new Error("Durable Object id must be a non-empty string");
    }
    return new Proxy({}, {
      get(_target, property) {
        if (property === "then") return undefined;
        if (typeof property !== "string") return undefined;
        return (...args) => bridge.call(namespace, id, property, args, options);
      },
    });
  };

  const durableObjectId = (id, idFrom) => Object.freeze({
    __camelAdminDoId: true,
    id: String(id),
    idFrom,
  });

  const normalizeDurableObjectId = (value) => {
    if (
      value &&
      typeof value === "object" &&
      value.__camelAdminDoId === true &&
      typeof value.id === "string"
    ) {
      return {
        id: value.id,
        options: { idFrom: value.idFrom === "name" ? "name" : "string" },
      };
    }
    return { id: String(value), options: { idFrom: "string" } };
  };

  const call = async (namespace, id, method, args = [], options = {}) => {
    if (typeof method !== "string" || !method) {
      throw new Error("Durable Object RPC method must be a non-empty string");
    }
    const callArgs = Array.isArray(args) ? args : [args];
    return await bridge.call(namespace, id, method, callArgs, options);
  };

  const getNamespace = (namespace) => {
    assertNamespace(namespace);
    return Object.freeze({
      idFromName: (id) => durableObjectId(id, "name"),
      idFromString: (id) => durableObjectId(id, "string"),
      get: (id) => {
        const normalized = normalizeDurableObjectId(id);
        return getStub(namespace, normalized.id, normalized.options);
      },
    });
  };

  return Object.freeze({
    namespaces,
    namespace: getNamespace,
    stub: getStub,
    call,
  });
}

async function runUserCode(DO, text) {
  "use strict";
`}${userCode}${String.raw`
}

export class AdminJsExecRunner extends WorkerEntrypoint {
  async run() {
    const output = [];
    globalThis.console = createOutputConsole(output);
    const DO = createDoFacade(this.env.${ADMIN_JS_EXEC_DO_BRIDGE_BINDING}, this.env.${ADMIN_JS_EXEC_DO_NAMESPACES_BINDING});
    const text = (value) => output.push(stringifyOutput(value));
    const startedAt = Date.now();
    const result = await runUserCode(DO, text);
    return {
      result: serializeResult(result),
      output,
      namespaces: DO.namespaces,
      duration_ms: Date.now() - startedAt,
    };
  }
}
`}`;
}

function truncateText(value: string, maxCharacters: number): string {
  return value.length > maxCharacters
    ? `${value.slice(0, maxCharacters)}\n...[truncated]`
    : value;
}

function truncateAdminJsExecResult(result: unknown, maxCharacters: number): unknown {
  const text = JSON.stringify(result, null, 2);
  if (text.length <= maxCharacters) return result;
  return {
    truncated: true,
    text: truncateText(text, maxCharacters),
  };
}

async function adminJsExecTool(
  ctx: ExecutionContext,
  env: Env,
  args: Record<string, unknown>,
) {
  const code = stringArg(args, "code");
  if (!code) {
    return toolText({ error: "code is required" }, true);
  }

  const loader = env.CODE_MODE_LOADER as
    | (WorkerLoader & { load?: (code: WorkerLoaderWorkerCode) => WorkerStub })
    | undefined;
  if (!loader) {
    return toolText({ error: "CODE_MODE_LOADER binding is not configured" }, true);
  }

  const timeoutMs = clampInteger(
    args.timeout_ms,
    ADMIN_JS_EXEC_DEFAULT_TIMEOUT_MS,
    100,
    ADMIN_JS_EXEC_MAX_TIMEOUT_MS,
  );
  const maxOutputCharacters = clampInteger(
    args.max_output_characters,
    ADMIN_JS_EXEC_DEFAULT_MAX_OUTPUT_CHARACTERS,
    1000,
    ADMIN_JS_EXEC_MAX_OUTPUT_CHARACTERS,
  );
  const doBridge = createAdminJsExecDoBridge(ctx, env);
  if (!doBridge) {
    return toolText({ error: "AdminJsExecDoBinding export is not available" }, true);
  }
  if (!doBridge.namespaces.length) {
    return toolText({ error: "No Durable Object namespace bindings are available" }, true);
  }

  const workerCode: WorkerLoaderWorkerCode = {
    compatibilityDate: ADMIN_JS_EXEC_COMPATIBILITY_DATE,
    mainModule: "index.js",
    modules: {
      "index.js": { js: adminJsExecWorkerModule(code) },
    },
    env: {
      [ADMIN_JS_EXEC_DO_BRIDGE_BINDING]: doBridge.binding,
      [ADMIN_JS_EXEC_DO_NAMESPACES_BINDING]: doBridge.namespaces,
    },
    globalOutbound: null,
  };
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const worker = typeof loader.load === "function"
      ? loader.load(workerCode)
      : loader.get(`admin-js-exec-${crypto.randomUUID()}`, () => workerCode);
    const runner = worker.getEntrypoint("AdminJsExecRunner") as unknown as {
      run(): Promise<{
        result?: unknown;
        output?: unknown;
        namespaces?: unknown;
        duration_ms?: unknown;
      }>;
    };
    const runPromise = runner.run();
    const result = await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`JavaScript execution timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return toolText(truncateAdminJsExecResult({
      success: true,
      duration_ms: result.duration_ms,
      namespaces: result.namespaces,
      output: result.output,
      result: result.result,
    }, maxOutputCharacters));
  } catch (error) {
    return toolText(
      {
        error: error instanceof Error ? error.message : "JavaScript execution failed",
        stack: error instanceof Error ? error.stack : undefined,
      },
      true,
    );
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function getAdminThreadContext(env: Env, threadId: string): Promise<AdminThreadContext | null> {
  const adminIndex = getAdminIndexStub(env) as unknown as AdminThreadContextLookup;
  return adminIndex.getThreadContextById(threadId);
}

function messagesToJsonl(messages: unknown[]): string {
  if (messages.length === 0) return "";
  return `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
}

function sanitizeFilename(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized || "thread";
}

async function getThreadJsonlTool(env: Env, args: Record<string, unknown>) {
  const threadId = requiredStringArg(args, "thread_id");
  if (typeof threadId !== "string") return toolText(threadId, true);

  const threadContext = await getAdminThreadContext(env, threadId);
  if (!threadContext) {
    return toolText({ error: "Thread not found" }, true);
  }

  const orgStub = env.ORG.get(env.ORG.idFromName(threadContext.org_id)) as unknown as {
    getThread(threadId: string): Promise<{ workspace_id?: string | null } | null> | { workspace_id?: string | null } | null;
  };
  const thread = await Promise.resolve(orgStub.getThread(threadId));
  if (!thread || thread.workspace_id !== threadContext.workspace_id) {
    return toolText({ error: "Thread not found" }, true);
  }

  const chatThreadStub = getChatThreadParsedMessagesStub(env, threadId);
  if (!chatThreadStub || typeof chatThreadStub.getPiCoreParsedMessages !== "function") {
    return toolText({ error: "CHAT_THREAD binding is not available" }, true);
  }

  const messages = await Promise.resolve(chatThreadStub.getPiCoreParsedMessages(threadId));
  const parsedMessages = Array.isArray(messages) ? messages : [];
  const jsonl = messagesToJsonl(parsedMessages);
  return {
    content: [{ type: "text", text: jsonl }],
    structuredContent: {
      success: true,
      thread_id: threadId,
      org_id: threadContext.org_id,
      workspace_id: threadContext.workspace_id,
      filename: `${sanitizeFilename(threadId)}.jsonl`,
      content_type: "application/x-ndjson; charset=utf-8",
      message_count: parsedMessages.length,
    },
  };
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

async function grantOrgCreditsTool(
  env: Env,
  grant: AdminMcpTokenGrantRecord,
  args: Record<string, unknown>,
) {
  const orgId = requiredStringArg(args, "org_id");
  if (typeof orgId !== "string") return toolText(orgId, true);

  const amountCents = integerArg(args, "amount_cents");
  if (amountCents === null || amountCents <= 0) {
    return toolText({ error: "amount_cents must be a positive integer" }, true);
  }

  const reason = stringArg(args, "reason");
  const idempotencyKey = stringArg(args, "idempotency_key");
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const orgInfo = await orgStub.getInfo();
  if (!orgInfo) {
    return toolText({ error: "Organization not found" }, true);
  }

  const result = await orgStub.applyManualCreditGrant(
    amountCents,
    reason,
    idempotencyKey,
    { createdBy: grant.user_id, source: "admin-mcp" },
  );
  if (!result) {
    return toolText({ error: "Credit grant amount must be positive" }, true);
  }

  return toolText({
    success: true,
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
}

async function callTool(
  req: Request,
  ctx: ExecutionContext,
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
  if (name === TOOL_QUERY_CHAT_ERRORS) {
    return fetchAdminApiTool(req, env, grant, {
      method: "GET",
      path: "/api/admin/chat-errors",
      query: pickQuery(input, [
        "range",
        "from",
        "to",
        "fingerprint",
        "org_id",
        "workspace_id",
        "thread_id",
        "user_id",
        "source",
        "error_kind",
        "provider",
        "model",
        "status",
        "search",
        "limit",
        "offset",
        "threads_limit",
        "threads_offset",
        "events_limit",
        "events_offset",
        "include_threads",
        "include_events",
        "include_breakdowns",
        "sort_by",
        "sort_dir",
      ]),
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
  if (name === TOOL_GET_THREAD_JSONL) {
    return getThreadJsonlTool(env, input);
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
  if (name === TOOL_MIGRATE_VM_PROJECTS) {
    const workspaceId = requiredStringArg(input, "workspace_id");
    if (typeof workspaceId !== "string") return toolText(workspaceId, true);
    return fetchAdminApiTool(req, env, grant, {
      method: "POST",
      path: `/api/admin/workspaces/${encodeURIComponent(workspaceId)}/project-vm-migration`,
      body: {
        ...pickBody(input, ["project", "max_file_bytes", "max_project_bytes", "force", "lift_nested_root"]),
        dry_run: input.dry_run === false ? false : true,
      },
    });
  }
  if (name === TOOL_VERIFY_PROJECT_BUILD) {
    const workspaceId = requiredStringArg(input, "workspace_id");
    if (typeof workspaceId !== "string") return toolText(workspaceId, true);
    return fetchAdminApiTool(req, env, grant, {
      method: "POST",
      path: `/api/admin/workspaces/${encodeURIComponent(workspaceId)}/project-build-verify`,
      body: pickBody(input, ["project", "org_id", "timeout_ms"]),
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
  if (name === TOOL_GRANT_ORG_CREDITS) {
    return grantOrgCreditsTool(env, grant, input);
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
  if (name === TOOL_ADMIN_JS_EXEC) {
    return adminJsExecTool(ctx, env, input);
  }
  if (name === TOOL_ADMIN_API_REQUEST) {
    return fetchAdminApiTool(req, env, grant, args);
  }
  return toolText({ error: `Unknown tool: ${String(name)}` }, true);
}

async function handleJsonRpcRequest(
  rpc: JsonRpcRequest,
  req: Request,
  ctx: ExecutionContext,
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
        await callTool(req, ctx, env, grant, params.name, params.arguments),
      );
    }
    default:
      return jsonRpcError(rpc.id, -32601, "Method not found");
  }
}

function isNotificationOrResponse(rpc: JsonRpcRequest): boolean {
  return rpc.id === undefined;
}

async function handlePost(
  req: Request,
  ctx: ExecutionContext,
  env: Env,
  grant: AdminMcpTokenGrantRecord,
): Promise<Response> {
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
      .map((rpc) => handleJsonRpcRequest(rpc, req, ctx, env, grant)),
  );

  return Response.json(Array.isArray(payload) ? responses : responses[0], {
    headers: JSON_HEADERS,
  });
}

export async function handleAdminMcp({ req, ctx, env }: RouteContext): Promise<Response | null> {
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

  return handlePost(req, ctx, env, auth);
}
