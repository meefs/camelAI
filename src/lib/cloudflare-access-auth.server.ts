import type { User, Organization, OrgRole } from "@/types";
import type { AuthEnv, SessionData } from "./auth-helpers";
import {
  createOrg,
  createSession,
  createUserFromOAuth,
  getUserByEmail,
  linkOAuthProvider,
} from "./auth-do";

const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const ACCESS_COOKIE_NAME = "CF_Authorization";
const ORG_KV_PREFIX = "cloudflare_access:org:";

type JsonObject = Record<string, unknown>;

export interface CloudflareAccessEnv {
  APP_KV: KVNamespace;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_AUDS?: string;
  CLOUDFLARE_ACCESS_ORG_MAP?: string;
  CLOUDFLARE_ACCESS_ORG_CLAIMS?: string;
  CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX?: string;
  CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX?: string;
  CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME?: string;
  CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN?: string;
}

export interface CloudflareAccessSessionResult {
  session: SessionData;
  signedToken: string;
  user: User;
  orgs: Organization[];
}

interface AccessJwtPayload extends JsonObject {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  name?: string;
  nbf?: number;
  sub?: string;
}

interface AccessIdentity {
  email?: unknown;
  name?: unknown;
  user_uuid?: unknown;
  account_id?: unknown;
  idp?: unknown;
  [key: string]: unknown;
}

interface AccessOrgCandidate {
  key: string;
  name: string;
  role: OrgRole;
}

interface AccessConfig {
  teamDomain: string;
  audiences: string[];
  orgClaimPaths: string[];
  orgMap: Record<string, string>;
  orgGroupPrefix: string | null;
  adminGroupPrefix: string | null;
  defaultOrgName: string | null;
  requiredEmailDomain: string | null;
}

export function isCloudflareAccessConfigured(env: CloudflareAccessEnv): boolean {
  return Boolean(getAccessConfig(env));
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

  const payload = await verifyAccessJwt(token, config);
  const email = normalizeEmail(payload.email);
  if (!email) {
    throw new Response("Cloudflare Access identity is missing an email claim", {
      status: 403,
    });
  }
  if (
    config.requiredEmailDomain &&
    !email.endsWith(`@${config.requiredEmailDomain}`)
  ) {
    throw new Response("Cloudflare Access email domain is not allowed", {
      status: 403,
    });
  }

  const identity = await fetchAccessIdentity(request, token, config).catch(
    (error) => {
      console.warn("[cloudflare-access] failed to fetch full identity", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    },
  );
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
  );

  return {
    session: sessionData,
    signedToken,
    user,
    orgs: ensuredOrgs.map((entry) => entry.org),
  };
}

function getAccessConfig(env: CloudflareAccessEnv): AccessConfig | null {
  const teamDomain = normalizeTeamDomain(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN);
  const audiences = parseList(env.CLOUDFLARE_ACCESS_AUDS);
  if (env.CLOUDFLARE_ACCESS_AUD?.trim()) {
    audiences.push(env.CLOUDFLARE_ACCESS_AUD.trim());
  }
  const uniqueAudiences = [...new Set(audiences)];
  if (!teamDomain || uniqueAudiences.length === 0) return null;

  return {
    teamDomain,
    audiences: uniqueAudiences,
    orgClaimPaths: parseList(env.CLOUDFLARE_ACCESS_ORG_CLAIMS),
    orgMap: parseOrgMap(env.CLOUDFLARE_ACCESS_ORG_MAP),
    orgGroupPrefix: normalizedOptional(env.CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX),
    adminGroupPrefix: normalizedOptional(env.CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX),
    defaultOrgName: normalizedOptional(env.CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME),
    requiredEmailDomain: normalizedOptional(
      env.CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN,
    )?.toLowerCase() ?? null,
  };
}

function normalizeTeamDomain(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizedOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseOrgMap(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      if (typeof raw === "string" && raw.trim()) {
        result[key] = raw.trim();
      } else if (
        raw &&
        typeof raw === "object" &&
        typeof (raw as { name?: unknown }).name === "string"
      ) {
        result[key] = (raw as { name: string }).name.trim();
      }
    }
    return result;
  } catch {
    return {};
  }
}

async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
): Promise<AccessJwtPayload> {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Response("Invalid Cloudflare Access JWT", { status: 403 });
  }

  const header = decodeJwtPart<JsonObject>(encodedHeader);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Response("Unsupported Cloudflare Access JWT", { status: 403 });
  }

  const jwksResponse = await fetch(`${config.teamDomain}/cdn-cgi/access/certs`);
  if (!jwksResponse.ok) {
    throw new Response("Unable to load Cloudflare Access signing keys", {
      status: 403,
    });
  }
  const jwks = (await jwksResponse.json()) as { keys?: JsonObject[] };
  const jwk = jwks.keys?.find((key) => key.kid === header.kid);
  if (!jwk) {
    throw new Response("Cloudflare Access signing key was not found", {
      status: 403,
    });
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64urlDecode(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) {
    throw new Response("Cloudflare Access JWT signature is invalid", {
      status: 403,
    });
  }

  const payload = decodeJwtPart<AccessJwtPayload>(encodedPayload);
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== config.teamDomain) {
    throw new Response("Cloudflare Access issuer is invalid", { status: 403 });
  }
  if (typeof payload.exp === "number" && payload.exp <= now) {
    throw new Response("Cloudflare Access JWT is expired", { status: 403 });
  }
  if (typeof payload.nbf === "number" && payload.nbf > now) {
    throw new Response("Cloudflare Access JWT is not active yet", { status: 403 });
  }
  const tokenAudiences = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === "string"
      ? [payload.aud]
      : [];
  if (!tokenAudiences.some((audience) => config.audiences.includes(audience))) {
    throw new Response("Cloudflare Access audience is invalid", { status: 403 });
  }
  return payload;
}

async function fetchAccessIdentity(
  request: Request,
  token: string,
  config: AccessConfig,
): Promise<AccessIdentity | null> {
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    [ACCESS_JWT_HEADER]: token,
  });
  const accessCookie = extractCookie(request.headers.get("Cookie"), ACCESS_COOKIE_NAME);
  if (accessCookie) {
    headers.set("Cookie", `${ACCESS_COOKIE_NAME}=${accessCookie}`);
  }
  const identityUrl = new URL("/cdn-cgi/access/get-identity", config.teamDomain);
  const response = await fetch(
    identityUrl.toString(),
    { headers },
  );
  if (!response.ok) return null;
  return (await response.json()) as AccessIdentity;
}

async function findOrCreateAccessUser(
  authEnv: AuthEnv,
  email: string,
  name: string,
  providerId: string,
): Promise<{ userId: string; user: User }> {
  const existing = await getUserByEmail(authEnv, email);
  if (existing) {
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

function resolveOrgCandidates(
  config: AccessConfig,
  payload: AccessJwtPayload,
  identity: AccessIdentity | null,
): AccessOrgCandidate[] {
  const root = { jwt: payload, ...(identity ?? {}) };
  const candidates: AccessOrgCandidate[] = [];

  for (const [key, name] of Object.entries(config.orgMap)) {
    if (identityContainsValue(root, key)) {
      candidates.push({ key: `map:${key}`, name, role: "member" });
    }
  }

  const claimPaths = config.orgClaimPaths.length > 0
    ? config.orgClaimPaths
    : ["idp.name", "idp.id", "officeLocation"];
  for (const path of claimPaths) {
    for (const value of valuesAtPath(root, path)) {
      candidates.push({
        key: `${path}:${value}`,
        name: config.orgMap[value] ?? humanizeOrgName(value),
        role: "member",
      });
    }
  }

  if (config.orgGroupPrefix) {
    for (const group of accessGroupValues(root)) {
      if (!group.startsWith(config.orgGroupPrefix)) continue;
      if (config.adminGroupPrefix && group.startsWith(config.adminGroupPrefix)) {
        continue;
      }
      const rawName = group.slice(config.orgGroupPrefix.length).trim();
      if (!rawName) continue;
      const name = config.orgMap[group] ?? humanizeOrgName(rawName);
      candidates.push({
        key: `group:${orgKeyFromName(name)}`,
        name,
        role: "member",
      });
    }
  }

  if (config.adminGroupPrefix) {
    for (const group of accessGroupValues(root)) {
      if (!group.startsWith(config.adminGroupPrefix)) continue;
      const rawName = group.slice(config.adminGroupPrefix.length).trim();
      if (!rawName) continue;
      const name = config.orgMap[group] ?? humanizeOrgName(rawName);
      candidates.push({
        key: `group:${orgKeyFromName(name)}`,
        name,
        role: "admin",
      });
    }
  }

  if (candidates.length === 0 && config.defaultOrgName) {
    candidates.push({
      key: `default:${config.defaultOrgName}`,
      name: config.defaultOrgName,
      role: "member",
    });
  }

  const deduped = new Map<string, AccessOrgCandidate>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.key);
    if (!existing || existing.role === "member" && candidate.role === "admin") {
      deduped.set(candidate.key, candidate);
    }
  }
  return [...deduped.values()];
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
      const created = await createOrg(authEnv, candidate.name, userId);
      org = created.org;
      orgId = org.id;
      workspaceId = created.defaultWorkspaceId;
      await authEnv.APP_KV.put(kvKey, orgId);
    } else {
      const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(org.id));
      const workspaces = await orgStub.getWorkspaces();
      workspaceId = workspaces.find((workspace) => !workspace.archived)?.id ?? null;
      const existingMember = await orgStub.getMember(userId);
      if (!existingMember) {
        await orgStub.addMember(userId, candidate.role, "cloudflare-access");
      } else if (
        existingMember.role !== "owner" &&
        existingMember.role !== candidate.role
      ) {
        await orgStub.addMember(userId, candidate.role, "cloudflare-access");
      }
      const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
      if (!(await userStub.hasOrg(org.id))) {
        await userStub.addOrg(org.id, candidate.role, workspaceId);
      } else if (existingMember?.role !== "owner") {
        await userStub.updateOrgRole(org.id, candidate.role);
      }
    }

    if (workspaceId) {
      const workspaceStub = authEnv.WORKSPACE.get(
        authEnv.WORKSPACE.idFromName(workspaceId),
      );
      await workspaceStub.setMemberAccess(userId, "full", "cloudflare-access");
      await authEnv.USER.get(authEnv.USER.idFromName(userId))
        .setOrgLastWorkspace(org.id, workspaceId);
    }

    ensured.push({ org, workspaceId });
  }
  return ensured;
}

function identityContainsValue(root: unknown, expected: string): boolean {
  if (typeof root === "string") return root === expected;
  if (Array.isArray(root)) return root.some((item) => identityContainsValue(item, expected));
  if (root && typeof root === "object") {
    return Object.values(root).some((value) => identityContainsValue(value, expected));
  }
  return false;
}

function valuesAtPath(root: unknown, path: string): string[] {
  let current = root;
  for (const segment of path.split(".")) {
    if (!segment) continue;
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return [];
    }
    current = (current as JsonObject)[segment];
  }
  if (typeof current === "string") return [current.trim()].filter(Boolean);
  if (Array.isArray(current)) {
    return current
      .flatMap((item) => {
        if (typeof item === "string") return [item.trim()];
        if (item && typeof item === "object") {
          return [
            firstString(
              (item as JsonObject).id,
              (item as JsonObject).name,
              (item as JsonObject).displayName,
              (item as JsonObject).value,
            ),
          ];
        }
        return [];
      })
      .filter((item): item is string => Boolean(item))
      .filter(Boolean);
  }
  return [];
}

function accessGroupValues(root: unknown): string[] {
  return [
    ...valuesAtPath(root, "idp.groups"),
    ...valuesAtPath(root, "groups"),
    ...valuesAtPath(root, "idp.groupIds"),
    ...valuesAtPath(root, "groupIds"),
  ];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeEmail(value: unknown): string | null {
  const email = firstString(value)?.toLowerCase();
  return email && email.includes("@") ? email : null;
}

function nameFromEmail(email: string): string {
  return humanizeOrgName(email.split("@")[0] ?? email);
}

function humanizeOrgName(value: string): string {
  return value
    .replace(/^[^:]+:/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function orgKeyFromName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64urlDecode(value))) as T;
}

function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function extractCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = entry.trim().split("=");
    if (rawName === name) return rawValue.join("=");
  }
  return null;
}
