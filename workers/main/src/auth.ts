import { DurableObject } from "cloudflare:workers";
import { hashPassword, verifyPassword } from "./password";
import {
  generateDefaultAvatar,
  validateAvatarContent,
} from "../../../src/lib/avatar";
import { DEFAULT_THREAD_TITLE } from "../../../src/lib/thread-title";
import { slugifyWorkspaceName } from "../../../src/lib/workspace-email";
import type {
  OrgRole,
  BillingStatus,
  User,
  Organization,
  OrganizationExperimentalSettings,
  Workspace,
  ChatHarness,
  LlmModel,
  OnboardingPreferences,
} from "../../../src/types";
import type { ChatThreadDO } from "./durable-objects";
import { WorkspaceDO } from "./workspace";
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_ORG_EXPERIMENTAL_SETTINGS,
  normalizeLlmModel,
  parseOrganizationExperimentalSettings,
} from "../../../src/lib/llm-provider-config";
import {
  getBillingPlanLimits,
  getOrgBillingPlan,
  getOrgSeatLimit,
  isTeamSeatBillingSyncable,
  normalizeBillingPlan,
  normalizeSeatCount,
} from "../../../src/lib/billing-plans";

// Re-export for consumers that import from this module
export type { OrgRole, BillingStatus } from "../../../src/types";

// Environment bindings needed by auth Durable Objects
export interface DOEnv {
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  ADMIN_INDEX: DurableObjectNamespace<
    import("./admin-index-do.js").AdminIndexDO
  >;
  EMAIL_TO_USER: KVNamespace;
  APP_KV: KVNamespace;
}

const SUPERUSER_EMAILS = new Set(["admin@example.com", "1033072+Vercantez@users.noreply.github.com"]);
const USER_ONBOARDING_KEY = "onboarding";
const USER_SIGNUP_IP_KEY = "signup_ip";
const ORG_EXPERIMENTAL_SETTINGS_KEY = "experimental_settings";

function isSuperuserEmail(email: string | null): boolean {
  if (!email) return false;
  return SUPERUSER_EMAILS.has(email.toLowerCase());
}

const ORG_INDEX_PREFIX = "org_index:";
const ORG_SLUG_KV_PREFIX = "org_slug:";
const CUSTOM_DOMAIN_HOST_PREFIX = "custom_domain_host:";

async function hashOrgSlug(orgId: string): Promise<string> {
  const data = new TextEncoder().encode(orgId);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let slug = "";
  for (let i = 0; i < 6; i++) {
    slug += chars[bytes[i] % chars.length];
  }
  return slug;
}

async function generateUniqueOrgSlug(
  orgId: string,
  kv: KVNamespace,
): Promise<string> {
  const baseSlug = await hashOrgSlug(orgId);
  const existing = await kv.get(`${ORG_SLUG_KV_PREFIX}${baseSlug}`);
  if (!existing || existing === orgId) return baseSlug;

  // Collision: append incrementing suffix
  for (let i = 2; i <= 99; i++) {
    const candidate = `${baseSlug}${i}`;
    const owner = await kv.get(`${ORG_SLUG_KV_PREFIX}${candidate}`);
    if (!owner || owner === orgId) return candidate;
  }
  throw new Error("slug_generation_failed");
}

async function registerOrgSlug(
  kv: KVNamespace,
  slug: string,
  orgId: string,
): Promise<void> {
  await kv.put(`${ORG_SLUG_KV_PREFIX}${slug}`, orgId);
}

import type { AdminEventType } from "./admin-index-do.js";

export function dispatchAdminEvent(
  ctx: DurableObjectState,
  env: DOEnv,
  event: AdminEventType,
) {
  try {
    ctx.waitUntil(
      env.ADMIN_INDEX.get(env.ADMIN_INDEX.idFromName("admin_index"))
        .handleEvent(event)
        .catch((err) => console.error("AdminIndex sync failed:", err)),
    );
  } catch (err) {
    console.error("Failed to dispatch to AdminIndex", err);
  }
}

function toOnboardingPreferences(raw: unknown): OnboardingPreferences | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Partial<OnboardingPreferences> & Record<string, unknown>;
  const completedAt =
    typeof value.completed_at === "number" || value.completed_at === null
      ? value.completed_at
      : null;
  return {
    completed_at: completedAt ?? null,
  };
}

function getDefaultOnboardingPreferences(): OnboardingPreferences {
  return {
    completed_at: null,
  };
}

function normalizeCompletedAt(
  value: OnboardingPreferences["completed_at"],
): OnboardingPreferences["completed_at"] {
  if (value === null) {
    return null;
  }

  return Number.isFinite(value) ? value : null;
}

function sanitizeOnboardingPreferences(
  input: OnboardingPreferences,
): OnboardingPreferences {
  const next =
    toOnboardingPreferences(input) ?? getDefaultOnboardingPreferences();
  return {
    completed_at: normalizeCompletedAt(next.completed_at),
  };
}

export interface UserOrg {
  org_id: string;
  role: OrgRole;
  joined_at: number;
  last_workspace_id: string | null;
}

export interface UserAuthBootstrap {
  profile: User | null;
  onboarding: OnboardingPreferences | null;
  orgs: UserOrg[];
  emailVerification: { required: boolean; verified: boolean };
  /** Timestamp when all sessions were invalidated (e.g. on logout). Null if never invalidated. */
  sessionInvalidatedAt: number | null;
}

export type OAuthProvider = "google" | "github";

export interface UserOAuthProvider {
  provider: OAuthProvider;
  provider_id: string;
  linked_at: number;
}

export interface OrgMember {
  user_id: string;
  role: OrgRole;
  joined_at: number;
}

export interface OrgInvitation {
  id: string;
  email: string;
  role: OrgRole;
  invited_by: string;
  created_at: number;
  expires_at: number;
  workspace_access?: Record<string, "full" | "none"> | null;
}

export interface OrgIntegrationRecord {
  id: string;
  integration_type: string;
  name: string;
  category: string;
  auth_method: string;
  config: string;
  credentials_encrypted: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export type WorkerScriptPreviewStatus = "pending" | "ready" | "failed";

export interface WorkerScript {
  script_name: string;
  workspace_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  is_public: boolean;
  preview_key: string | null;
  preview_updated_at: number | null;
  preview_status: WorkerScriptPreviewStatus | null;
  preview_error: string | null;
  config_path: string | null;
  custom_domain_hostname: string | null;
  custom_domain_cf_hostname_id: string | null;
  custom_domain_status: string | null;
  custom_domain_ssl_status: string | null;
  custom_domain_error: string | null;
  custom_domain_updated_at: number | null;
}

export interface WorkerScriptPreviewUpdateInput {
  status: WorkerScriptPreviewStatus;
  preview_key?: string | null;
  preview_error?: string | null;
  preview_updated_at?: number;
  deploy_ts?: number;
}

export interface WorkerScriptPreviewUpdateResult {
  script: WorkerScript | null;
  updated: boolean;
  stale: boolean;
}

export interface WorkerScriptCustomDomainUpdateInput {
  hostname: string | null;
  cf_hostname_id?: string | null;
  status?: string | null;
  ssl_status?: string | null;
  error?: string | null;
  updated_at?: number;
  deploy_ts?: number;
}

interface WorkerScriptRow {
  [key: string]: SqlStorageValue;
  script_name: string;
  workspace_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  is_public: number;
  preview_key: string | null;
  preview_updated_at: number | null;
  preview_status: WorkerScriptPreviewStatus | null;
  preview_error: string | null;
  config_path: string | null;
  custom_domain_hostname: string | null;
  custom_domain_cf_hostname_id: string | null;
  custom_domain_status: string | null;
  custom_domain_ssl_status: string | null;
  custom_domain_error: string | null;
  custom_domain_updated_at: number | null;
}

export interface WorkerScriptAccess {
  script_name: string;
  workspace_id: string;
  org_id: string;
  is_public: boolean;
}

export type CustomDomainStatus = "pending" | "active" | "failed";

export interface CustomDomain {
  domain: string;
  cf_hostname_id: string | null;
  status: CustomDomainStatus;
  ssl_status: string | null;
  created_at: number;
  updated_at: number;
}

type CustomDomainRow = CustomDomain & Record<string, SqlStorageValue>;

function normalizeOrgBillingFields(info: Organization): boolean {
  let changed = false;
  if (!info.billing_status) {
    info.billing_status = "inactive";
    changed = true;
  }
  const normalizedPlan = normalizeBillingPlan(
    info.billing_plan,
    info.billing_status,
  );
  if (info.billing_plan !== normalizedPlan) {
    info.billing_plan = normalizedPlan;
    changed = true;
  }
  const normalizedSeats = normalizeSeatCount(
    normalizedPlan,
    info.billing_seat_count,
  );
  if (info.billing_seat_count !== normalizedSeats) {
    info.billing_seat_count = normalizedSeats;
    changed = true;
  }
  return changed;
}

export interface OrgThread {
  id: string;
  workspace_id: string;
  title: string;
  provider: "claude" | "codex";
  created_by: string;
  model: LlmModel;
  created_at: number;
  updated_at: number;
  user_message_count: number;
  first_user_message: string | null;
}

export type OrgChatThreadAccessResult =
  | {
      ok: true;
      orgId: string;
      orgSlug: string;
      threadId: string;
    }
  | {
      ok: false;
      reason: "org_not_found" | "forbidden" | "thread_not_found";
    };

export interface ProxyUsageInput {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface OrgBillingStateUpdate {
  billing_status?: BillingStatus;
  billing_plan?: Organization["billing_plan"];
  billing_seat_count?: number;
  billing_customer_id?: string | null;
  billing_subscription_id?: string | null;
  billing_subscription_status?: string | null;
  billing_trial_started_at?: number | null;
  billing_trial_ends_at?: number | null;
  billing_credit_purchase_total_cents?: number;
  billing_credit_grant_total_cents?: number;
  billing_trial_credit_grant_cents?: number;
  billing_trial_credit_granted_at?: number | null;
  billing_free_credit_grant_cents?: number;
  billing_free_credit_granted_at?: number | null;
  billing_last_included_credit_invoice_id?: string | null;
  billing_credit_usage_started_at?: number | null;
}

export interface SyncSubscriptionBillingStateResult {
  org: Organization;
  trialCreditGranted: boolean;
}

export interface ApplyCreditCheckoutResult {
  org: Organization;
  applied: boolean;
}

export interface ApplyManualCreditGrantResult {
  org: Organization;
  applied: boolean;
  grantId: string;
  amountCents: number;
  reason: string | null;
}

/**
 * Migration Pattern for Durable Objects
 * ======================================
 *
 * Schema version is tracked in sync KV (`ctx.storage.kv`) under key `schemaVersion`.
 * Existing DOs fall back to the legacy `_schema_version` SQL table on first load,
 * then persist the version to KV going forward.
 *
 * To add a new migration:
 * 1. Add a new `if (version < N)` block in the `migrate()` method
 * 2. Put your schema changes inside the block
 * 3. Bump `CURRENT_SCHEMA_VERSION` at the bottom of `migrate()`
 */

// User Durable Object - one per user
export class UserDO extends DurableObject<DOEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: DOEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private getSchemaVersionValue(): number {
    const storedVersion = this.ctx.storage.kv.get<number>("schemaVersion");
    if (typeof storedVersion === "number") {
      return storedVersion;
    }

    try {
      const rows = this.sql
        .exec<{
          version: number;
        }>("SELECT MAX(version) AS version FROM _schema_version")
        .toArray();
      return rows[0]?.version ?? 0;
    } catch {
      return 0;
    }
  }

  private migrate() {
    // Read version from sync KV, falling back to legacy SQL table for existing DOs.
    const version = this.getSchemaVersionValue();

    if (version < 1) {
      // V1: Fresh start
      this.sql.exec("DROP TABLE IF EXISTS profile");
      this.sql.exec("DROP TABLE IF EXISTS orgs");
      this.sql.exec("DROP TABLE IF EXISTS projects");
      this.sql.exec(`
        CREATE TABLE profile (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE orgs (
          org_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          last_workspace_id TEXT
        )
      `);
      this.sql.exec(`
        CREATE TABLE projects (
          org_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (org_id, project_id)
        )
      `);
    }

    if (version < 2) {
      const rows = this.sql
        .exec("SELECT value FROM profile WHERE key = ?", "data")
        .toArray();
      if (rows.length > 0) {
        const profile = JSON.parse(
          (rows[0] as { value: string }).value,
        ) as User;
        const shouldBeSuperuser = isSuperuserEmail(profile.email);
        if (profile.is_superuser !== shouldBeSuperuser) {
          profile.is_superuser = shouldBeSuperuser;
          this.sql.exec(
            "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
            "data",
            JSON.stringify(profile),
          );
        }
      }
    }

    if (version < 3) {
      // V3: Remove projects table - projects feature removed
      this.sql.exec("DROP TABLE IF EXISTS projects");
    }

    if (version < 4) {
      const rows = this.sql
        .exec("SELECT value FROM profile WHERE key = ?", "data")
        .toArray();
      if (rows.length > 0) {
        const profile = JSON.parse(
          (rows[0] as { value: string }).value,
        ) as User;
        if (!profile.avatar) {
          profile.avatar = generateDefaultAvatar(profile.name || profile.email);
        }
        if (typeof profile.is_orphaned !== "boolean")
          profile.is_orphaned = false;
        if (profile.orphaned_at === undefined) profile.orphaned_at = null;
        this.sql.exec(
          "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
          "data",
          JSON.stringify(profile),
        );
      }
    }

    if (version < 5) {
      try {
        this.sql.exec("ALTER TABLE orgs ADD COLUMN last_workspace_id TEXT");
      } catch {
        // Column may already exist in fresh databases.
      }
    }

    if (version < 6) {
      // V6: Add oauth_providers table for OAuth sign-in support
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS oauth_providers (
          provider TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          linked_at INTEGER NOT NULL,
          PRIMARY KEY (provider)
        )
      `);
    }

    // V7: Reserve profile keys for onboarding state. No schema changes needed.

    if (version < 8) {
      // V8: Track email verification status on profiles.
      const rows = this.sql
        .exec("SELECT value FROM profile WHERE key = ?", "data")
        .toArray();
      if (rows.length > 0) {
        const profile = JSON.parse(
          (rows[0] as { value: string }).value,
        ) as User;
        if (profile.email_verified_at === undefined) {
          // Backfill legacy accounts as verified so this remains non-breaking.
          profile.email_verified_at = profile.created_at ?? Date.now();
          this.sql.exec(
            "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
            "data",
            JSON.stringify(profile),
          );
        }
      }
    }

    const CURRENT_SCHEMA_VERSION = 8;
    if (version < CURRENT_SCHEMA_VERSION) {
      this.ctx.storage.kv.put("schemaVersion", CURRENT_SCHEMA_VERSION);
    }
  }

  // Profile methods
  async getProfile(): Promise<User | null> {
    const rows = this.sql
      .exec("SELECT value FROM profile WHERE key = ?", "data")
      .toArray();
    if (rows.length === 0) return null;
    const profile = JSON.parse((rows[0] as { value: string }).value) as User;
    let changed = false;

    if (typeof profile.is_superuser !== "boolean") {
      profile.is_superuser = isSuperuserEmail(profile.email);
      changed = true;
    }
    if (!profile.avatar) {
      profile.avatar = generateDefaultAvatar(profile.name || profile.email);
      changed = true;
    }
    if (typeof profile.is_orphaned !== "boolean") {
      profile.is_orphaned = false;
      changed = true;
    }
    if (profile.orphaned_at === undefined) {
      profile.orphaned_at = null;
      changed = true;
    }
    if (profile.email_verified_at === undefined) {
      // Legacy accounts pre-date verification and are treated as verified.
      profile.email_verified_at = profile.created_at ?? Date.now();
      changed = true;
    }

    if (changed) {
      await this.setProfile(profile);
    }
    return profile;
  }

  async getAuthBootstrap(): Promise<UserAuthBootstrap> {
    const [profile, onboarding, orgs, passwordHash] = await Promise.all([
      this.getProfile(),
      this.getOnboarding(),
      this.getOrgs(),
      this.getPasswordHash(),
    ]);
    const emailVerification = {
      required: Boolean(passwordHash),
      verified: profile?.email_verified_at != null,
    };
    const sessionInvalidatedAt =
      this.ctx.storage.kv.get<number>("sessionInvalidatedAt") ?? null;
    return {
      profile,
      onboarding,
      orgs,
      emailVerification,
      sessionInvalidatedAt,
    };
  }

  /**
   * Invalidate all outstanding signed sessions for this user.
   * Any session created before this timestamp will be rejected.
   */
  invalidateSessions(): void {
    this.ctx.storage.kv.put("sessionInvalidatedAt", Date.now());
  }

  /**
   * Get the session invalidation timestamp. Returns null if never invalidated.
   */
  getSessionInvalidatedAt(): number | null {
    return this.ctx.storage.kv.get<number>("sessionInvalidatedAt") ?? null;
  }

  setPendingSalesPrompt(prompt: string): void {
    this.ctx.storage.kv.put("pendingSalesPrompt", prompt);
  }

  getPendingSalesPrompt(): string | null {
    return this.ctx.storage.kv.get<string>("pendingSalesPrompt") ?? null;
  }

  clearPendingSalesPrompt(): void {
    this.ctx.storage.kv.delete("pendingSalesPrompt");
  }

  async setProfile(profile: User): Promise<void> {
    this.sql.exec(
      "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
      "data",
      JSON.stringify(profile),
    );
    dispatchAdminEvent(this.ctx, this.env, {
      type: "user_upsert",
      payload: profile,
    });
  }

  async getPasswordHash(): Promise<string | null> {
    const rows = this.sql
      .exec("SELECT value FROM profile WHERE key = ?", "password_hash")
      .toArray();
    if (rows.length === 0) return null;
    return (rows[0] as { value: string }).value;
  }

  async setPasswordHash(hash: string): Promise<void> {
    this.sql.exec(
      "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
      "password_hash",
      hash,
    );
  }

  async verifyPassword(password: string): Promise<boolean> {
    const hash = await this.getPasswordHash();
    if (!hash) return false;
    return verifyPassword(password, hash);
  }

  getSignupIp(): string | null {
    const rows = this.sql
      .exec("SELECT value FROM profile WHERE key = ?", USER_SIGNUP_IP_KEY)
      .toArray();
    if (rows.length === 0) return null;
    return (rows[0] as { value: string }).value;
  }

  setSignupIp(ip: string): void {
    const normalizedIp = ip.trim().toLowerCase();
    if (!normalizedIp) return;
    this.sql.exec(
      "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
      USER_SIGNUP_IP_KEY,
      normalizedIp,
    );
  }

  async createUser(
    id: string,
    email: string,
    password: string,
    name: string | null,
    signupIp: string | null = null,
  ): Promise<User> {
    const now = Date.now();
    const avatar = generateDefaultAvatar(name || email);
    const profile: User = {
      id,
      email,
      email_verified_at: null,
      name,
      created_at: now,
      is_superuser: isSuperuserEmail(email),
      avatar,
      is_orphaned: false,
      orphaned_at: null,
    };
    const passwordHash = await hashPassword(password);

    await this.setProfile(profile);
    await this.setPasswordHash(passwordHash);
    if (signupIp) {
      this.setSignupIp(signupIp);
      // Re-dispatch with signup_ip so AdminIndexDO can index it
      dispatchAdminEvent(this.ctx, this.env, {
        type: "user_upsert",
        payload: { ...profile, signup_ip: signupIp },
      });
    }

    return profile;
  }

  async setOrphaned(isOrphaned: boolean): Promise<void> {
    const profile = await this.getProfile();
    if (!profile) return;
    profile.is_orphaned = isOrphaned;
    profile.orphaned_at = isOrphaned ? Date.now() : null;
    await this.setProfile(profile);
  }

  async markEmailVerified(): Promise<User | null> {
    const profile = await this.getProfile();
    if (!profile) return null;
    if (profile.email_verified_at === null) {
      profile.email_verified_at = Date.now();
      await this.setProfile(profile);
    }
    return profile;
  }

  async getEmailVerificationStatus(): Promise<{
    required: boolean;
    verified: boolean;
    email_verified_at: number | null;
  }> {
    const profile = await this.getProfile();
    if (!profile) {
      return { required: false, verified: false, email_verified_at: null };
    }

    // Password-based accounts require verification. OAuth-only accounts do not.
    const hasPassword = Boolean(await this.getPasswordHash());
    const verified = profile.email_verified_at !== null;
    return {
      required: hasPassword,
      verified,
      email_verified_at: profile.email_verified_at,
    };
  }

  async updateProfile(updates: {
    name?: string | null;
    avatar?: { color?: string; content?: string };
    is_superuser?: boolean;
  }): Promise<User | null> {
    const profile = await this.getProfile();
    if (!profile) return null;

    let changed = false;

    if (updates.name !== undefined && updates.name !== profile.name) {
      profile.name = updates.name;
      changed = true;
    }

    if (
      updates.avatar?.color &&
      updates.avatar.color !== profile.avatar.color
    ) {
      profile.avatar.color = updates.avatar.color;
      changed = true;
    }

    if (
      updates.avatar?.content &&
      updates.avatar.content !== profile.avatar.content
    ) {
      const trimmed = updates.avatar.content.trim();
      if (!validateAvatarContent(trimmed)) {
        throw new Error("Invalid avatar content");
      }
      profile.avatar.content = trimmed;
      changed = true;
    }

    if (
      updates.is_superuser !== undefined &&
      updates.is_superuser !== profile.is_superuser
    ) {
      profile.is_superuser = updates.is_superuser;
      changed = true;
    }

    if (changed) {
      await this.setProfile(profile);
    }

    return profile;
  }

  async getOnboarding(): Promise<OnboardingPreferences | null> {
    const rows = this.sql
      .exec("SELECT value FROM profile WHERE key = ?", USER_ONBOARDING_KEY)
      .toArray() as Array<{ value: string }>;
    if (rows.length === 0) {
      return null;
    }

    try {
      return toOnboardingPreferences(JSON.parse(rows[0].value));
    } catch {
      return null;
    }
  }

  async updateOnboarding(
    input: OnboardingPreferences,
  ): Promise<OnboardingPreferences> {
    const next = sanitizeOnboardingPreferences(input);
    this.sql.exec(
      "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
      USER_ONBOARDING_KEY,
      JSON.stringify(next),
    );
    return next;
  }

  async resetOnboarding(): Promise<OnboardingPreferences> {
    const next = getDefaultOnboardingPreferences();
    this.sql.exec(
      "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
      USER_ONBOARDING_KEY,
      JSON.stringify(next),
    );
    return next;
  }

  // Org membership methods
  async getOrgs(): Promise<UserOrg[]> {
    return this.sql
      .exec(
        "SELECT org_id, role, joined_at, last_workspace_id FROM orgs ORDER BY joined_at ASC",
      )
      .toArray() as unknown as UserOrg[];
  }

  async addOrg(
    orgId: string,
    role: OrgRole,
    lastWorkspaceId: string | null = null,
  ): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      "INSERT OR REPLACE INTO orgs (org_id, role, joined_at, last_workspace_id) VALUES (?, ?, ?, ?)",
      orgId,
      role,
      now,
      lastWorkspaceId,
    );
    const profile = await this.getProfile();
    if (profile)
      dispatchAdminEvent(this.ctx, this.env, {
        type: "user_org_delta",
        payload: { user_id: profile.id, delta: 1 },
      });
  }

  async removeOrg(orgId: string): Promise<void> {
    this.sql.exec("DELETE FROM orgs WHERE org_id = ?", orgId);
    const profile = await this.getProfile();
    if (profile)
      dispatchAdminEvent(this.ctx, this.env, {
        type: "user_org_delta",
        payload: { user_id: profile.id, delta: -1 },
      });
  }

  async updateOrgRole(orgId: string, role: OrgRole): Promise<void> {
    this.sql.exec("UPDATE orgs SET role = ? WHERE org_id = ?", role, orgId);
  }

  async setOrgLastWorkspace(
    orgId: string,
    workspaceId: string | null,
  ): Promise<void> {
    this.sql.exec(
      "UPDATE orgs SET last_workspace_id = ? WHERE org_id = ?",
      workspaceId,
      orgId,
    );
  }

  async hasOrg(orgId: string): Promise<boolean> {
    const rows = this.sql
      .exec("SELECT 1 FROM orgs WHERE org_id = ?", orgId)
      .toArray();
    return rows.length > 0;
  }

  async getOrgRole(orgId: string): Promise<OrgRole | null> {
    const rows = this.sql
      .exec("SELECT role FROM orgs WHERE org_id = ?", orgId)
      .toArray();
    if (rows.length === 0) return null;
    return (rows[0] as { role: string }).role as OrgRole;
  }

  // OAuth provider methods
  async getOAuthProviders(): Promise<UserOAuthProvider[]> {
    return this.sql
      .exec(
        "SELECT provider, provider_id, linked_at FROM oauth_providers ORDER BY linked_at ASC",
      )
      .toArray() as unknown as UserOAuthProvider[];
  }

  async getOAuthProvider(
    provider: OAuthProvider,
  ): Promise<UserOAuthProvider | null> {
    const rows = this.sql
      .exec(
        "SELECT provider, provider_id, linked_at FROM oauth_providers WHERE provider = ?",
        provider,
      )
      .toArray() as unknown as UserOAuthProvider[];
    return rows[0] || null;
  }

  async linkOAuthProvider(
    provider: OAuthProvider,
    providerId: string,
  ): Promise<UserOAuthProvider> {
    const now = Date.now();
    this.sql.exec(
      "INSERT OR REPLACE INTO oauth_providers (provider, provider_id, linked_at) VALUES (?, ?, ?)",
      provider,
      providerId,
      now,
    );
    return { provider, provider_id: providerId, linked_at: now };
  }

  async unlinkOAuthProvider(provider: OAuthProvider): Promise<void> {
    this.sql.exec("DELETE FROM oauth_providers WHERE provider = ?", provider);
  }

  async hasOAuthProvider(provider: OAuthProvider): Promise<boolean> {
    const rows = this.sql
      .exec("SELECT 1 FROM oauth_providers WHERE provider = ?", provider)
      .toArray();
    return rows.length > 0;
  }

  /**
   * Create a user from OAuth sign-in (no password required).
   */
  async createUserFromOAuth(
    id: string,
    email: string,
    name: string | null,
    provider: OAuthProvider,
    providerId: string,
    signupIp: string | null = null,
  ): Promise<User> {
    const now = Date.now();
    const avatar = generateDefaultAvatar(name || email);
    const profile: User = {
      id,
      email,
      email_verified_at: now,
      name,
      created_at: now,
      is_superuser: isSuperuserEmail(email),
      avatar,
      is_orphaned: false,
      orphaned_at: null,
    };

    await this.setProfile(profile);
    await this.linkOAuthProvider(provider, providerId);
    if (signupIp) {
      this.setSignupIp(signupIp);
      // Re-dispatch with signup_ip so AdminIndexDO can index it
      dispatchAdminEvent(this.ctx, this.env, {
        type: "user_upsert",
        payload: { ...profile, signup_ip: signupIp },
      });
    }

    return profile;
  }

  /**
   * Compatibility probe for admin hard-delete flow.
   * Exists so callers can verify RPC availability before destructive cleanup.
   */
  async canHardDeleteUser(): Promise<boolean> {
    return true;
  }

  /**
   * Permanently delete all data in this UserDO.
   * Wipes profile, org memberships, OAuth providers, onboarding, and password.
   */
  async hardDeleteUser(): Promise<void> {
    this.sql.exec("DELETE FROM profile");
    this.sql.exec("DELETE FROM orgs");
    this.sql.exec("DELETE FROM oauth_providers");
  }

  // Test helper RPC: simulate constructor migration path on an existing DO.
  async remigrate(): Promise<void> {
    this.migrate();
  }

  // Test helper RPC: expose the current schema version used by migration logic.
  async getSchemaVersion(): Promise<number> {
    return this.getSchemaVersionValue();
  }
}

// Organization Durable Object - one per org
export class OrgDO extends DurableObject<DOEnv> {
  private sql: SqlStorage;
  private workerScriptsHasPreviewColumns = true;

  constructor(ctx: DurableObjectState, env: DOEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private getOrgIndexKey(orgId: string): string {
    return `${ORG_INDEX_PREFIX}${orgId}`;
  }

  private async indexOrg(orgId: string): Promise<void> {
    await this.env.APP_KV.put(this.getOrgIndexKey(orgId), "1");
  }

  private async unindexOrg(orgId: string): Promise<void> {
    await this.env.APP_KV.delete(this.getOrgIndexKey(orgId));
  }

  private migrate() {
    // Read version from sync KV, falling back to legacy SQL table for existing DOs.
    let version = this.ctx.storage.kv.get<number>("schemaVersion") ?? null;
    if (version === null) {
      try {
        const rows = this.sql
          .exec<{
            version: number;
          }>("SELECT MAX(version) AS version FROM _schema_version")
          .toArray();
        version = rows[0]?.version ?? 0;
      } catch {
        version = 0;
      }
    }

    if (version < 1) {
      // V1: Fresh start
      this.sql.exec("DROP TABLE IF EXISTS org_info");
      this.sql.exec("DROP TABLE IF EXISTS members");
      this.sql.exec("DROP TABLE IF EXISTS invitations");
      this.sql.exec("DROP TABLE IF EXISTS integrations");
      this.sql.exec("DROP TABLE IF EXISTS workspaces");
      this.sql.exec("DROP TABLE IF EXISTS audit_log");
      this.sql.exec(`
        CREATE TABLE org_info (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE members (
          user_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          joined_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE invitations (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          role TEXT NOT NULL,
          invited_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE integrations (
          id TEXT PRIMARY KEY,
          integration_type TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          auth_method TEXT NOT NULL,
          config TEXT NOT NULL,
          credentials_encrypted TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 2) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          target_id TEXT,
          details TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      const rows = this.sql
        .exec("SELECT value FROM org_info WHERE key = ?", "data")
        .toArray();
      if (rows.length > 0) {
        const info = JSON.parse(
          (rows[0] as { value: string }).value,
        ) as Organization;
        normalizeOrgBillingFields(info);
        if (info.billing_customer_id === undefined)
          info.billing_customer_id = null;
        if (info.billing_subscription_id === undefined)
          info.billing_subscription_id = null;
        if (info.billing_subscription_status === undefined)
          info.billing_subscription_status = null;
        if (info.billing_trial_started_at === undefined)
          info.billing_trial_started_at = null;
        if (info.billing_trial_ends_at === undefined)
          info.billing_trial_ends_at = null;
        if (typeof info.billing_credit_purchase_total_cents !== "number") {
          info.billing_credit_purchase_total_cents = 0;
        }
        if (typeof info.billing_credit_grant_total_cents !== "number") {
          info.billing_credit_grant_total_cents = 0;
        }
        if (typeof info.billing_trial_credit_grant_cents !== "number") {
          info.billing_trial_credit_grant_cents = 0;
        }
        if (info.billing_trial_credit_granted_at === undefined) {
          info.billing_trial_credit_granted_at = null;
        }
        if (typeof info.billing_free_credit_grant_cents !== "number") {
          info.billing_free_credit_grant_cents = 0;
        }
        if (info.billing_free_credit_granted_at === undefined) {
          info.billing_free_credit_granted_at = null;
        }
        if (info.billing_last_included_credit_invoice_id === undefined) {
          info.billing_last_included_credit_invoice_id = null;
        }
        if (info.billing_credit_usage_started_at === undefined) {
          info.billing_credit_usage_started_at = null;
        }
        if (typeof info.archived !== "boolean") info.archived = false;
        if (info.archived_at === undefined) info.archived_at = null;
        if (info.archived_by === undefined) info.archived_by = null;
        this.sql.exec(
          "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
          "data",
          JSON.stringify(info),
        );
      }
    }

    if (version < 3) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS worker_scripts (
          script_name TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS worker_scripts_workspace_id ON worker_scripts(workspace_id)",
      );
    }

    if (version < 4) {
      // V4: Add is_public column to worker_scripts (default false = private)
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0",
        );
      } catch {
        // Column may already exist in fresh databases that ran V3 after this migration was added
      }
    }

    if (version < 5) {
      // V5: Add threads table (consolidated from ChatIndexDO)
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'web'
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS threads_workspace_id ON threads(workspace_id)",
      );
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS threads_updated_at ON threads(updated_at)",
      );
    }

    if (version < 6) {
      // V6: Ensure audit_log table exists (fix for DOs that may have skipped V2 migration)
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          target_id TEXT,
          details TEXT,
          created_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 7) {
      // V7: Add preview metadata fields to worker_scripts
      try {
        this.sql.exec("ALTER TABLE worker_scripts ADD COLUMN preview_key TEXT");
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN preview_updated_at INTEGER",
        );
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN preview_status TEXT DEFAULT 'pending'",
        );
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN preview_error TEXT",
        );
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec(
          "UPDATE worker_scripts SET preview_status = 'pending' WHERE preview_status IS NULL",
        );
      } catch {
        // Skip update if columns are unavailable (fallback queries will handle nulls)
      }
    }

    if (version < 8) {
      // V8: Proxy usage rollups per user
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS proxy_usage (
          user_id TEXT PRIMARY KEY,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
          requests INTEGER NOT NULL DEFAULT 0,
          last_provider TEXT,
          last_model TEXT,
          last_token_id TEXT,
          updated_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 9) {
      // V9: Schema consistency fix - ensure all tables and columns exist
      // This fixes DOs that may have skipped migrations due to version conflicts

      // Ensure all core tables exist
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS org_info (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS members (
          user_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          joined_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS invitations (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          role TEXT NOT NULL,
          invited_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS integrations (
          id TEXT PRIMARY KEY,
          integration_type TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          auth_method TEXT NOT NULL,
          config TEXT NOT NULL,
          credentials_encrypted TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          target_id TEXT,
          details TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS worker_scripts (
          script_name TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS worker_scripts_workspace_id ON worker_scripts(workspace_id)",
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'web'
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS threads_workspace_id ON threads(workspace_id)",
      );
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS threads_updated_at ON threads(updated_at)",
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS proxy_usage (
          user_id TEXT PRIMARY KEY,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
          requests INTEGER NOT NULL DEFAULT 0,
          last_provider TEXT,
          last_model TEXT,
          last_token_id TEXT,
          updated_at INTEGER NOT NULL
        )
      `);

      // Ensure all columns exist on worker_scripts
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec("ALTER TABLE worker_scripts ADD COLUMN preview_key TEXT");
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN preview_updated_at INTEGER",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN preview_status TEXT DEFAULT 'pending'",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN preview_error TEXT",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_hostname TEXT",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_cf_hostname_id TEXT",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_status TEXT",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_ssl_status TEXT",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_error TEXT",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_updated_at INTEGER",
        );
      } catch {
        // Column already exists
      }
    }

    if (version < 11) {
      // V11: Add config_path column to worker_scripts for tracking source directory
      try {
        this.sql.exec("ALTER TABLE worker_scripts ADD COLUMN config_path TEXT");
      } catch {
        // Column may already exist
      }
    }

    if (version < 12) {
      // V12: Slug backfill for existing orgs (already ran; new orgs get hash slugs via getInfo fallback)
    }

    if (version < 13) {
      // V13: Add workspace_access to invitations for pre-acceptance assignment,
      // and user_message_count to threads for admin visibility
      try {
        this.sql.exec(
          "ALTER TABLE invitations ADD COLUMN workspace_access TEXT",
        );
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec(
          "ALTER TABLE threads ADD COLUMN user_message_count INTEGER NOT NULL DEFAULT 0",
        );
      } catch {
        // Column may already exist
      }
    }

    if (version < 14) {
      // V14: Add first_user_message to threads for welcome screen preview
      try {
        this.sql.exec("ALTER TABLE threads ADD COLUMN first_user_message TEXT");
      } catch {
        // Column may already exist
      }
    }

    if (version < 15) {
      // V15: Add source column to threads (legacy; runtime treats all sources uniformly)
      try {
        this.sql.exec(
          "ALTER TABLE threads ADD COLUMN source TEXT NOT NULL DEFAULT 'web'",
        );
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec(
          "UPDATE threads SET source = 'web' WHERE source IS NULL OR source = ''",
        );
      } catch {
        // Best-effort backfill
      }
    }

    if (version < 17) {
      // V17: Roll back abandoned V16 workspace summary columns (avatar/content/created_by)
      // so OrgDO workspace schema returns to id/name/created_at/archived only.
      try {
        const workspaceColumns = this.sql
          .exec<{ name: string }>("PRAGMA table_info(workspaces)")
          .toArray();
        const names = new Set(workspaceColumns.map((row) => row.name));
        const hasLegacySummaryColumns =
          names.has("avatar_color") ||
          names.has("avatar_content") ||
          names.has("created_by");

        if (hasLegacySummaryColumns) {
          this.ctx.storage.transactionSync(() => {
            this.sql.exec("DROP TABLE IF EXISTS workspaces_v17_rollback");
            this.sql.exec(`
              CREATE TABLE workspaces_v17_rollback (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0
              )
            `);
            this.sql.exec(`
              INSERT INTO workspaces_v17_rollback (id, name, created_at, archived)
              SELECT id, name, created_at, archived FROM workspaces
            `);
            this.sql.exec("DROP TABLE workspaces");
            this.sql.exec(
              "ALTER TABLE workspaces_v17_rollback RENAME TO workspaces",
            );
          });
        }
      } catch (err) {
        console.error("[OrgDO] V17 rollback migration failed:", err);
        throw err;
      }
    }

    if (version < 18) {
      // V18: LLM provider BYOK config (bring your own API key)
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS llm_provider_config (
          id TEXT PRIMARY KEY DEFAULT 'active',
          provider TEXT NOT NULL,
          credentials_encrypted TEXT NOT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 19) {
      // V19: Legacy org-scoped custom domain table.
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS custom_domains (
          domain TEXT PRIMARY KEY,
          cf_hostname_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          ssl_status TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 20) {
      // V20: Per-app Cloudflare custom hostname state
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_hostname TEXT",
        );
      } catch {}
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_cf_hostname_id TEXT",
        );
      } catch {}
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_status TEXT",
        );
      } catch {}
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_ssl_status TEXT",
        );
      } catch {}
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_error TEXT",
        );
      } catch {}
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_updated_at INTEGER",
        );
      } catch {}
    }

    if (version < 21) {
      try {
        this.sql.exec(
          "ALTER TABLE threads ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'",
        );
      } catch {}
      try {
        this.sql.exec(
          "UPDATE threads SET provider = 'claude' WHERE provider IS NULL OR provider = ''",
        );
      } catch {}
      try {
        this.sql.exec(
          `ALTER TABLE threads ADD COLUMN model TEXT NOT NULL DEFAULT '${DEFAULT_LLM_MODEL}'`,
        );
      } catch {}
      try {
        this.sql.exec(
          `UPDATE threads SET model = '${DEFAULT_LLM_MODEL}' WHERE model IS NULL OR model = ''`,
        );
      } catch {}
    }

    if (version < 22) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS stripe_credit_checkouts (
          session_id TEXT PRIMARY KEY,
          amount_cents INTEGER NOT NULL,
          customer_id TEXT,
          created_at INTEGER NOT NULL
        )
      `);
    }

    const CURRENT_SCHEMA_VERSION = 22;
    if (version < CURRENT_SCHEMA_VERSION) {
      this.ctx.storage.kv.put("schemaVersion", CURRENT_SCHEMA_VERSION);
    }

    this.workerScriptsHasPreviewColumns =
      this.detectWorkerScriptPreviewColumns();
    if (!this.workerScriptsHasPreviewColumns) {
      console.warn(
        "[OrgDO] worker_scripts missing preview columns - preview updates will be skipped",
      );
    }
  }

  private detectWorkerScriptPreviewColumns(): boolean {
    try {
      const rows = this.sql
        .exec<{ name: string }>("PRAGMA table_info(worker_scripts)")
        .toArray();
      const names = new Set(rows.map((row) => row.name));
      return (
        names.has("preview_key") &&
        names.has("preview_updated_at") &&
        names.has("preview_status") &&
        names.has("preview_error") &&
        names.has("custom_domain_hostname") &&
        names.has("custom_domain_cf_hostname_id") &&
        names.has("custom_domain_status") &&
        names.has("custom_domain_ssl_status") &&
        names.has("custom_domain_error") &&
        names.has("custom_domain_updated_at")
      );
    } catch {
      return false;
    }
  }

  private ensureThreadSchemaColumns(): void {
    try {
      const rows = this.sql
        .exec<{ name: string }>("PRAGMA table_info(threads)")
        .toArray();
      if (rows.length === 0) return;

      const names = new Set(rows.map((row) => row.name));

      if (!names.has("source")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN source TEXT NOT NULL DEFAULT 'web'",
          );
        } catch {}
        try {
          this.sql.exec(
            "UPDATE threads SET source = 'web' WHERE source IS NULL OR source = ''",
          );
        } catch {}
      }

      if (!names.has("user_message_count")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN user_message_count INTEGER NOT NULL DEFAULT 0",
          );
        } catch {}
      }

      if (!names.has("first_user_message")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN first_user_message TEXT",
          );
        } catch {}
      }

      if (!names.has("provider")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'",
          );
        } catch {}
        try {
          this.sql.exec(
            "UPDATE threads SET provider = 'claude' WHERE provider IS NULL OR provider = ''",
          );
        } catch {}
      }

      if (!names.has("model")) {
        try {
          this.sql.exec(
            `ALTER TABLE threads ADD COLUMN model TEXT NOT NULL DEFAULT '${DEFAULT_LLM_MODEL}'`,
          );
        } catch {}
        try {
          this.sql.exec(
            `UPDATE threads SET model = '${DEFAULT_LLM_MODEL}' WHERE model IS NULL OR model = ''`,
          );
        } catch {}
      }
    } catch (err) {
      console.error("[OrgDO] failed to ensure thread schema columns", err);
    }
  }

  private execWorkerScriptsQuery(
    queryWithPreview: string,
    queryBase: string,
    params: Array<string | number>,
  ): WorkerScriptRow[] {
    if (this.workerScriptsHasPreviewColumns) {
      try {
        return this.sql
          .exec<WorkerScriptRow>(queryWithPreview, ...params)
          .toArray();
      } catch {
        this.workerScriptsHasPreviewColumns = false;
      }
    }
    return this.sql.exec<WorkerScriptRow>(queryBase, ...params).toArray();
  }

  private toWorkerScript(row: WorkerScriptRow): WorkerScript {
    return {
      script_name: row.script_name,
      workspace_id: row.workspace_id,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      is_public: row.is_public === 1,
      preview_key: row.preview_key ?? null,
      preview_updated_at: row.preview_updated_at ?? null,
      preview_status: row.preview_status ?? null,
      preview_error: row.preview_error ?? null,
      config_path: row.config_path ?? null,
      custom_domain_hostname: row.custom_domain_hostname ?? null,
      custom_domain_cf_hostname_id: row.custom_domain_cf_hostname_id ?? null,
      custom_domain_status: row.custom_domain_status ?? null,
      custom_domain_ssl_status: row.custom_domain_ssl_status ?? null,
      custom_domain_error: row.custom_domain_error ?? null,
      custom_domain_updated_at: row.custom_domain_updated_at ?? null,
    };
  }

  // Org info methods
  private getInfoSync(): Organization | null {
    const rows = this.sql
      .exec("SELECT value FROM org_info WHERE key = ?", "data")
      .toArray();
    if (rows.length === 0) return null;
    const info = JSON.parse(
      (rows[0] as { value: string }).value,
    ) as Organization;
    normalizeOrgBillingFields(info);
    if (info.billing_customer_id === undefined) info.billing_customer_id = null;
    if (info.billing_subscription_id === undefined)
      info.billing_subscription_id = null;
    if (info.billing_subscription_status === undefined)
      info.billing_subscription_status = null;
    if (info.billing_trial_started_at === undefined)
      info.billing_trial_started_at = null;
    if (info.billing_trial_ends_at === undefined)
      info.billing_trial_ends_at = null;
    if (typeof info.billing_credit_purchase_total_cents !== "number") {
      info.billing_credit_purchase_total_cents = 0;
    }
    if (typeof info.billing_credit_grant_total_cents !== "number") {
      info.billing_credit_grant_total_cents = 0;
    }
    if (typeof info.billing_trial_credit_grant_cents !== "number") {
      info.billing_trial_credit_grant_cents = 0;
    }
    if (info.billing_trial_credit_granted_at === undefined) {
      info.billing_trial_credit_granted_at = null;
    }
    if (typeof info.billing_free_credit_grant_cents !== "number") {
      info.billing_free_credit_grant_cents = 0;
    }
    if (info.billing_free_credit_granted_at === undefined) {
      info.billing_free_credit_granted_at = null;
    }
    if (info.billing_last_included_credit_invoice_id === undefined) {
      info.billing_last_included_credit_invoice_id = null;
    }
    if (info.billing_credit_usage_started_at === undefined) {
      info.billing_credit_usage_started_at = null;
    }
    if (typeof info.archived !== "boolean") info.archived = false;
    if (info.archived_at === undefined) info.archived_at = null;
    if (info.archived_by === undefined) info.archived_by = null;
    return info;
  }

  async getInfo(): Promise<Organization | null> {
    const rows = this.sql
      .exec("SELECT value FROM org_info WHERE key = ?", "data")
      .toArray();
    if (rows.length === 0) return null;
    const info = JSON.parse(
      (rows[0] as { value: string }).value,
    ) as Organization;
    let changed = false;
    changed = normalizeOrgBillingFields(info) || changed;
    if (info.billing_customer_id === undefined) {
      info.billing_customer_id = null;
      changed = true;
    }
    if (info.billing_subscription_id === undefined) {
      info.billing_subscription_id = null;
      changed = true;
    }
    if (info.billing_subscription_status === undefined) {
      info.billing_subscription_status = null;
      changed = true;
    }
    if (info.billing_trial_started_at === undefined) {
      info.billing_trial_started_at = null;
      changed = true;
    }
    if (info.billing_trial_ends_at === undefined) {
      info.billing_trial_ends_at = null;
      changed = true;
    }
    if (typeof info.billing_credit_purchase_total_cents !== "number") {
      info.billing_credit_purchase_total_cents = 0;
      changed = true;
    }
    if (typeof info.billing_credit_grant_total_cents !== "number") {
      info.billing_credit_grant_total_cents = 0;
      changed = true;
    }
    if (typeof info.billing_trial_credit_grant_cents !== "number") {
      info.billing_trial_credit_grant_cents = 0;
      changed = true;
    }
    if (info.billing_trial_credit_granted_at === undefined) {
      info.billing_trial_credit_granted_at = null;
      changed = true;
    }
    if (typeof info.billing_free_credit_grant_cents !== "number") {
      info.billing_free_credit_grant_cents = 0;
      changed = true;
    }
    if (info.billing_free_credit_granted_at === undefined) {
      info.billing_free_credit_granted_at = null;
      changed = true;
    }
    if (info.billing_last_included_credit_invoice_id === undefined) {
      info.billing_last_included_credit_invoice_id = null;
      changed = true;
    }
    if (info.billing_credit_usage_started_at === undefined) {
      info.billing_credit_usage_started_at = null;
      changed = true;
    }
    if (typeof info.archived !== "boolean") {
      info.archived = false;
      changed = true;
    }
    if (info.archived_at === undefined) {
      info.archived_at = null;
      changed = true;
    }
    if (info.archived_by === undefined) {
      info.archived_by = null;
      changed = true;
    }
    if (!info.slug) {
      info.slug = await hashOrgSlug(info.id);
      changed = true;
    }
    if (changed) {
      await this.setInfo(info);
    }
    return info;
  }

  /**
   * Get just the org slug (for contexts where we only need the slug).
   * Also ensures the slug→orgId reverse mapping exists in KV.
   */
  async getSlug(): Promise<string | null> {
    const info = await this.getInfo();
    if (!info?.slug) return null;

    // Lazy backfill: ensure KV reverse mapping exists
    const kvKey = `${ORG_SLUG_KV_PREFIX}${info.slug}`;
    const existing = await this.env.APP_KV.get(kvKey);
    if (!existing) {
      await registerOrgSlug(this.env.APP_KV, info.slug, info.id);
    }
    return info.slug;
  }

  async setInfo(info: Organization): Promise<void> {
    this.sql.exec(
      "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
      "data",
      JSON.stringify(info),
    );
    dispatchAdminEvent(this.ctx, this.env, {
      type: "org_upsert",
      payload: info,
    });
  }

  getExperimentalSettings(): OrganizationExperimentalSettings {
    const rows = this.sql
      .exec<{
        value: string;
      }>(
        "SELECT value FROM org_info WHERE key = ?",
        ORG_EXPERIMENTAL_SETTINGS_KEY,
      )
      .toArray();
    if (rows.length === 0) {
      return { ...DEFAULT_ORG_EXPERIMENTAL_SETTINGS };
    }

    try {
      return parseOrganizationExperimentalSettings(JSON.parse(rows[0]!.value));
    } catch {
      return { ...DEFAULT_ORG_EXPERIMENTAL_SETTINGS };
    }
  }

  setExperimentalSettings(
    settings: Partial<OrganizationExperimentalSettings>,
  ): OrganizationExperimentalSettings {
    const nextSettings = parseOrganizationExperimentalSettings({
      ...this.getExperimentalSettings(),
      ...settings,
    });

    this.sql.exec(
      "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
      ORG_EXPERIMENTAL_SETTINGS_KEY,
      JSON.stringify(nextSettings),
    );

    return nextSettings;
  }

  async createOrg(
    id: string,
    name: string,
    createdBy: string,
  ): Promise<{ org: Organization; defaultWorkspaceId: string }> {
    const now = Date.now();
    const slug = await generateUniqueOrgSlug(id, this.env.APP_KV);
    await registerOrgSlug(this.env.APP_KV, slug, id);

    const info: Organization = {
      id,
      name,
      slug,
      created_at: now,
      created_by: createdBy,
      billing_status: "inactive",
      billing_plan: "free",
      billing_seat_count: 1,
      billing_customer_id: null,
      billing_subscription_id: null,
      billing_subscription_status: null,
      billing_trial_started_at: null,
      billing_trial_ends_at: null,
      billing_credit_purchase_total_cents: 0,
      billing_credit_grant_total_cents: 0,
      billing_trial_credit_grant_cents: 0,
      billing_trial_credit_granted_at: null,
      billing_last_included_credit_invoice_id: null,
      billing_credit_usage_started_at: null,
      archived: false,
      archived_at: null,
      archived_by: null,
    };

    try {
      await this.setInfo(info);

      // Add creator as owner
      await this.addMember(createdBy, "owner", createdBy);
      this.log("org_created", createdBy, id, { name });

      // Create default workspace (WorkspaceDO.createWorkspace registers with org automatically)
      const workspaceId = crypto.randomUUID();
      const workspaceStub = this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(workspaceId),
      ) as unknown as WorkspaceDO;
      await workspaceStub.createWorkspace(
        workspaceId,
        id,
        "Default Workspace",
        createdBy,
        null,
      );
      await workspaceStub.setMemberAccess(createdBy, "full", createdBy);

      try {
        await this.indexOrg(id);
      } catch {
        // Best-effort indexing; do not fail org creation on APP_KV hiccups.
      }

      return { org: info, defaultWorkspaceId: workspaceId };
    } catch (error) {
      try {
        await this.unindexOrg(id);
      } catch {
        // Best-effort rollback for org index.
      }
      throw error;
    }
  }

  async updateName(name: string, actorId: string): Promise<void> {
    const info = await this.getInfo();
    if (info) {
      const previousName = info.name;
      info.name = name;
      await this.setInfo(info);
      if (previousName !== name) {
        this.log("org_updated", actorId, info.id, {
          previous_name: previousName,
          name,
        });
      }
    }
  }

  async updateBillingState(
    updates: OrgBillingStateUpdate,
  ): Promise<Organization | null> {
    const info = await this.getInfo();
    if (!info) return null;

    const nextInfo: Organization = {
      ...info,
      ...updates,
    };
    normalizeOrgBillingFields(nextInfo);

    await this.setInfo(nextInfo);
    return nextInfo;
  }

  syncSubscriptionBillingState(
    updates: OrgBillingStateUpdate,
    trialCreditGrantCents: number,
  ): SyncSubscriptionBillingStateResult | null {
    const normalizedTrialCreditGrantCents = Math.max(
      0,
      Math.floor(trialCreditGrantCents),
    );

    const result = this.ctx.storage.transactionSync(() => {
      const existingOrg = this.getInfoSync();
      if (!existingOrg) return null;

      const nextInfo: Organization = {
        ...existingOrg,
        ...updates,
      };
      let trialCreditGranted = false;
      const existingTrialUsed = Boolean(
        existingOrg.billing_trial_started_at ||
          existingOrg.billing_trial_ends_at ||
          existingOrg.billing_trial_credit_granted_at,
      );

      if (
        normalizedTrialCreditGrantCents > 0 &&
        existingOrg.billing_status !== "enterprise" &&
        updates.billing_status === "trialing" &&
        updates.billing_trial_started_at &&
        updates.billing_trial_ends_at &&
        !existingTrialUsed
      ) {
        nextInfo.billing_credit_grant_total_cents =
          (existingOrg.billing_credit_grant_total_cents ?? 0) +
          normalizedTrialCreditGrantCents;
        nextInfo.billing_trial_credit_grant_cents =
          normalizedTrialCreditGrantCents;
        nextInfo.billing_trial_credit_granted_at = Date.now();
        trialCreditGranted = true;
      } else {
        nextInfo.billing_credit_grant_total_cents =
          existingOrg.billing_credit_grant_total_cents ?? 0;
        nextInfo.billing_trial_credit_grant_cents =
          existingOrg.billing_trial_credit_grant_cents ?? 0;
        nextInfo.billing_trial_credit_granted_at =
          existingOrg.billing_trial_credit_granted_at ?? null;
      }

      normalizeOrgBillingFields(nextInfo);
      this.sql.exec(
        "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
        "data",
        JSON.stringify(nextInfo),
      );

      return { org: nextInfo, trialCreditGranted };
    });

    return result;
  }

  applyCreditCheckout(
    sessionId: string,
    amountCents: number,
    customerId: string | null,
  ): ApplyCreditCheckoutResult | null {
    const trimmedSessionId = sessionId.trim();
    const normalizedAmountCents = Math.max(0, Math.floor(amountCents));
    if (!trimmedSessionId || normalizedAmountCents <= 0) return null;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS stripe_credit_checkouts (
        session_id TEXT PRIMARY KEY,
        amount_cents INTEGER NOT NULL,
        customer_id TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    const result = this.ctx.storage.transactionSync(() => {
      const existingCheckout = this.sql
        .exec(
          "SELECT session_id FROM stripe_credit_checkouts WHERE session_id = ?",
          trimmedSessionId,
        )
        .toArray();
      if (existingCheckout.length > 0) {
        const existingOrg = this.getInfoSync();
        return existingOrg ? { org: existingOrg, applied: false } : null;
      }

      const existingOrg = this.getInfoSync();
      if (!existingOrg) return null;

      const nextInfo: Organization = {
        ...existingOrg,
        billing_customer_id:
          customerId ?? existingOrg.billing_customer_id ?? null,
        billing_credit_purchase_total_cents:
          (existingOrg.billing_credit_purchase_total_cents ?? 0) +
          normalizedAmountCents,
      };

      this.sql.exec(
        "INSERT INTO stripe_credit_checkouts (session_id, amount_cents, customer_id, created_at) VALUES (?, ?, ?, ?)",
        trimmedSessionId,
        normalizedAmountCents,
        customerId,
        Date.now(),
      );
      this.sql.exec(
        "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
        "data",
        JSON.stringify(nextInfo),
      );
      return { org: nextInfo, applied: true };
    });

    if (result?.applied) {
      dispatchAdminEvent(this.ctx, this.env, {
        type: "org_upsert",
        payload: result.org,
      });
    }
    return result;
  }

  applyManualCreditGrant(
    amountCents: number,
    reason?: string | null,
    idempotencyKey?: string | null,
  ): ApplyManualCreditGrantResult | null {
    const normalizedAmountCents = Math.max(0, Math.floor(amountCents));
    if (normalizedAmountCents <= 0) return null;

    const trimmedReason = reason?.trim() ? reason.trim().slice(0, 500) : null;
    const trimmedIdempotencyKey = idempotencyKey?.trim()
      ? idempotencyKey.trim().slice(0, 200)
      : null;
    const grantId = trimmedIdempotencyKey ?? `manual:${Date.now()}:${crypto.randomUUID()}`;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS admin_credit_grants (
        grant_id TEXT PRIMARY KEY,
        amount_cents INTEGER NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    const result = this.ctx.storage.transactionSync(() => {
      const existingGrant = this.sql
        .exec(
          "SELECT grant_id, amount_cents, reason FROM admin_credit_grants WHERE grant_id = ?",
          grantId,
        )
        .toArray();
      if (existingGrant.length > 0) {
        const existingOrg = this.getInfoSync();
        return existingOrg
          ? {
              org: existingOrg,
              applied: false,
              grantId,
              amountCents: Number(existingGrant[0].amount_cents ?? normalizedAmountCents),
              reason:
                typeof existingGrant[0].reason === "string"
                  ? existingGrant[0].reason
                  : null,
            }
          : null;
      }

      const existingOrg = this.getInfoSync();
      if (!existingOrg) return null;

      const nextInfo: Organization = {
        ...existingOrg,
        billing_credit_grant_total_cents:
          (existingOrg.billing_credit_grant_total_cents ?? 0) +
          normalizedAmountCents,
        billing_credit_usage_started_at:
          existingOrg.billing_credit_usage_started_at ?? Date.now(),
      };

      normalizeOrgBillingFields(nextInfo);
      this.sql.exec(
        "INSERT INTO admin_credit_grants (grant_id, amount_cents, reason, created_at) VALUES (?, ?, ?, ?)",
        grantId,
        normalizedAmountCents,
        trimmedReason,
        Date.now(),
      );
      this.sql.exec(
        "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
        "data",
        JSON.stringify(nextInfo),
      );

      return {
        org: nextInfo,
        applied: true,
        grantId,
        amountCents: normalizedAmountCents,
        reason: trimmedReason,
      };
    });

    if (result?.applied) {
      dispatchAdminEvent(this.ctx, this.env, {
        type: "org_upsert",
        payload: result.org,
      });
    }
    return result;
  }

  // Member methods
  async getMembers(): Promise<OrgMember[]> {
    this.ensureOwnerExists("system");
    return this.sql
      .exec(
        "SELECT user_id, role, joined_at FROM members ORDER BY joined_at ASC",
      )
      .toArray() as unknown as OrgMember[];
  }

  async getMember(userId: string): Promise<OrgMember | null> {
    const rows = this.sql
      .exec(
        "SELECT user_id, role, joined_at FROM members WHERE user_id = ?",
        userId,
      )
      .toArray() as unknown as OrgMember[];
    return rows[0] || null;
  }

  private dispatchOrgMembershipUpsert(
    userId: string,
    role: OrgRole,
    joinedAt: number,
  ): void {
    this.getInfo().then((info) => {
      if (!info) return;
      dispatchAdminEvent(this.ctx, this.env, {
        type: "org_membership_upsert",
        payload: {
          org_id: info.id,
          user_id: userId,
          role,
          joined_at: joinedAt,
        },
      });
    });
  }

  private dispatchOrgMembershipDelete(userId: string): void {
    this.getInfo().then((info) => {
      if (!info) return;
      dispatchAdminEvent(this.ctx, this.env, {
        type: "org_membership_delete",
        payload: {
          org_id: info.id,
          user_id: userId,
        },
      });
    });
  }

  async addMember(
    userId: string,
    role: OrgRole,
    actorId: string,
    reservedInvitations?: number,
    pendingBillingSeatAllowance = 0,
  ): Promise<void> {
    const existing = await this.getMember(userId);
    if (!existing) {
      await this.assertSeatCapacityForNewMember(
        reservedInvitations,
        pendingBillingSeatAllowance,
      );
    }
    const now = Date.now();
    this.sql.exec(
      "INSERT OR REPLACE INTO members (user_id, role, joined_at) VALUES (?, ?, ?)",
      userId,
      role,
      now,
    );
    if (!existing) {
      this.log("member_added", actorId, userId, { role });
      const info = await this.getInfo();
      if (info) {
        dispatchAdminEvent(this.ctx, this.env, {
          type: "org_member_delta",
          payload: { org_id: info.id, delta: 1 },
        });
      }
      this.dispatchOrgMembershipUpsert(userId, role, now);
    }
  }

  private async assertSeatCapacityForNewMember(
    reservedInvitations?: number,
    pendingBillingSeatAllowance = 0,
  ): Promise<void> {
    const info = await this.getInfo();
    if (!info) return;

    const seatLimit = getOrgSeatLimit(info);
    if (seatLimit === null) return;

    const currentMembers =
      this.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM members")
        .next().value?.count ?? 0;
    const activeInvitations =
      reservedInvitations ??
      (this.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM invitations WHERE expires_at > ?",
          Date.now(),
        )
        .next().value?.count ??
        0);
    if (
      currentMembers + activeInvitations >=
      seatLimit + pendingBillingSeatAllowance
    ) {
      throw new Error(
        `Your current billing plan includes ${seatLimit} seat${seatLimit === 1 ? "" : "s"}.`,
      );
    }
  }

  private getPendingBillingSeatAllowance(info: Organization): number {
    return isTeamSeatBillingSyncable(info) ? 1 : 0;
  }

  async removeMember(userId: string, actorId: string): Promise<void> {
    const existing = await this.getMember(userId);
    if (existing?.role === "owner") {
      throw new Error(
        "Cannot remove the organization owner. Transfer ownership first.",
      );
    }
    this.sql.exec("DELETE FROM members WHERE user_id = ?", userId);
    if (existing) {
      this.log("member_removed", actorId, userId, { role: existing.role });
      const info = await this.getInfo();
      if (info) {
        dispatchAdminEvent(this.ctx, this.env, {
          type: "org_member_delta",
          payload: { org_id: info.id, delta: -1 },
        });
      }
      this.dispatchOrgMembershipDelete(userId);
    }
    this.ensureOwnerExists(actorId);
  }

  async updateMemberRole(
    userId: string,
    role: OrgRole,
    actorId: string,
  ): Promise<void> {
    const existing = await this.getMember(userId);
    if (role === "owner") {
      throw new Error("Use transferOwnership to assign owner role");
    }
    if (existing?.role === "owner") {
      throw new Error(
        "Cannot change the owner role. Transfer ownership first.",
      );
    }
    this.sql.exec(
      "UPDATE members SET role = ? WHERE user_id = ?",
      role,
      userId,
    );
    if (existing && existing.role !== role) {
      this.log("member_role_changed", actorId, userId, {
        old_role: existing.role,
        new_role: role,
      });
      this.dispatchOrgMembershipUpsert(userId, role, existing.joined_at);
    }
    this.ensureOwnerExists(actorId);
  }

  async isMember(userId: string): Promise<boolean> {
    const rows = this.sql
      .exec("SELECT 1 FROM members WHERE user_id = ?", userId)
      .toArray();
    return rows.length > 0;
  }

  async isAdmin(userId: string): Promise<boolean> {
    const rows = this.sql
      .exec(
        "SELECT 1 FROM members WHERE user_id = ? AND role IN (?, ?)",
        userId,
        "owner",
        "admin",
      )
      .toArray();
    return rows.length > 0;
  }

  async isOwner(userId: string): Promise<boolean> {
    const rows = this.sql
      .exec(
        "SELECT 1 FROM members WHERE user_id = ? AND role = ?",
        userId,
        "owner",
      )
      .toArray();
    return rows.length > 0;
  }

  async getMemberCount(): Promise<number> {
    const rows = this.sql
      .exec("SELECT COUNT(*) as count FROM members")
      .toArray();
    return (rows[0] as { count: number }).count;
  }

  private ensureOwnerExists(actorId: string): void {
    const ownerRows = this.sql
      .exec("SELECT user_id FROM members WHERE role = ? LIMIT 1", "owner")
      .toArray() as Array<{ user_id: string }>;
    if (ownerRows.length > 0) return;

    const fallbackRows = this.sql
      .exec(
        `SELECT user_id, role, joined_at FROM members
       ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at ASC
       LIMIT 1`,
      )
      .toArray() as Array<{ user_id: string }>;
    const fallback = fallbackRows[0];
    if (!fallback) return;

    this.sql.exec(
      "UPDATE members SET role = ? WHERE user_id = ?",
      "owner",
      fallback.user_id,
    );
    this.log("owner_recovered", actorId, fallback.user_id);
  }

  // Invitation methods
  async getInvitations(): Promise<OrgInvitation[]> {
    const rows = this.sql
      .exec(
        "SELECT id, email, role, invited_by, created_at, expires_at, workspace_access FROM invitations ORDER BY created_at DESC",
      )
      .toArray() as unknown as Array<
      Omit<OrgInvitation, "workspace_access"> & {
        workspace_access?: string | null;
      }
    >;
    return rows.map((row) => ({
      ...row,
      workspace_access: row.workspace_access
        ? JSON.parse(row.workspace_access)
        : null,
    }));
  }

  async getInvitation(id: string): Promise<OrgInvitation | null> {
    const now = Date.now();
    const rows = this.sql
      .exec(
        "SELECT id, email, role, invited_by, created_at, expires_at, workspace_access FROM invitations WHERE id = ? AND expires_at > ?",
        id,
        now,
      )
      .toArray() as unknown as Array<
      Omit<OrgInvitation, "workspace_access"> & {
        workspace_access?: string | null;
      }
    >;
    if (!rows[0]) return null;
    return {
      ...rows[0],
      workspace_access: rows[0].workspace_access
        ? JSON.parse(rows[0].workspace_access)
        : null,
    };
  }

  async getInvitationByEmail(email: string): Promise<OrgInvitation | null> {
    const now = Date.now();
    const rows = this.sql
      .exec(
        "SELECT id, email, role, invited_by, created_at, expires_at, workspace_access FROM invitations WHERE email = ? AND expires_at > ?",
        email.toLowerCase(),
        now,
      )
      .toArray() as unknown as Array<
      Omit<OrgInvitation, "workspace_access"> & {
        workspace_access?: string | null;
      }
    >;
    if (!rows[0]) return null;
    return {
      ...rows[0],
      workspace_access: rows[0].workspace_access
        ? JSON.parse(rows[0].workspace_access)
        : null,
    };
  }

  async createInvitation(
    email: string,
    role: OrgRole,
    invitedBy: string,
    workspaceAccess?: Record<string, "full" | "none"> | null,
  ): Promise<OrgInvitation> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7 days
    const activeInvitations =
      this.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM invitations WHERE expires_at > ?",
          now,
        )
        .next().value?.count ?? 0;
    const info = await this.getInfo();
    await this.assertSeatCapacityForNewMember(
      activeInvitations,
      info ? this.getPendingBillingSeatAllowance(info) : 0,
    );

    const invitation: OrgInvitation = {
      id,
      email: email.toLowerCase(),
      role,
      invited_by: invitedBy,
      created_at: now,
      expires_at: expiresAt,
      workspace_access: workspaceAccess ?? null,
    };

    this.sql.exec(
      "INSERT INTO invitations (id, email, role, invited_by, created_at, expires_at, workspace_access) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      email.toLowerCase(),
      role,
      invitedBy,
      now,
      expiresAt,
      workspaceAccess ? JSON.stringify(workspaceAccess) : null,
    );

    if (info)
      dispatchAdminEvent(this.ctx, this.env, {
        type: "invitation_upsert",
        payload: { ...invitation, org_id: info.id },
      });
    return invitation;
  }

  async deleteInvitation(id: string): Promise<void> {
    this.sql.exec("DELETE FROM invitations WHERE id = ?", id);
    dispatchAdminEvent(this.ctx, this.env, {
      type: "invitation_delete",
      payload: { id },
    });
  }

  async updateInvitationWorkspaceAccess(
    invitationId: string,
    workspaceAccess: Record<string, "full" | "none"> | null,
  ): Promise<boolean> {
    const invitation = await this.getInvitation(invitationId);
    if (!invitation) return false;
    this.sql.exec(
      "UPDATE invitations SET workspace_access = ? WHERE id = ?",
      workspaceAccess ? JSON.stringify(workspaceAccess) : null,
      invitationId,
    );
    return true;
  }

  async acceptInvitation(
    invitationId: string,
    userId: string,
  ): Promise<OrgInvitation | null> {
    const invitation = await this.getInvitation(invitationId);
    if (!invitation) return null;

    const now = Date.now();
    const activeInvitationsExcludingAccepted = Math.max(
      0,
      (this.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM invitations WHERE expires_at > ?",
          now,
        )
        .next().value?.count ?? 0) - 1,
    );
    const info = await this.getInfo();

    // Add user as member with invited role
    await this.addMember(
      userId,
      invitation.role,
      userId,
      activeInvitationsExcludingAccepted,
      info ? this.getPendingBillingSeatAllowance(info) : 0,
    );

    // Delete the invitation (single use)
    await this.deleteInvitation(invitationId);

    dispatchAdminEvent(this.ctx, this.env, {
      type: "invitation_delete",
      payload: { id: invitationId },
    });
    return invitation;
  }

  // Integration methods
  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async getIntegrations(): Promise<OrgIntegrationRecord[]> {
    return this.sql
      .exec(
        `SELECT id, integration_type, name, category, auth_method, config,
                credentials_encrypted, created_by, created_at, updated_at
         FROM integrations
         ORDER BY created_at DESC`,
      )
      .toArray() as unknown as OrgIntegrationRecord[];
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async getIntegration(id: string): Promise<OrgIntegrationRecord | null> {
    const rows = this.sql
      .exec(
        `SELECT id, integration_type, name, category, auth_method, config,
                credentials_encrypted, created_by, created_at, updated_at
         FROM integrations WHERE id = ?`,
        id,
      )
      .toArray() as unknown as OrgIntegrationRecord[];
    return rows[0] || null;
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async createIntegration(
    id: string,
    integrationType: string,
    name: string,
    category: string,
    authMethod: string,
    config: string,
    credentialsEncrypted: string,
    createdBy: string,
  ): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO integrations
       (id, integration_type, name, category, auth_method, config, credentials_encrypted, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      integrationType,
      name,
      category,
      authMethod,
      config,
      credentialsEncrypted,
      createdBy,
      now,
      now,
    );
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async updateIntegration(
    id: string,
    updates: {
      name?: string;
      config?: string;
      credentialsEncrypted?: string;
    },
  ): Promise<void> {
    const now = Date.now();
    const setClauses: string[] = ["updated_at = ?"];
    const params: (string | number)[] = [now];

    if (updates.name !== undefined) {
      setClauses.push("name = ?");
      params.push(updates.name);
    }
    if (updates.config !== undefined) {
      setClauses.push("config = ?");
      params.push(updates.config);
    }
    if (updates.credentialsEncrypted !== undefined) {
      setClauses.push("credentials_encrypted = ?");
      params.push(updates.credentialsEncrypted);
    }

    params.push(id);
    this.sql.exec(
      `UPDATE integrations SET ${setClauses.join(", ")} WHERE id = ?`,
      ...params,
    );
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async deleteIntegration(id: string): Promise<void> {
    this.sql.exec("DELETE FROM integrations WHERE id = ?", id);
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async dropLegacyIntegrations(): Promise<void> {
    this.sql.exec("DROP TABLE IF EXISTS integrations");
  }

  // Worker script methods
  async registerWorkerScript(
    scriptName: string,
    workspaceId: string,
    createdBy: string,
    configPath?: string,
  ): Promise<WorkerScript> {
    const now = Date.now();
    const existing = await this.getWorkerScript(scriptName);

    if (existing) {
      // Check if script belongs to a different workspace - prevent name collisions
      if (existing.workspace_id !== workspaceId) {
        throw new Error(
          `Script name "${scriptName}" is already in use by another workspace in this organization. ` +
            `Please choose a different name.`,
        );
      }

      // Same workspace - update the script (redeploy)
      this.sql.exec(
        "UPDATE worker_scripts SET updated_at = ?, config_path = ? WHERE script_name = ?",
        now,
        configPath ?? null,
        scriptName,
      );
      this.log("worker_script_updated", createdBy, scriptName, {
        workspace_id: workspaceId,
        config_path: configPath,
      });
      return {
        ...existing,
        updated_at: now,
        config_path: configPath ?? existing.config_path,
      };
    }

    this.sql.exec(
      "INSERT INTO worker_scripts (script_name, workspace_id, created_by, created_at, updated_at, is_public, config_path) VALUES (?, ?, ?, ?, ?, 1, ?)",
      scriptName,
      workspaceId,
      createdBy,
      now,
      now,
      configPath ?? null,
    );
    this.log("worker_script_registered", createdBy, scriptName, {
      workspace_id: workspaceId,
      config_path: configPath,
    });
    const newScript = {
      script_name: scriptName,
      workspace_id: workspaceId,
      created_by: createdBy,
      created_at: now,
      updated_at: now,
      is_public: true,
      preview_key: null,
      preview_updated_at: null,
      preview_status: "pending" as WorkerScriptPreviewStatus,
      preview_error: null,
      config_path: configPath ?? null,
      custom_domain_hostname: null,
      custom_domain_cf_hostname_id: null,
      custom_domain_status: null,
      custom_domain_ssl_status: null,
      custom_domain_error: null,
      custom_domain_updated_at: null,
    };
    const info = await this.getInfo();
    if (info)
      dispatchAdminEvent(this.ctx, this.env, {
        type: "app_upsert",
        payload: { ...newScript, org_id: info.id },
      });
    return newScript;
  }

  async getWorkerScript(scriptName: string): Promise<WorkerScript | null> {
    const queryWithPreview = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                                     preview_key, preview_updated_at, preview_status, preview_error, config_path,
                                     custom_domain_hostname, custom_domain_cf_hostname_id, custom_domain_status,
                                     custom_domain_ssl_status, custom_domain_error, custom_domain_updated_at
                              FROM worker_scripts WHERE script_name = ?`;
    const queryBase = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                              NULL AS preview_key, NULL AS preview_updated_at, NULL AS preview_status, NULL AS preview_error, NULL AS config_path,
                              NULL AS custom_domain_hostname, NULL AS custom_domain_cf_hostname_id, NULL AS custom_domain_status,
                              NULL AS custom_domain_ssl_status, NULL AS custom_domain_error, NULL AS custom_domain_updated_at
                       FROM worker_scripts WHERE script_name = ?`;
    const rows = this.execWorkerScriptsQuery(queryWithPreview, queryBase, [
      scriptName,
    ]);
    if (rows.length === 0) return null;
    return this.toWorkerScript(rows[0]);
  }

  async listWorkerScripts(): Promise<WorkerScript[]> {
    const queryWithPreview = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                                     preview_key, preview_updated_at, preview_status, preview_error, config_path,
                                     custom_domain_hostname, custom_domain_cf_hostname_id, custom_domain_status,
                                     custom_domain_ssl_status, custom_domain_error, custom_domain_updated_at
                              FROM worker_scripts ORDER BY updated_at DESC`;
    const queryBase = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                              NULL AS preview_key, NULL AS preview_updated_at, NULL AS preview_status, NULL AS preview_error, NULL AS config_path,
                              NULL AS custom_domain_hostname, NULL AS custom_domain_cf_hostname_id, NULL AS custom_domain_status,
                              NULL AS custom_domain_ssl_status, NULL AS custom_domain_error, NULL AS custom_domain_updated_at
                       FROM worker_scripts ORDER BY updated_at DESC`;
    const rows = this.execWorkerScriptsQuery(queryWithPreview, queryBase, []);
    return rows.map((row) => this.toWorkerScript(row));
  }

  async listWorkerScriptsPaginated(
    offset: number,
    limit: number,
    search?: string,
  ): Promise<{ items: WorkerScript[]; total: number }> {
    const normalized = search?.trim().toLowerCase();
    const whereClause = normalized ? "WHERE lower(script_name) LIKE ?" : "";
    const params: Array<string | number> = [];
    if (normalized) {
      params.push(`%${normalized}%`);
    }

    const countRows = this.sql
      .exec(
        `SELECT COUNT(*) as count FROM worker_scripts ${whereClause}`,
        ...params,
      )
      .toArray() as unknown as Array<{ count: number }>;
    const total = countRows[0]?.count ?? 0;

    const queryWithPreview = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                                     preview_key, preview_updated_at, preview_status, preview_error, config_path,
                                     custom_domain_hostname, custom_domain_cf_hostname_id, custom_domain_status,
                                     custom_domain_ssl_status, custom_domain_error, custom_domain_updated_at
                              FROM worker_scripts ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    const queryBase = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                              NULL AS preview_key, NULL AS preview_updated_at, NULL AS preview_status, NULL AS preview_error, NULL AS config_path,
                              NULL AS custom_domain_hostname, NULL AS custom_domain_cf_hostname_id, NULL AS custom_domain_status,
                              NULL AS custom_domain_ssl_status, NULL AS custom_domain_error, NULL AS custom_domain_updated_at
                       FROM worker_scripts ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    const items = this.execWorkerScriptsQuery(queryWithPreview, queryBase, [
      ...params,
      limit,
      offset,
    ]);
    return {
      items: items.map((row) => this.toWorkerScript(row)),
      total,
    };
  }

  async listWorkerScriptsByWorkspace(
    workspaceId: string,
  ): Promise<WorkerScript[]> {
    const queryWithPreview = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                                     preview_key, preview_updated_at, preview_status, preview_error, config_path,
                                     custom_domain_hostname, custom_domain_cf_hostname_id, custom_domain_status,
                                     custom_domain_ssl_status, custom_domain_error, custom_domain_updated_at
                              FROM worker_scripts WHERE workspace_id = ? ORDER BY updated_at DESC`;
    const queryBase = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                              NULL AS preview_key, NULL AS preview_updated_at, NULL AS preview_status, NULL AS preview_error, NULL AS config_path,
                              NULL AS custom_domain_hostname, NULL AS custom_domain_cf_hostname_id, NULL AS custom_domain_status,
                              NULL AS custom_domain_ssl_status, NULL AS custom_domain_error, NULL AS custom_domain_updated_at
                       FROM worker_scripts WHERE workspace_id = ? ORDER BY updated_at DESC`;
    const rows = this.execWorkerScriptsQuery(queryWithPreview, queryBase, [
      workspaceId,
    ]);
    return rows.map((row) => this.toWorkerScript(row));
  }

  async updateWorkerScript(
    scriptName: string,
    actorId: string,
  ): Promise<WorkerScript | null> {
    const now = Date.now();
    this.sql.exec(
      "UPDATE worker_scripts SET updated_at = ? WHERE script_name = ?",
      now,
      scriptName,
    );
    const script = await this.getWorkerScript(scriptName);
    if (script) {
      this.log("worker_script_touched", actorId, scriptName);
      const info = await this.getInfo();
      if (info)
        dispatchAdminEvent(this.ctx, this.env, {
          type: "app_upsert",
          payload: { ...script, org_id: info.id },
        });
    }
    return script;
  }

  async setWorkerScriptPublic(
    scriptName: string,
    isPublic: boolean,
    actorId: string,
  ): Promise<WorkerScript | null> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) return null;
    const now = Date.now();
    this.sql.exec(
      "UPDATE worker_scripts SET is_public = ?, updated_at = ? WHERE script_name = ?",
      isPublic ? 1 : 0,
      now,
      scriptName,
    );
    this.log("worker_script_visibility_changed", actorId, scriptName, {
      is_public: isPublic,
    });
    const updated = {
      ...existing,
      is_public: isPublic,
      updated_at: now,
    };
    const info = await this.getInfo();
    if (info)
      dispatchAdminEvent(this.ctx, this.env, {
        type: "app_upsert",
        payload: { ...updated, org_id: info.id },
      });
    return updated;
  }

  async updateWorkerScriptPreview(
    scriptName: string,
    input: WorkerScriptPreviewUpdateInput,
  ): Promise<WorkerScriptPreviewUpdateResult> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) {
      return { script: null, updated: false, stale: false };
    }

    if (!this.workerScriptsHasPreviewColumns) {
      return { script: existing, updated: false, stale: false };
    }

    if (input.deploy_ts && existing.updated_at > input.deploy_ts) {
      return { script: existing, updated: false, stale: true };
    }

    const previewUpdatedAt = input.preview_updated_at ?? Date.now();
    this.sql.exec(
      `UPDATE worker_scripts
       SET preview_status = ?, preview_key = ?, preview_error = ?, preview_updated_at = ?
       WHERE script_name = ?`,
      input.status,
      input.preview_key ?? null,
      input.preview_error ?? null,
      previewUpdatedAt,
      scriptName,
    );

    const script = await this.getWorkerScript(scriptName);
    const info = await this.getInfo();
    if (info && script)
      dispatchAdminEvent(this.ctx, this.env, {
        type: "app_upsert",
        payload: { ...script, org_id: info.id },
      });
    return { script, updated: true, stale: false };
  }

  async updateWorkerScriptCustomDomain(
    scriptName: string,
    input: WorkerScriptCustomDomainUpdateInput,
  ): Promise<WorkerScript | null> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) return null;

    if (!this.workerScriptsHasPreviewColumns) {
      return existing;
    }

    if (input.deploy_ts && existing.updated_at > input.deploy_ts) {
      return existing;
    }

    const nextHostname = input.hostname?.trim().toLowerCase() ?? null;
    if (nextHostname && nextHostname !== existing.custom_domain_hostname) {
      const info = await this.getInfo();
      if (info) {
        const limit = getBillingPlanLimits(
          info.billing_plan,
          info.billing_status,
        ).maxCustomDomains;
        if (limit !== null) {
          const currentCount =
            this.sql
              .exec<{ count: number }>(
                `SELECT COUNT(*) AS count
               FROM worker_scripts
               WHERE custom_domain_hostname IS NOT NULL
                 AND custom_domain_hostname != ''
                 AND script_name != ?`,
                scriptName,
              )
              .toArray()[0]?.count ?? 0;
          if (currentCount >= limit) {
            throw new Error(
              `Your current billing plan allows ${limit} custom domain${limit === 1 ? "" : "s"}.`,
            );
          }
        }
      }
    }

    this.sql.exec(
      `UPDATE worker_scripts
       SET custom_domain_hostname = ?, custom_domain_cf_hostname_id = ?, custom_domain_status = ?,
           custom_domain_ssl_status = ?, custom_domain_error = ?, custom_domain_updated_at = ?
       WHERE script_name = ?`,
      nextHostname,
      input.cf_hostname_id ?? null,
      input.status ?? null,
      input.ssl_status ?? null,
      input.error ?? null,
      input.updated_at ?? Date.now(),
      scriptName,
    );

    const script = await this.getWorkerScript(scriptName);
    const info = await this.getInfo();
    if (info && script) {
      if (
        existing.custom_domain_hostname &&
        existing.custom_domain_hostname !== nextHostname
      ) {
        await this.env.APP_KV.delete(
          `${CUSTOM_DOMAIN_HOST_PREFIX}${existing.custom_domain_hostname}`,
        );
      }
      if (nextHostname) {
        await this.env.APP_KV.put(
          `${CUSTOM_DOMAIN_HOST_PREFIX}${nextHostname}`,
          JSON.stringify({
            org_id: info.id,
            org_slug: info.slug,
            script_name: scriptName,
            dispatch_script_name: `${scriptName}--${info.slug}`,
          }),
        );
      }
      dispatchAdminEvent(this.ctx, this.env, {
        type: "app_upsert",
        payload: { ...script, org_id: info.id },
      });
    }
    return script;
  }

  async clearWorkerScriptCustomDomain(
    scriptName: string,
  ): Promise<WorkerScript | null> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) return null;
    if (!this.workerScriptsHasPreviewColumns) {
      return existing;
    }

    this.sql.exec(
      `UPDATE worker_scripts
       SET custom_domain_hostname = NULL,
           custom_domain_cf_hostname_id = NULL,
           custom_domain_status = NULL,
           custom_domain_ssl_status = NULL,
           custom_domain_error = NULL,
           custom_domain_updated_at = NULL
       WHERE script_name = ?`,
      scriptName,
    );

    if (existing.custom_domain_hostname) {
      await this.env.APP_KV.delete(
        `${CUSTOM_DOMAIN_HOST_PREFIX}${existing.custom_domain_hostname}`,
      );
    }

    const script = await this.getWorkerScript(scriptName);
    const info = await this.getInfo();
    if (info && script) {
      dispatchAdminEvent(this.ctx, this.env, {
        type: "app_upsert",
        payload: { ...script, org_id: info.id },
      });
    }
    return script;
  }

  async clearWorkerScriptCustomDomains(): Promise<void> {
    if (!this.workerScriptsHasPreviewColumns) return;

    const customHostnames = (await this.listWorkerScripts())
      .map((script) => script.custom_domain_hostname)
      .filter((hostname): hostname is string => Boolean(hostname));

    this.sql.exec(
      `UPDATE worker_scripts
       SET custom_domain_hostname = NULL,
           custom_domain_cf_hostname_id = NULL,
           custom_domain_status = NULL,
           custom_domain_ssl_status = NULL,
           custom_domain_error = NULL,
           custom_domain_updated_at = NULL`,
    );
    await Promise.all(
      customHostnames.map((hostname) =>
        this.env.APP_KV.delete(`${CUSTOM_DOMAIN_HOST_PREFIX}${hostname}`),
      ),
    );
  }

  async deleteWorkerScript(
    scriptName: string,
    actorId: string,
  ): Promise<boolean> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) return false;
    if (existing.custom_domain_hostname) {
      await this.env.APP_KV.delete(
        `${CUSTOM_DOMAIN_HOST_PREFIX}${existing.custom_domain_hostname}`,
      );
    }
    this.sql.exec(
      "DELETE FROM worker_scripts WHERE script_name = ?",
      scriptName,
    );
    this.log("worker_script_deleted", actorId, scriptName, {
      workspace_id: existing.workspace_id,
    });
    const info = await this.getInfo();
    dispatchAdminEvent(this.ctx, this.env, {
      type: "app_delete",
      payload: { script_name: scriptName, org_id: info?.id ?? null },
    });
    return true;
  }

  // ── Legacy Org Custom Domains ───────────────────────────────────────

  async setCustomDomain(
    domain: string,
    actorId: string,
  ): Promise<CustomDomain> {
    const now = Date.now();
    // Org can have at most one custom domain — upsert
    this.sql.exec("DELETE FROM custom_domains");
    this.sql.exec(
      `INSERT INTO custom_domains (domain, cf_hostname_id, status, ssl_status, created_at, updated_at)
       VALUES (?, NULL, 'pending', NULL, ?, ?)`,
      domain,
      now,
      now,
    );
    this.log("custom_domain_set", actorId, domain);
    return {
      domain,
      cf_hostname_id: null,
      status: "pending",
      ssl_status: null,
      created_at: now,
      updated_at: now,
    };
  }

  async removeCustomDomain(actorId: string): Promise<CustomDomain | null> {
    const existing = this.getCustomDomain();
    if (!existing) return null;
    this.sql.exec("DELETE FROM custom_domains");
    this.log("custom_domain_removed", actorId, existing.domain);
    return existing;
  }

  getCustomDomain(): CustomDomain | null {
    const rows = this.sql
      .exec<CustomDomainRow>(
        "SELECT domain, cf_hostname_id, status, ssl_status, created_at, updated_at FROM custom_domains LIMIT 1",
      )
      .toArray();
    return rows[0] ?? null;
  }

  async updateCustomDomainStatus(
    domain: string,
    status: CustomDomainStatus,
    sslStatus?: string | null,
    cfHostnameId?: string,
  ): Promise<CustomDomain | null> {
    const existing = this.getCustomDomain();
    if (!existing || existing.domain !== domain) return null;
    const now = Date.now();
    const updates: string[] = ["status = ?", "updated_at = ?"];
    const params: (string | number | null)[] = [status, now];
    if (sslStatus !== undefined) {
      updates.push("ssl_status = ?");
      params.push(sslStatus ?? null);
    }
    if (cfHostnameId !== undefined) {
      updates.push("cf_hostname_id = ?");
      params.push(cfHostnameId);
    }
    params.push(domain);
    this.sql.exec(
      `UPDATE custom_domains SET ${updates.join(", ")} WHERE domain = ?`,
      ...params,
    );
    return this.getCustomDomain();
  }

  private log(
    action: string,
    actorId: string,
    targetId?: string,
    details?: Record<string, unknown>,
  ): void {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO audit_log (id, action, actor_id, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      action,
      actorId,
      targetId ?? null,
      details ? JSON.stringify(details) : null,
      now,
    );
  }

  async checkWorkspaceNameAvailable(
    name: string,
    excludeWorkspaceId?: string,
  ): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed) return false;

    // Check both exact name (case-insensitive) and slugified name to prevent
    // email routing collisions (e.g. "Data Science" and "Data-Science" both
    // slugify to "data-science")
    const slug = slugifyWorkspaceName(trimmed);
    const rows = excludeWorkspaceId
      ? (this.sql
          .exec(
            "SELECT id, name FROM workspaces WHERE archived = 0 AND id != ?",
            excludeWorkspaceId,
          )
          .toArray() as Array<{ id: string; name: string }>)
      : (this.sql
          .exec("SELECT id, name FROM workspaces WHERE archived = 0")
          .toArray() as Array<{ id: string; name: string }>);

    for (const row of rows) {
      if (row.name.toLowerCase() === trimmed.toLowerCase()) return false;
      if (slugifyWorkspaceName(row.name) === slug) return false;
    }
    return true;
  }

  async addWorkspace(
    workspaceId: string,
    name: string,
    createdAt: number,
    actorId: string,
  ): Promise<void> {
    const available = await this.checkWorkspaceNameAvailable(name, workspaceId);
    if (!available) {
      throw new Error(
        `A workspace named "${name}" already exists in this organization`,
      );
    }
    this.sql.exec(
      "INSERT INTO workspaces (id, name, created_at, archived) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at",
      workspaceId,
      name,
      createdAt,
    );
    this.log("workspace_created", actorId, workspaceId, { name });
  }

  async updateWorkspaceName(workspaceId: string, name: string): Promise<void> {
    const available = await this.checkWorkspaceNameAvailable(name, workspaceId);
    if (!available) {
      throw new Error(
        `A workspace named "${name}" already exists in this organization`,
      );
    }
    this.sql.exec(
      "UPDATE workspaces SET name = ? WHERE id = ?",
      name,
      workspaceId,
    );
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    this.sql.exec(
      "UPDATE workspaces SET archived = 1 WHERE id = ?",
      workspaceId,
    );
  }

  async getWorkspaces(
    includeArchived = false,
  ): Promise<
    Array<{ id: string; name: string; created_at: number; archived: number }>
  > {
    if (includeArchived) {
      return this.sql
        .exec(
          "SELECT id, name, created_at, archived FROM workspaces ORDER BY created_at ASC",
        )
        .toArray() as unknown as Array<{
        id: string;
        name: string;
        created_at: number;
        archived: number;
      }>;
    }
    return this.sql
      .exec(
        "SELECT id, name, created_at, archived FROM workspaces WHERE archived = 0 ORDER BY created_at ASC",
      )
      .toArray() as unknown as Array<{
      id: string;
      name: string;
      created_at: number;
      archived: number;
    }>;
  }

  async getWorkspaceBySlug(slug: string): Promise<{
    id: string;
    name: string;
    created_at: number;
    archived: number;
  } | null> {
    const workspaces = this.sql
      .exec(
        "SELECT id, name, created_at, archived FROM workspaces WHERE archived = 0",
      )
      .toArray() as Array<{
      id: string;
      name: string;
      created_at: number;
      archived: number;
    }>;
    const normalizedSlug = slug.toLowerCase();
    return (
      workspaces.find(
        (ws) => slugifyWorkspaceName(ws.name) === normalizedSlug,
      ) ?? null
    );
  }

  async transferOwnership(actorId: string, newOwnerId: string): Promise<void> {
    const currentOwnerRows = this.sql
      .exec(
        "SELECT user_id, joined_at FROM members WHERE role = ? LIMIT 1",
        "owner",
      )
      .toArray() as Array<{ user_id: string; joined_at: number }>;
    const currentOwner = currentOwnerRows[0]?.user_id;
    if (!currentOwner) {
      throw new Error("No owner found");
    }
    if (currentOwner !== actorId) {
      throw new Error("Only the owner can transfer ownership");
    }

    const newOwnerRows = this.sql
      .exec("SELECT joined_at FROM members WHERE user_id = ?", newOwnerId)
      .toArray() as Array<{ joined_at: number }>;
    if (newOwnerRows.length === 0) {
      throw new Error("New owner is not a member");
    }

    this.sql.exec(
      "UPDATE members SET role = ? WHERE user_id = ?",
      "owner",
      newOwnerId,
    );
    this.sql.exec(
      "UPDATE members SET role = ? WHERE user_id = ?",
      "admin",
      currentOwner,
    );
    this.log("ownership_transferred", actorId, newOwnerId, {
      from_user_id: currentOwner,
    });
    this.dispatchOrgMembershipUpsert(
      newOwnerId,
      "owner",
      newOwnerRows[0]!.joined_at,
    );
    this.dispatchOrgMembershipUpsert(
      currentOwner,
      "admin",
      currentOwnerRows[0]!.joined_at,
    );
  }

  async adminTransferOwnership(
    actorId: string,
    newOwnerId: string,
  ): Promise<void> {
    const currentOwnerRows = this.sql
      .exec(
        "SELECT user_id, joined_at FROM members WHERE role = ? LIMIT 1",
        "owner",
      )
      .toArray() as Array<{ user_id: string; joined_at: number }>;
    const currentOwner = currentOwnerRows[0]?.user_id;
    if (!currentOwner) {
      throw new Error("No owner found");
    }

    const newOwnerRows = this.sql
      .exec("SELECT joined_at FROM members WHERE user_id = ?", newOwnerId)
      .toArray() as Array<{ joined_at: number }>;
    if (newOwnerRows.length === 0) {
      throw new Error("New owner is not a member");
    }

    if (newOwnerId === currentOwner) {
      return;
    }

    this.sql.exec(
      "UPDATE members SET role = ? WHERE user_id = ?",
      "owner",
      newOwnerId,
    );
    this.sql.exec(
      "UPDATE members SET role = ? WHERE user_id = ?",
      "admin",
      currentOwner,
    );
    this.log("ownership_transferred", actorId, newOwnerId, {
      from_user_id: currentOwner,
    });
    this.dispatchOrgMembershipUpsert(
      newOwnerId,
      "owner",
      newOwnerRows[0]!.joined_at,
    );
    this.dispatchOrgMembershipUpsert(
      currentOwner,
      "admin",
      currentOwnerRows[0]!.joined_at,
    );
  }

  async archiveOrg(actorId: string): Promise<void> {
    const info = await this.getInfo();
    if (!info) {
      throw new Error("Organization not found");
    }
    if (info.archived) return;
    info.archived = true;
    info.archived_at = Date.now();
    info.archived_by = actorId;
    await this.setInfo(info);
    this.log("org_archived", actorId);
  }

  /**
   * Permanently delete all organization data from this Durable Object.
   * This is intended for superuser-only test account resets.
   */
  async hardDeleteOrg(actorId: string): Promise<void> {
    const info = await this.getInfo();
    if (!info) {
      return;
    }

    // Clean up slug→org KV mapping
    try {
      await this.env.APP_KV.delete(`${ORG_SLUG_KV_PREFIX}${info.slug}`);
    } catch {
      // Best-effort slug cleanup.
    }
    try {
      await this.unindexOrg(info.id);
    } catch {
      // Best-effort cleanup; stale index only affects enumeration.
    }

    this.sql.exec("DELETE FROM org_info WHERE key = ?", "data");
    this.sql.exec("DELETE FROM members");
    this.sql.exec("DELETE FROM invitations");
    this.sql.exec("DELETE FROM integrations");
    this.sql.exec("DELETE FROM workspaces");
    this.sql.exec("DELETE FROM audit_log");
    this.sql.exec("DELETE FROM worker_scripts");
    this.sql.exec("DELETE FROM threads");
    this.sql.exec("DELETE FROM proxy_usage");

    console.log("[OrgDO] hard deleted org", {
      orgId: info.id,
      actorId,
    });
  }

  async getAuditLog(
    limit = 100,
    offset = 0,
  ): Promise<
    Array<{
      id: string;
      action: string;
      actor_id: string;
      target_id: string | null;
      details: string | null;
      created_at: number;
    }>
  > {
    const resolvedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const resolvedOffset = Math.max(0, Math.floor(offset));
    return this.sql
      .exec(
        "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?",
        resolvedLimit,
        resolvedOffset,
      )
      .toArray() as unknown as Array<{
      id: string;
      action: string;
      actor_id: string;
      target_id: string | null;
      details: string | null;
      created_at: number;
    }>;
  }

  // Thread methods (consolidated from ChatIndexDO)

  /**
   * Get all threads across all workspaces in this org
   */
  getThreads(): OrgThread[] {
    this.ensureThreadSchemaColumns();
    return this.sql
      .exec("SELECT * FROM threads ORDER BY updated_at DESC")
      .toArray() as unknown as OrgThread[];
  }

  /**
   * Get threads for a specific workspace
   */
  getThreadsByWorkspace(workspaceId: string): OrgThread[] {
    this.ensureThreadSchemaColumns();
    return this.sql
      .exec(
        "SELECT * FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC",
        workspaceId,
      )
      .toArray() as unknown as OrgThread[];
  }

  /**
   * Get threads with pagination (optionally filtered by workspace and creator)
   */
  getThreadsPaginated(
    offset = 0,
    limit = 50,
    workspaceId?: string,
    createdBy?: string,
  ): { items: OrgThread[]; total: number; offset: number; limit: number } {
    this.ensureThreadSchemaColumns();
    const resolvedOffset = Math.max(0, Math.floor(offset));
    const resolvedLimit = Math.max(1, Math.min(200, Math.floor(limit)));

    const whereClauses: string[] = [];
    const whereParams: (string | number)[] = [];

    if (workspaceId) {
      whereClauses.push("workspace_id = ?");
      whereParams.push(workspaceId);
    }
    if (createdBy) {
      whereClauses.push("created_by = ?");
      whereParams.push(createdBy);
    }

    const whereSql =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const items = this.sql
      .exec(
        `SELECT * FROM threads ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        ...whereParams,
        resolvedLimit,
        resolvedOffset,
      )
      .toArray() as unknown as OrgThread[];

    const totalRows = this.sql
      .exec(`SELECT COUNT(*) as count FROM threads ${whereSql}`, ...whereParams)
      .toArray() as Array<{ count: number }>;
    const total = Number(totalRows[0]?.count ?? 0);

    return {
      items,
      total,
      offset: resolvedOffset,
      limit: resolvedLimit,
    };
  }

  /**
   * Get threads across specific workspaces with pagination.
   */
  getThreadsAllWorkspacesPaginated(
    workspaceIds: string[],
    offset = 0,
    limit = 50,
    createdBy?: string,
  ): { items: OrgThread[]; total: number; offset: number; limit: number } {
    this.ensureThreadSchemaColumns();
    const resolvedOffset = Math.max(0, Math.floor(offset));
    const resolvedLimit = Math.max(1, Math.min(200, Math.floor(limit)));

    if (workspaceIds.length === 0) {
      return {
        items: [],
        total: 0,
        offset: resolvedOffset,
        limit: resolvedLimit,
      };
    }

    const placeholders = workspaceIds.map(() => "?").join(",");
    const whereClauses = [`workspace_id IN (${placeholders})`];
    const queryParams: (string | number)[] = [...workspaceIds];

    if (createdBy) {
      whereClauses.push("created_by = ?");
      queryParams.push(createdBy);
    }

    const whereSql = whereClauses.join(" AND ");

    const items = this.sql
      .exec(
        `SELECT * FROM threads WHERE ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        ...queryParams,
        resolvedLimit,
        resolvedOffset,
      )
      .toArray() as unknown as OrgThread[];

    const totalRows = this.sql
      .exec(
        `SELECT COUNT(*) as count FROM threads WHERE ${whereSql}`,
        ...queryParams,
      )
      .toArray() as Array<{ count: number }>;
    const total = Number(totalRows[0]?.count ?? 0);

    return {
      items,
      total,
      offset: resolvedOffset,
      limit: resolvedLimit,
    };
  }

  getThreadCreators(workspaceId?: string): Array<{
    created_by: string;
    thread_count: number;
    latest_updated_at: number;
  }> {
    this.ensureThreadSchemaColumns();

    const whereClauses: string[] = [];
    const params: string[] = [];

    if (workspaceId) {
      whereClauses.push("workspace_id = ?");
      params.push(workspaceId);
    }

    const whereSql =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    return this.sql
      .exec(
        `SELECT created_by, COUNT(*) as thread_count, MAX(updated_at) as latest_updated_at
         FROM threads ${whereSql}
         GROUP BY created_by
         ORDER BY latest_updated_at DESC`,
        ...params,
      )
      .toArray() as Array<{
      created_by: string;
      thread_count: number;
      latest_updated_at: number;
    }>;
  }

  getThreadCreatorsAllWorkspaces(workspaceIds: string[]): Array<{
    created_by: string;
    thread_count: number;
    latest_updated_at: number;
  }> {
    this.ensureThreadSchemaColumns();

    if (workspaceIds.length === 0) {
      return [];
    }

    const placeholders = workspaceIds.map(() => "?").join(", ");

    return this.sql
      .exec(
        `SELECT created_by, COUNT(*) as thread_count, MAX(updated_at) as latest_updated_at
         FROM threads
         WHERE workspace_id IN (${placeholders})
         GROUP BY created_by
         ORDER BY latest_updated_at DESC`,
        ...workspaceIds,
      )
      .toArray() as Array<{
      created_by: string;
      thread_count: number;
      latest_updated_at: number;
    }>;
  }

  /**
   * Create a new thread with a server-generated UUID
   */
  createThread(
    workspaceId: string,
    title: string | undefined,
    createdBy?: string,
    firstUserMessage?: string,
    model?: LlmModel,
    provider: "claude" | "codex" = "claude",
  ): OrgThread {
    this.ensureThreadSchemaColumns();
    const id = crypto.randomUUID();
    const now = Date.now();
    const t = title || DEFAULT_THREAD_TITLE;
    const creator = createdBy?.trim() || "system";
    const msg = firstUserMessage?.slice(0, 500) || null;
    const normalizedModel = normalizeLlmModel(model, provider);
    this.sql.exec(
      "INSERT INTO threads (id, workspace_id, title, provider, created_by, model, created_at, updated_at, first_user_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      workspaceId,
      t,
      provider,
      creator,
      normalizedModel,
      now,
      now,
      msg,
    );
    this.log("thread_created", creator, id, {
      workspace_id: workspaceId,
      title: t,
    });
    const thread = {
      id,
      workspace_id: workspaceId,
      title: t,
      provider,
      created_by: creator,
      model: normalizedModel,
      created_at: now,
      updated_at: now,
      user_message_count: 0,
      first_user_message: msg,
    };
    this.getInfo().then((info) => {
      if (info)
        dispatchAdminEvent(this.ctx, this.env, {
          type: "thread_upsert",
          payload: { ...thread, org_id: info.id },
        });
    });
    return thread;
  }

  /**
   * Get a thread by ID
   */
  getThread(id: string): OrgThread | null {
    this.ensureThreadSchemaColumns();
    const rows = this.sql
      .exec("SELECT * FROM threads WHERE id = ?", id)
      .toArray() as unknown as OrgThread[];
    return rows[0] || null;
  }

  // Test helper RPC: simulate a legacy thread schema before provider/model columns existed.
  async downgradeThreadSchemaForTest(): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DROP TABLE IF EXISTS threads_legacy_test");
      this.sql.exec(`
        CREATE TABLE threads_legacy_test (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'web',
          user_message_count INTEGER NOT NULL DEFAULT 0,
          first_user_message TEXT
        )
      `);
      this.sql.exec(`
        INSERT INTO threads_legacy_test (
          id,
          workspace_id,
          title,
          created_by,
          created_at,
          updated_at,
          source,
          user_message_count,
          first_user_message
        )
        SELECT
          id,
          workspace_id,
          title,
          created_by,
          created_at,
          updated_at,
          COALESCE(source, 'web'),
          COALESCE(user_message_count, 0),
          first_user_message
        FROM threads
      `);
      this.sql.exec("DROP TABLE threads");
      this.sql.exec("ALTER TABLE threads_legacy_test RENAME TO threads");
    });
    this.ctx.storage.kv.put("schemaVersion", 20);
  }

  /**
   * Update a thread's title
   */
  updateThread(id: string, title: string, actorId?: string): OrgThread | null {
    const existing = this.getThread(id);
    if (!existing) return null;
    const now = Date.now();
    this.sql.exec(
      "UPDATE threads SET title = ?, updated_at = ? WHERE id = ?",
      title,
      now,
      id,
    );
    if (actorId) {
      this.log("thread_updated", actorId, id, { title });
    }
    const updated = {
      ...existing,
      title,
      updated_at: now,
    };
    this.getInfo()
      .then((info) => {
        if (info)
          dispatchAdminEvent(this.ctx, this.env, {
            type: "thread_upsert",
            payload: { ...updated, org_id: info.id },
          });
      })
      .catch((err) => {
        console.error("Failed to sync thread update to AdminIndex", err);
      });
    return updated;
  }

  updateThreadModel(
    id: string,
    model: LlmModel,
    actorId?: string,
  ): OrgThread | null {
    const existing = this.getThread(id);
    if (!existing) return null;
    const normalizedModel = normalizeLlmModel(
      model,
      existing.provider ?? "claude",
    );
    if (normalizedModel !== existing.model) {
      return existing;
    }
    return existing;
  }

  /**
   * Set first user message used for welcome-screen previews.
   * This intentionally does not modify updated_at to avoid reordering threads.
   */
  setThreadFirstUserMessage(
    id: string,
    firstUserMessage: string,
  ): OrgThread | null {
    const existing = this.getThread(id);
    if (!existing) return null;

    const message = firstUserMessage.trim().slice(0, 500);
    if (!message) {
      return existing;
    }

    this.sql.exec(
      "UPDATE threads SET first_user_message = ? WHERE id = ? AND (first_user_message IS NULL OR first_user_message = '')",
      message,
      id,
    );

    return this.getThread(id);
  }

  /**
   * Admin: Update thread with arbitrary fields
   */
  adminUpdateThread(
    id: string,
    updates: { title?: string; created_by?: string; model?: LlmModel },
    actorId?: string,
  ): OrgThread | null {
    const existing = this.getThread(id);
    if (!existing) return null;
    const normalizedModel =
      updates.model !== undefined
        ? normalizeLlmModel(updates.model, existing.provider ?? "claude")
        : undefined;
    const persistedModel =
      normalizedModel === existing.model ? normalizedModel : undefined;
    const now = Date.now();

    const setClauses: string[] = ["updated_at = ?"];
    const params: (string | number)[] = [now];

    if (updates.title !== undefined) {
      setClauses.push("title = ?");
      params.push(updates.title);
    }
    if (updates.created_by !== undefined) {
      setClauses.push("created_by = ?");
      params.push(updates.created_by);
    }
    if (persistedModel !== undefined) {
      setClauses.push("model = ?");
      params.push(persistedModel);
    }

    params.push(id);
    this.sql.exec(
      `UPDATE threads SET ${setClauses.join(", ")} WHERE id = ?`,
      ...params,
    );

    if (actorId) {
      this.log("thread_admin_updated", actorId, id, updates);
    }

    const updated = {
      ...existing,
      title: updates.title ?? existing.title,
      created_by: updates.created_by ?? existing.created_by,
      model: persistedModel ?? existing.model,
      updated_at: now,
    };
    this.getInfo()
      .then((info) => {
        if (info)
          dispatchAdminEvent(this.ctx, this.env, {
            type: "thread_upsert",
            payload: { ...updated, org_id: info.id },
          });
      })
      .catch((err) => {
        console.error("Failed to sync admin thread update to AdminIndex", err);
      });
    return updated;
  }

  /**
   * Delete a thread
   */
  deleteThread(id: string, actorId?: string): boolean {
    const existing = this.getThread(id);
    if (!existing) return false;
    this.sql.exec("DELETE FROM threads WHERE id = ?", id);
    if (actorId) {
      this.log("thread_deleted", actorId, id, {
        workspace_id: existing.workspace_id,
      });
    }
    dispatchAdminEvent(this.ctx, this.env, {
      type: "thread_delete",
      payload: { id, workspace_id: existing.workspace_id },
    });
    return true;
  }

  /**
   * Touch a thread (update its updated_at timestamp and increment user message count)
   */
  touchThread(id: string): void {
    const existing = this.getThread(id);
    if (!existing) return;
    const now = Date.now();
    this.sql.exec(
      "UPDATE threads SET updated_at = ?, user_message_count = user_message_count + 1 WHERE id = ?",
      now,
      id,
    );
    const updated = {
      ...existing,
      updated_at: now,
      user_message_count: existing.user_message_count + 1,
    };
    this.getInfo()
      .then((info) => {
        if (info)
          dispatchAdminEvent(this.ctx, this.env, {
            type: "thread_upsert",
            payload: { ...updated, org_id: info.id },
          });
      })
      .catch((err) => {
        console.error("Failed to sync thread touch to AdminIndex", err);
      });
  }

  async validateChatThreadAccess(
    userId: string,
    workspaceId: string,
    threadId: string,
  ): Promise<OrgChatThreadAccessResult> {
    const info = await this.getInfo();
    if (!info || info.archived) {
      return { ok: false, reason: "org_not_found" };
    }

    if (!(await this.isMember(userId))) {
      return { ok: false, reason: "forbidden" };
    }

    const thread = this.getThread(threadId);
    if (!thread || thread.workspace_id !== workspaceId) {
      return { ok: false, reason: "thread_not_found" };
    }

    return {
      ok: true,
      orgId: info.id,
      orgSlug: info.slug || info.id.slice(0, 5),
      threadId,
    };
  }

  /**
   * Search threads by title across all workspaces in this org
   */
  searchThreads(query: string, limit = 50): OrgThread[] {
    const resolvedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const searchPattern = `%${query}%`;
    return this.sql
      .exec(
        "SELECT * FROM threads WHERE title LIKE ? ORDER BY updated_at DESC LIMIT ?",
        searchPattern,
        resolvedLimit,
      )
      .toArray() as unknown as OrgThread[];
  }

  // ─── LLM Provider BYOK Config ─────────────────────────────────

  getLlmProviderConfig(): {
    provider: string;
    credentials_encrypted: string;
    config: string;
    created_by: string;
    created_at: number;
    updated_at: number;
  } | null {
    const rows = this.sql
      .exec<{
        provider: string;
        credentials_encrypted: string;
        config: string;
        created_by: string;
        created_at: number;
        updated_at: number;
      }>(
        "SELECT provider, credentials_encrypted, config, created_by, created_at, updated_at FROM llm_provider_config WHERE id = 'active'",
      )
      .toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  setLlmProviderConfig(
    provider: string,
    credentialsEncrypted: string,
    config: string,
    createdBy: string,
  ): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO llm_provider_config (id, provider, credentials_encrypted, config, created_by, created_at, updated_at)
       VALUES ('active', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider = excluded.provider,
         credentials_encrypted = excluded.credentials_encrypted,
         config = excluded.config,
         created_by = excluded.created_by,
         updated_at = excluded.updated_at`,
      provider,
      credentialsEncrypted,
      config,
      createdBy,
      now,
      now,
    );
    const info = this.getInfoSync();
    if (info) {
      dispatchAdminEvent(this.ctx, this.env, {
        type: "org_llm_provider_update",
        payload: { org_id: info.id, provider, updated_at: now },
      });
    }
  }

  deleteLlmProviderConfig(): boolean {
    this.sql.exec("DELETE FROM llm_provider_config WHERE id = 'active'");
    const info = this.getInfoSync();
    if (info) {
      dispatchAdminEvent(this.ctx, this.env, {
        type: "org_llm_provider_update",
        payload: { org_id: info.id, provider: null, updated_at: null },
      });
    }
    return true;
  }

  getActiveThreadIdsForByokChange(targetProviders: ChatHarness[]): string[] {
    this.ensureThreadSchemaColumns();
    const normalizedProviders = Array.from(
      new Set(
        targetProviders.filter(
          (provider): provider is ChatHarness =>
            provider === "claude" || provider === "codex",
        ),
      ),
    );
    if (normalizedProviders.length === 0) {
      return [];
    }

    const activeSince = Date.now() - 30 * 60 * 1000;
    const placeholders = normalizedProviders.map(() => "?").join(",");
    return this.sql
      .exec<{ id: string }>(
        `SELECT id FROM threads WHERE updated_at > ? AND provider IN (${placeholders}) ORDER BY updated_at DESC`,
        activeSince,
        ...normalizedProviders,
      )
      .toArray()
      .flatMap((row) => (row.id ? [row.id] : []));
  }

  async notifyByokChanged(targetProviders: ChatHarness[]): Promise<number> {
    const threadIds = this.getActiveThreadIdsForByokChange(targetProviders);

    for (let index = 0; index < threadIds.length; index += 50) {
      const batch = threadIds.slice(index, index + 50);
      await Promise.allSettled(
        batch.map((threadId) => {
          const chatThread = this.env.CHAT_THREAD.get(
            this.env.CHAT_THREAD.idFromName(threadId),
          ) as unknown as {
            byokChanged(): Promise<void>;
          };

          return chatThread.byokChanged();
        }),
      );
    }

    return threadIds.length;
  }

  hasLlmProviderConfig(): boolean {
    const rows = this.sql
      .exec<{
        cnt: number;
      }>("SELECT COUNT(*) as cnt FROM llm_provider_config WHERE id = 'active'")
      .toArray();
    return (rows[0]?.cnt ?? 0) > 0;
  }

  /**
   * Record proxy usage for a user (rollup per user within the org).
   */
  recordProxyUsage(
    userId: string,
    usage: ProxyUsageInput,
    provider?: string | null,
    model?: string | null,
    tokenId?: string | null,
  ): void {
    const now = Date.now();
    const inputTokens = Math.max(0, Math.floor(usage.input_tokens ?? 0));
    const outputTokens = Math.max(0, Math.floor(usage.output_tokens ?? 0));
    const totalTokens = Math.max(
      0,
      Math.floor(usage.total_tokens ?? inputTokens + outputTokens),
    );
    const cacheCreationTokens = Math.max(
      0,
      Math.floor(usage.cache_creation_input_tokens ?? 0),
    );
    const cacheReadTokens = Math.max(
      0,
      Math.floor(usage.cache_read_input_tokens ?? 0),
    );

    this.sql.exec(
      `
      INSERT INTO proxy_usage (
        user_id,
        input_tokens,
        output_tokens,
        total_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        requests,
        last_provider,
        last_model,
        last_token_id,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        cache_creation_input_tokens = cache_creation_input_tokens + excluded.cache_creation_input_tokens,
        cache_read_input_tokens = cache_read_input_tokens + excluded.cache_read_input_tokens,
        requests = requests + 1,
        last_provider = excluded.last_provider,
        last_model = excluded.last_model,
        last_token_id = excluded.last_token_id,
        updated_at = excluded.updated_at
      `,
      userId,
      inputTokens,
      outputTokens,
      totalTokens,
      cacheCreationTokens,
      cacheReadTokens,
      1,
      provider ?? null,
      model ?? null,
      tokenId ?? null,
      now,
    );
  }
}
