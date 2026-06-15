import type { User, Organization } from "@/types";
import type { AuthEnv, SessionData } from "./auth-helpers";
import {
  createSession,
  createUserFromOAuth,
  getUserByEmail,
  linkOAuthProvider,
} from "./auth-do";
import { isOrgBanned, isUserBanned } from "../../workers/main/src/ban-list";
import {
  ACCESS_JWT_HEADER,
  CLOUDFLARE_ACCESS_AUTH_SOURCE,
  ORG_KV_PREFIX,
  ORG_LOCK_PREFIX,
  CloudflareAccessUnavailableError,
  emailMatchesRequiredDomain,
  fetchAccessIdentity,
  firstString,
  getAccessConfig,
  humanizeOrgName,
  normalizeEmail,
  resolveOrgCandidates,
  validateAccessIdentityMapsToOrg,
  verifyAccessJwt,
  type AccessConfig,
  type AccessIdentity,
  type AccessOrgCandidate,
  type AccessValidationEnv,
  type CloudflareAccessEnv,
} from "../../workers/main/src/helpers/access-session";

export {
  CLOUDFLARE_ACCESS_AUTH_SOURCE,
  validateAccessBackedSignedSession,
  validateAccessIdentityMapsToOrg,
  type AccessValidationEnv,
  type CloudflareAccessEnv,
} from "../../workers/main/src/helpers/access-session";

/**
 * Guard for routes that mint or re-sign a session cookie for `orgId`. An
 * Access-backed cookie is only accepted for orgs the live Access identity
 * maps to, so switching into an unmapped org would mint a cookie that every
 * subsequent request rejects. Returns an error Response to send back, or
 * null when the switch is allowed (including for non-Access sessions).
 */
export async function requireAccessMappedOrg(
  request: Request,
  env: unknown,
  session: { auth_source?: string | null; user_email?: string | null },
  orgId: string,
): Promise<Response | null> {
  if (session.auth_source !== CLOUDFLARE_ACCESS_AUTH_SOURCE) return null;
  const validation = await validateAccessIdentityMapsToOrg(
    request,
    env as AccessValidationEnv,
    session.user_email,
    orgId,
  );
  if (validation === "unavailable") {
    return Response.json(
      { error: "Cloudflare Access validation is temporarily unavailable" },
      { status: 503 },
    );
  }
  if (validation !== "valid") {
    return Response.json(
      { error: "Your Cloudflare Access login does not include this organization" },
      { status: 403 },
    );
  }
  return null;
}

export interface CloudflareAccessSessionResult {
  session: SessionData;
  signedToken: string;
  user: User;
  orgs: Organization[];
}

export function isCloudflareAccessConfigured(env: CloudflareAccessEnv): boolean {
  return Boolean(getAccessConfig(env));
}

export function getCloudflareAccessLogoutUrl(
  request: Request,
  env: CloudflareAccessEnv,
): string | null {
  if (!getAccessConfig(env)) return null;
  return new URL("/cdn-cgi/access/logout", request.url).toString();
}

export async function tryCloudflareAccessSilentLogin(
  request: Request,
  env: CloudflareAccessEnv,
  authEnv: AuthEnv,
): Promise<CloudflareAccessSessionResult | null> {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) return null;

  const config = getAccessConfig(env);
  if (!config) return null;

  let payload;
  try {
    payload = await verifyAccessJwt(token, config);
  } catch (error) {
    if (error instanceof CloudflareAccessUnavailableError) {
      throw new Response("Cloudflare Access is temporarily unavailable", {
        status: 503,
      });
    }
    throw new Response(
      error instanceof Error ? error.message : "Invalid Cloudflare Access JWT",
      { status: 403 },
    );
  }
  const email = normalizeEmail(payload.email);
  if (!email) {
    throw new Response("Cloudflare Access identity is missing an email claim", {
      status: 403,
    });
  }
  if (!emailMatchesRequiredDomain(email, config)) {
    throw new Response("Cloudflare Access email domain is not allowed", {
      status: 403,
    });
  }
  await assertAccessUserNotBanned(authEnv, email);

  let identity: AccessIdentity | null;
  try {
    identity = await fetchAccessIdentity(request, token, config);
  } catch (error) {
    if (!(error instanceof CloudflareAccessUnavailableError)) throw error;
    // Without the identity document, group/claim org candidates cannot be
    // resolved; proceeding would silently sign the user into the wrong org or
    // 403 them as de-provisioned.
    console.warn("[cloudflare-access] identity endpoint unavailable", {
      error: error.message,
    });
    throw new Response(
      "Cloudflare Access identity is temporarily unavailable",
      { status: 503 },
    );
  }
  const providerId =
    firstString(identity?.user_uuid, payload.sub, identity?.email, email) ??
    email;
  const name =
    firstString(identity?.name, payload.name) ??
    nameFromEmail(email);

  const { userId, user } = await findOrCreateAccessUser(
    authEnv,
    email,
    name,
    providerId,
  );
  const candidates = resolveOrgCandidates(config, payload, identity);
  const ensuredOrgs = await ensureAccessOrgs(authEnv, config, candidates, userId);
  if (ensuredOrgs.length === 0) {
    throw new Response("Cloudflare Access identity did not map to an organization", {
      status: 403,
    });
  }

  const selected = ensuredOrgs[0];
  const { signedToken, sessionData } = await createSession(
    authEnv,
    userId,
    selected.org.id,
    selected.workspaceId,
    { name: user.name, email: user.email },
    { authSource: CLOUDFLARE_ACCESS_AUTH_SOURCE },
  );

  return {
    session: sessionData,
    signedToken,
    user,
    orgs: ensuredOrgs.map((entry) => entry.org),
  };
}

async function findOrCreateAccessUser(
  authEnv: AuthEnv,
  email: string,
  name: string,
  providerId: string,
): Promise<{ userId: string; user: User }> {
  const existing = await getUserByEmail(authEnv, email);
  if (existing) {
    await assertAccessUserNotBanned(authEnv, email, existing.userId);
    await linkOAuthProvider(
      authEnv,
      existing.userId,
      "cloudflare_access",
      providerId,
    );
    return existing;
  }
  return createUserFromOAuth(
    authEnv,
    email,
    name,
    "cloudflare_access",
    providerId,
  );
}

async function ensureAccessOrgs(
  authEnv: AuthEnv,
  config: AccessConfig,
  candidates: AccessOrgCandidate[],
  userId: string,
): Promise<Array<{ org: Organization; workspaceId: string | null }>> {
  const ensured: Array<{ org: Organization; workspaceId: string | null }> = [];
  for (const candidate of candidates) {
    const kvKey = `${ORG_KV_PREFIX}${config.teamDomain}:${candidate.key}`;
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
        authEnv.ORG.idFromName(`${ORG_LOCK_PREFIX}${kvKey}`),
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
      throw new Response("Cloudflare Access organization is blocked", {
        status: 403,
      });
    }
    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(org.id));
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
      await orgStub.addMember(userId, candidate.role, "cloudflare-access");
    } else if (
      existingMember.role !== "owner" &&
      existingMember.role !== candidate.role
    ) {
      await orgStub.updateMemberRole(
        userId,
        candidate.role,
        "cloudflare-access",
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
        "cloudflare-access",
      );
      await workspaceStub.setMemberAccess(userId, "full", "cloudflare-access");
      await userStub.setOrgLastWorkspace(org.id, workspaceId);
    }

    ensured.push({ org, workspaceId });
  }
  return ensured;
}

async function assertAccessUserNotBanned(
  authEnv: AuthEnv,
  email: string,
  userId?: string,
): Promise<void> {
  const ban = await isUserBanned(authEnv.APP_KV, { userId, email });
  if (ban) {
    throw new Response("Cloudflare Access identity is blocked", {
      status: 403,
    });
  }
}

function nameFromEmail(email: string): string {
  return humanizeOrgName(email.split("@")[0] ?? email);
}
