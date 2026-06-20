/**
 * Provider-agnostic reverse-proxy silent login and provisioning.
 *
 * Shared by the Cloudflare Access (`cloudflare-access-auth.server.ts`) and
 * Pomerium (`pomerium-auth.server.ts`) app-side wrappers. Given a
 * {@link ProxyAuthProvider}, this verifies the assertion, provisions the user
 * and mapped org(s), and mints the same HMAC-signed session cookie used by
 * password/OAuth login (tagged with the provider's `auth_source`).
 */

import type { Organization, User } from "@/types";
import type { AuthEnv, SessionData } from "./auth-helpers";
import { isSelfhostRuntime } from "./selfhost-runtime";
import {
  createSession,
  createUserFromOAuth,
  getUserByEmail,
  linkOAuthProvider,
} from "./auth-do";
import { isOrgBanned, isUserBanned } from "../../workers/main/src/ban-list";
import type { SignedSessionData } from "../../workers/main/src/signed-session";
import {
  ProxyAuthUnavailableError,
  emailMatchesRequiredDomain,
  firstString,
  humanizeOrgName,
  normalizeEmail,
  resolveOrgCandidates,
  validateProxyIdentityMapsToOrg,
  verifyProxyJwt,
  type ProxyAuthConfig,
  type ProxyAuthEnv,
  type ProxyAuthProvider,
  type ProxyAuthValidationEnv,
  type ProxyOrgCandidate,
} from "../../workers/main/src/helpers/proxy-auth-core";
import { providerForAuthSource } from "../../workers/main/src/helpers/proxy-auth-providers";

export interface ProxyAuthSessionResult {
  session: SessionData;
  signedToken: string;
  user: User;
  orgs: Organization[];
}

/**
 * Attempt a silent login for `provider`. Returns null when the provider's
 * assertion header is absent or the provider is not configured (so normal
 * login proceeds). Throws a `Response` (403/503) for a present-but-invalid or
 * temporarily-unavailable assertion.
 */
export async function tryProxySilentLogin(
  request: Request,
  env: ProxyAuthEnv,
  authEnv: AuthEnv,
  provider: ProxyAuthProvider,
): Promise<ProxyAuthSessionResult | null> {
  const token = request.headers.get(provider.jwtHeader);
  if (!token) return null;

  const config = provider.getConfig(env);
  if (!config) return null;

  let payload;
  try {
    payload = await verifyProxyJwt(token, config);
  } catch (error) {
    if (error instanceof ProxyAuthUnavailableError) {
      throw new Response("Identity proxy is temporarily unavailable", {
        status: 503,
      });
    }
    throw new Response(
      error instanceof Error ? error.message : "Invalid identity proxy JWT",
      { status: 403 },
    );
  }

  const email = normalizeEmail(payload.email);
  if (!email) {
    throw new Response("Identity proxy assertion is missing an email claim", {
      status: 403,
    });
  }
  if (!emailMatchesRequiredDomain(email, config)) {
    throw new Response("Identity proxy email domain is not allowed", {
      status: 403,
    });
  }
  await assertProxyUserNotBanned(authEnv, email);

  let identity;
  try {
    identity = await provider.resolveIdentity(request, token, payload, config);
  } catch (error) {
    if (!(error instanceof ProxyAuthUnavailableError)) throw error;
    // Without the identity document, group/claim org candidates cannot be
    // resolved; proceeding would silently sign the user into the wrong org or
    // 403 them as de-provisioned.
    console.warn("[proxy-auth] identity unavailable", {
      provider: provider.authSource,
      error: error.message,
    });
    throw new Response("Identity proxy identity is temporarily unavailable", {
      status: 503,
    });
  }

  const providerId =
    firstString(identity?.user_uuid, payload.sub, identity?.email, email) ??
    email;
  const name = firstString(identity?.name, payload.name) ?? nameFromEmail(email);

  const { userId, user } = await findOrCreateProxyUser(
    authEnv,
    provider,
    email,
    name,
    providerId,
  );
  const candidates = resolveOrgCandidates(config, payload, identity);
  const ensuredOrgs = await ensureProxyOrgs(
    authEnv,
    config,
    provider,
    candidates,
    userId,
  );
  if (ensuredOrgs.length === 0) {
    throw new Response(
      "Identity proxy assertion did not map to an organization",
      { status: 403 },
    );
  }

  const selected = ensuredOrgs[0];
  const { signedToken, sessionData } = await createSession(
    authEnv,
    userId,
    selected.org.id,
    selected.workspaceId,
    { name: user.name, email: user.email },
    { authSource: provider.authSource as SignedSessionData["auth_source"] },
  );

  return {
    session: sessionData,
    signedToken,
    user,
    orgs: ensuredOrgs.map((entry) => entry.org),
  };
}

/**
 * Guard for routes that mint or re-sign a session cookie for `orgId`. A
 * proxy-backed cookie is only accepted for orgs the live identity maps to, so
 * switching into an unmapped org would mint a cookie that every subsequent
 * request rejects. Returns an error Response to send back, or null when the
 * switch is allowed (including for non-proxy sessions).
 */
export async function requireProxyMappedOrg(
  request: Request,
  env: unknown,
  session: { auth_source?: string | null; user_email?: string | null },
  orgId: string,
): Promise<Response | null> {
  const provider = providerForAuthSource(session.auth_source);
  if (!provider) return null;
  const validation = await validateProxyIdentityMapsToOrg(
    request,
    env as ProxyAuthValidationEnv,
    provider,
    session.user_email,
    orgId,
  );
  if (validation === "unavailable") {
    return Response.json(
      { error: "Identity proxy validation is temporarily unavailable" },
      { status: 503 },
    );
  }
  if (validation !== "valid") {
    return Response.json(
      { error: "Your login does not include this organization" },
      { status: 403 },
    );
  }
  return null;
}

async function findOrCreateProxyUser(
  authEnv: AuthEnv,
  provider: ProxyAuthProvider,
  email: string,
  name: string,
  providerId: string,
): Promise<{ userId: string; user: User }> {
  const existing = await getUserByEmail(authEnv, email);
  if (existing) {
    await assertProxyUserNotBanned(authEnv, email, existing.userId);
    await linkOAuthProvider(
      authEnv,
      existing.userId,
      provider.oauthProvider,
      providerId,
    );
    return existing;
  }
  return createUserFromOAuth(
    authEnv,
    email,
    name,
    provider.oauthProvider,
    providerId,
  );
}

async function ensureProxyOrgs(
  authEnv: AuthEnv,
  config: ProxyAuthConfig,
  provider: ProxyAuthProvider,
  candidates: ProxyOrgCandidate[],
  userId: string,
): Promise<Array<{ org: Organization; workspaceId: string | null }>> {
  const ensured: Array<{ org: Organization; workspaceId: string | null }> = [];
  for (const candidate of candidates) {
    const kvKey = `${config.kvPrefix}${config.namespace}:${candidate.key}`;
    let orgId = await authEnv.APP_KV.get(kvKey);
    let org: Organization | null = orgId
      ? await authEnv.ORG.get(authEnv.ORG.idFromName(orgId)).getInfo()
      : null;
    let workspaceId: string | null = null;

    if (!org) {
      if (candidate.role !== "admin" && !candidate.initializesOrg) {
        // A member cannot initialize a prefix-derived org; skip so a later
        // admin or org-initializing candidate can still create its org. If
        // nothing resolves, the caller rejects with 403.
        continue;
      }
      const lockStub = authEnv.ORG.get(
        authEnv.ORG.idFromName(`${config.lockPrefix}${kvKey}`),
      );
      const created = await lockStub.ensureAccessMappedOrg(
        kvKey,
        candidate.name,
        userId,
        candidate.initializesOrg ? "admin" : candidate.role,
      );
      org = created.org;
      orgId = org.id;
      workspaceId = created.defaultWorkspaceId;
    }
    const orgBan = await isOrgBanned(authEnv.APP_KV, { orgId: org.id });
    if (orgBan) {
      throw new Response("Identity proxy organization is blocked", {
        status: 403,
      });
    }
    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(org.id));
    if (isSelfhostRuntime(authEnv) && org.billing_status !== "enterprise") {
      const updatedOrg = await orgStub.updateBillingState({
        billing_status: "enterprise",
        billing_plan: "enterprise",
        billing_seat_count: Math.max(org.billing_seat_count ?? 1, 1),
      });
      if (updatedOrg) org = updatedOrg;
    }
    const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
    if (!workspaceId) {
      const [workspaces, userOrgs] = await Promise.all([
        orgStub.getWorkspaces(),
        userStub.getOrgs(),
      ]);
      const activeWorkspaces = workspaces.filter(
        (workspace) => !workspace.archived,
      );
      // Prefer the user's recorded last workspace so repeated silent logins do
      // not reset them to the org default.
      const lastWorkspaceId = userOrgs.find(
        (entry) => entry.org_id === org.id,
      )?.last_workspace_id;
      workspaceId =
        activeWorkspaces.find((workspace) => workspace.id === lastWorkspaceId)
          ?.id ??
        activeWorkspaces[0]?.id ??
        null;
    }
    const existingMember = await orgStub.getMember(userId);
    if (!existingMember) {
      await orgStub.addMember(userId, candidate.role, provider.membershipSource);
    } else if (
      existingMember.role !== "owner" &&
      existingMember.role !== candidate.role
    ) {
      await orgStub.updateMemberRole(
        userId,
        candidate.role,
        provider.membershipSource,
      );
    }
    if (!(await userStub.hasOrg(org.id))) {
      await userStub.addOrg(org.id, candidate.role, workspaceId);
    } else if (existingMember?.role !== "owner") {
      await userStub.updateOrgRole(org.id, candidate.role);
    }

    if (workspaceId) {
      const workspaceStub = authEnv.WORKSPACE.get(
        authEnv.WORKSPACE.idFromName(workspaceId),
      );
      await orgStub.setWorkspaceAccess(
        workspaceId,
        userId,
        "full",
        provider.membershipSource,
      );
      await workspaceStub.setMemberAccess(
        userId,
        "full",
        provider.membershipSource,
      );
      await userStub.setOrgLastWorkspace(org.id, workspaceId);
    }

    ensured.push({ org, workspaceId });
  }
  return ensured;
}

async function assertProxyUserNotBanned(
  authEnv: AuthEnv,
  email: string,
  userId?: string,
): Promise<void> {
  const ban = await isUserBanned(authEnv.APP_KV, { userId, email });
  if (ban) {
    throw new Response("Identity proxy identity is blocked", { status: 403 });
  }
}

function nameFromEmail(email: string): string {
  return humanizeOrgName(email.split("@")[0] ?? email);
}
