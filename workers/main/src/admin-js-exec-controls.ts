import type { Organization } from "../../../src/types.js";
import {
  createOrg,
  createUser,
  resetOnboardingForUser,
} from "../../../src/lib/auth-do.js";
import type { AuthEnv } from "../../../src/lib/auth-helpers.js";
import type { CloudflareEnv } from "../../../src/lib/cloudflare.server.js";
import {
  hardDeleteAdminOrgWithEnv,
  hardDeleteAdminUserWithEnv,
} from "../../../src/lib/auth-do.server.js";
import {
  deleteStripeTestCustomerForOrg,
  getBillingAccessSnapshotForOrg,
} from "../../../src/lib/billing.server.js";
import type { Env } from "./types.js";
import {
  recordErrorEvent,
  recordObservabilityEvent,
} from "./observability.js";

export interface AdminJsExecActorCreateInput {
  email: string;
  password: string;
  name?: string | null;
}

export interface AdminJsExecBillingSnapshot {
  org_id: string;
  billing_status: string;
  billing_plan: string;
  billing_seat_count: number;
  billing_subscription_status: string | null;
  billing_trial_started_at: number | null;
  billing_trial_ends_at: number | null;
  billing_credit_purchase_total_cents: number;
  billing_credit_grant_total_cents: number;
  billing_trial_credit_grant_cents: number;
  billing_trial_credit_granted_at: number | null;
  billing_free_credit_grant_cents: number;
  billing_free_credit_granted_at: number | null;
  billing_credit_usage_started_at: number | null;
  chargeable_usage_cents: number;
  chargeable_request_count: number;
  total_credit_limit_cents: number;
  available_credits_cents: number;
  stripe_customer_configured: boolean;
  stripe_subscription_configured: boolean;
}

function authEnv(env: Env): AuthEnv {
  return env as unknown as AuthEnv;
}

function cloudflareEnv(env: Env): CloudflareEnv {
  return env as unknown as CloudflareEnv;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function integerCents(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(
      "Available credits must be a non-negative integer number of cents",
    );
  }
  return value;
}

function centsFromUsd(value: number): number {
  return Math.round(value * 100);
}

function auditControl(
  env: Env,
  adminUserId: string,
  operation: string,
  status: "success" | "error",
  ids: {
    userId?: string | null;
    orgId?: string | null;
    workspaceId?: string | null;
  },
  startedAt: number,
  error?: unknown,
): void {
  const base = {
    component: "admin-mcp",
    operation,
    status,
    userId: ids.userId ?? null,
    orgId: ids.orgId ?? null,
    workspaceId: ids.workspaceId ?? null,
    requestId: `admin:${adminUserId}`,
    durationMs: Date.now() - startedAt,
    sampleIndex: adminUserId,
  };
  if (status === "error") {
    recordErrorEvent(env, {
      ...base,
      event: "admin_js_exec_control_error",
      error,
    });
    return;
  }
  recordObservabilityEvent(env, {
    ...base,
    event: "admin_js_exec_control",
  });
}

async function loadOrg(env: Env, orgId: string): Promise<Organization> {
  const org = await env.ORG.get(env.ORG.idFromName(orgId)).getInfo();
  if (!org) throw new Error(`Organization not found: ${orgId}`);
  return org;
}

export async function getAdminJsExecBillingSnapshot(
  env: Env,
  orgIdInput: string,
): Promise<AdminJsExecBillingSnapshot> {
  const orgId = requiredString(orgIdInput, "Organization id");
  const org = await loadOrg(env, orgId);
  const usage = await env.ORG.get(env.ORG.idFromName(orgId)).getUsageLogSum(
    0,
    Date.now(),
    true,
  );
  const chargeableUsageCents = centsFromUsd(Number(usage.total_cost_usd ?? 0));
  const {
    billing_last_included_credit_invoice_id: _stripeInvoiceId,
    ...snapshot
  } = getBillingAccessSnapshotForOrg(org);
  void _stripeInvoiceId;
  const totalCreditLimitCents =
    snapshot.billing_credit_purchase_total_cents +
    snapshot.billing_credit_grant_total_cents;

  return {
    ...snapshot,
    chargeable_usage_cents: chargeableUsageCents,
    chargeable_request_count: Number(usage.total_requests ?? 0),
    total_credit_limit_cents: totalCreditLimitCents,
    available_credits_cents: Math.max(
      0,
      totalCreditLimitCents - chargeableUsageCents,
    ),
    stripe_customer_configured: Boolean(org.billing_customer_id),
    stripe_subscription_configured: Boolean(org.billing_subscription_id),
  };
}

export async function createAdminJsExecActor(
  env: Env,
  adminUserId: string,
  input: AdminJsExecActorCreateInput,
): Promise<{ userId: string; orgId: string; workspaceId: string }> {
  if (!input || typeof input !== "object") {
    throw new Error("IDENTITY.createActor requires an input object");
  }
  const email = requiredString(input.email, "Email").toLowerCase();
  const password = requiredString(input.password, "Password");
  const name = input.name == null ? null : requiredString(input.name, "Name");
  const startedAt = Date.now();
  let userId: string | null = null;
  let orgId: string | null = null;
  let workspaceId: string | null = null;

  try {
    const createdUser = await createUser(
      authEnv(env),
      email,
      password,
      name,
      null,
    );
    userId = createdUser.userId;
    const orgName = name || email.split("@")[0] || "E2E Account";
    const createdOrg = await createOrg(authEnv(env), orgName, userId);
    orgId = createdOrg.org.id;
    workspaceId = createdOrg.defaultWorkspaceId;

    const userStub = env.USER.get(env.USER.idFromName(userId));
    const verified = await userStub.markEmailVerified();
    if (!verified?.email_verified_at) {
      throw new Error("Failed to verify the created actor email");
    }
    await resetOnboardingForUser(authEnv(env), userId);

    auditControl(
      env,
      adminUserId,
      "identity_create_actor",
      "success",
      { userId, orgId, workspaceId },
      startedAt,
    );
    return { userId, orgId, workspaceId };
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (orgId) {
      await hardDeleteAdminOrgWithEnv(
        cloudflareEnv(env),
        orgId,
        adminUserId,
      ).catch((rollbackError) => {
        rollbackErrors.push(
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
        );
      });
    }
    if (userId) {
      await hardDeleteAdminUserWithEnv(
        cloudflareEnv(env),
        userId,
        adminUserId,
      ).catch((rollbackError) => {
        rollbackErrors.push(
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
        );
      });
    }
    const originalMessage =
      error instanceof Error ? error.message : String(error);
    const reportedError =
      rollbackErrors.length === 0
        ? error
        : new Error(
            `Actor creation failed (${originalMessage}) and rollback reported ${rollbackErrors.length} error(s): ${rollbackErrors.join("; ")}`,
          );
    auditControl(
      env,
      adminUserId,
      "identity_create_actor",
      "error",
      { userId, orgId, workspaceId },
      startedAt,
      reportedError,
    );
    throw reportedError;
  }
}

export async function resetAdminJsExecActor(
  env: Env,
  adminUserId: string,
  userIdInput: string,
): Promise<{ userId: string; onboardingReset: true }> {
  const userId = requiredString(userIdInput, "User id");
  const startedAt = Date.now();
  try {
    const profile = await env.USER.get(env.USER.idFromName(userId)).getProfile();
    if (!profile) throw new Error(`User not found: ${userId}`);
    await resetOnboardingForUser(authEnv(env), userId);
    auditControl(
      env,
      adminUserId,
      "identity_reset_actor",
      "success",
      { userId },
      startedAt,
    );
    return { userId, onboardingReset: true };
  } catch (error) {
    auditControl(
      env,
      adminUserId,
      "identity_reset_actor",
      "error",
      { userId },
      startedAt,
      error,
    );
    throw error;
  }
}

export async function deleteAdminJsExecActor(
  env: Env,
  adminUserId: string,
  userIdInput: string,
): Promise<{
  userId: string;
  alreadyDeleted: boolean;
  orgDeleted: boolean;
  deletedWorkspaces: number;
  deletedApps: number;
  removedOrgMemberships: number;
  warningCount: number;
}> {
  const userId = requiredString(userIdInput, "User id");
  const startedAt = Date.now();
  let orgId: string | null = null;
  try {
    const userStub = env.USER.get(env.USER.idFromName(userId));
    const profile = await userStub.getProfile();
    if (!profile) {
      auditControl(
        env,
        adminUserId,
        "identity_delete_actor",
        "success",
        { userId },
        startedAt,
      );
      return {
        userId,
        alreadyDeleted: true,
        orgDeleted: false,
        deletedWorkspaces: 0,
        deletedApps: 0,
        removedOrgMemberships: 0,
        warningCount: 0,
      };
    }
    const memberships = await userStub.getOrgs();
    if (memberships.length > 1) {
      throw new Error(
        "IDENTITY.deleteActor refuses users with more than one organization",
      );
    }

    let deletedWorkspaces = 0;
    let deletedApps = 0;
    let removedOrgMemberships = 0;
    let warningCount = 0;
    if (memberships.length === 1) {
      orgId = memberships[0]!.org_id;
      const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
      const [org, members] = await Promise.all([
        orgStub.getInfo(),
        orgStub.getMembers(),
      ]);
      if (!org) throw new Error(`Organization not found: ${orgId}`);
      if (org.billing_customer_id || org.billing_subscription_id) {
        throw new Error(
          "IDENTITY.deleteActor requires BILLING.deleteTestCustomer first when Stripe objects are linked",
        );
      }
      if (
        org.created_by !== userId ||
        members.length !== 1 ||
        members[0]?.user_id !== userId ||
        members[0]?.role !== "owner"
      ) {
        throw new Error(
          "IDENTITY.deleteActor only deletes a sole-owner organization created by the actor",
        );
      }
      const orgResult = await hardDeleteAdminOrgWithEnv(
        cloudflareEnv(env),
        orgId,
        adminUserId,
      );
      deletedWorkspaces = orgResult.deleted_workspaces;
      deletedApps = orgResult.deleted_apps;
      removedOrgMemberships += orgResult.removed_memberships;
      warningCount += orgResult.warnings.length;
    }

    const userResult = await hardDeleteAdminUserWithEnv(
      cloudflareEnv(env),
      userId,
      adminUserId,
    );
    removedOrgMemberships += userResult.removed_org_memberships;
    warningCount += userResult.warnings.length;
    auditControl(
      env,
      adminUserId,
      "identity_delete_actor",
      "success",
      { userId, orgId },
      startedAt,
    );
    return {
      userId,
      alreadyDeleted: false,
      orgDeleted: Boolean(orgId),
      deletedWorkspaces,
      deletedApps,
      removedOrgMemberships,
      warningCount,
    };
  } catch (error) {
    auditControl(
      env,
      adminUserId,
      "identity_delete_actor",
      "error",
      { userId, orgId },
      startedAt,
      error,
    );
    throw error;
  }
}

export async function setAdminJsExecAvailableCredits(
  env: Env,
  adminUserId: string,
  orgIdInput: string,
  centsInput: number,
): Promise<{
  orgId: string;
  previous: AdminJsExecBillingSnapshot;
  current: AdminJsExecBillingSnapshot;
}> {
  const orgId = requiredString(orgIdInput, "Organization id");
  const cents = integerCents(centsInput);
  const startedAt = Date.now();
  try {
    const previous = await getAdminJsExecBillingSnapshot(env, orgId);
    const nextGrant =
      cents +
      previous.chargeable_usage_cents -
      previous.billing_credit_purchase_total_cents;
    const updated = await env.ORG.get(
      env.ORG.idFromName(orgId),
    ).updateBillingState({
      billing_credit_grant_total_cents: nextGrant,
    });
    if (!updated) throw new Error(`Organization not found: ${orgId}`);
    const current = await getAdminJsExecBillingSnapshot(env, orgId);
    if (current.available_credits_cents !== cents) {
      throw new Error(
        `Failed to set available credits to ${cents}; observed ${current.available_credits_cents}`,
      );
    }
    auditControl(
      env,
      adminUserId,
      "billing_set_available_credits",
      "success",
      { orgId },
      startedAt,
    );
    return { orgId, previous, current };
  } catch (error) {
    auditControl(
      env,
      adminUserId,
      "billing_set_available_credits",
      "error",
      { orgId },
      startedAt,
      error,
    );
    throw error;
  }
}

export async function deleteAdminJsExecTestCustomer(
  env: Env,
  adminUserId: string,
  orgIdInput: string,
): Promise<{
  orgId: string;
  alreadyDeleted: boolean;
  subscriptionDeleted: boolean;
  customerDeleted: boolean;
  billing: AdminJsExecBillingSnapshot | null;
}> {
  const orgId = requiredString(orgIdInput, "Organization id");
  const startedAt = Date.now();
  try {
    if (env.STRIPE_MODE?.trim().toLowerCase() !== "test") {
      throw new Error("Stripe test customer deletion requires STRIPE_MODE=test");
    }
    const org = await env.ORG.get(env.ORG.idFromName(orgId)).getInfo();
    if (!org) {
      auditControl(
        env,
        adminUserId,
        "billing_delete_test_customer",
        "success",
        { orgId },
        startedAt,
      );
      return {
        orgId,
        alreadyDeleted: true,
        subscriptionDeleted: false,
        customerDeleted: false,
        billing: null,
      };
    }
    const result = await deleteStripeTestCustomerForOrg(env, org);
    const billing = await getAdminJsExecBillingSnapshot(env, orgId);
    auditControl(
      env,
      adminUserId,
      "billing_delete_test_customer",
      "success",
      { orgId },
      startedAt,
    );
    return {
      orgId,
      alreadyDeleted: false,
      subscriptionDeleted: result.subscription_deleted,
      customerDeleted: result.customer_deleted,
      billing,
    };
  } catch (error) {
    auditControl(
      env,
      adminUserId,
      "billing_delete_test_customer",
      "error",
      { orgId },
      startedAt,
      error,
    );
    throw error;
  }
}
