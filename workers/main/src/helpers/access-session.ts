/**
 * Shared Cloudflare Access primitives.
 *
 * Both the app-side silent login (src/lib/cloudflare-access-auth.server.ts)
 * and Worker-side session revalidation import from here. Keep all JWT
 * verification, identity fetching, and org-candidate resolution in this module
 * so the two enforcement paths cannot drift apart.
 */

import type { OrgDO } from "../auth.js";
import { parseCookie } from "../cookies.js";
import {
  base64urlDecode,
  CLOUDFLARE_ACCESS_AUTH_SOURCE,
} from "../signed-session.js";

export { CLOUDFLARE_ACCESS_AUTH_SOURCE } from "../signed-session.js";

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const ACCESS_COOKIE_NAME = "CF_Authorization";
// Access signing keys rotate on the order of weeks and old keys remain in the
// JWKS during rollover; a short cache TTL plus the kid-miss bypass below keeps
// rotation safe while removing the per-request certs fetch.
const JWKS_CACHE_TTL_SECONDS = 3600;
export const ORG_KV_PREFIX = "cloudflare_access:org:";
export const ORG_LOCK_PREFIX = "cloudflare_access:org_lock:";

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

export interface AccessValidationEnv extends CloudflareAccessEnv {
  ORG: DurableObjectNamespace<OrgDO>;
}

export interface AccessConfig {
  teamDomain: string;
  audiences: string[];
  orgClaimPaths: string[];
  orgMap: Record<string, string>;
  orgGroupPrefix: string | null;
  adminGroupPrefix: string | null;
  defaultOrgName: string | null;
  requiredEmailDomain: string | null;
}

export interface AccessJwtPayload extends JsonObject {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  name?: string;
  nbf?: number;
  sub?: string;
}

export interface AccessIdentity {
  email?: unknown;
  name?: unknown;
  user_uuid?: unknown;
  account_id?: unknown;
  idp?: unknown;
  [key: string]: unknown;
}

export interface AccessOrgCandidate {
  key: string;
  name: string;
  role: "member" | "admin";
  initializesOrg?: boolean;
}

/**
 * Thrown when Cloudflare Access infrastructure (JWKS or identity endpoints)
 * cannot be reached or fails upstream. Callers must surface this as a
 * retryable condition (503) rather than treating the identity as invalid or
 * de-provisioned.
 */
export class CloudflareAccessUnavailableError extends Error {}

export type AccessSessionValidation = "valid" | "invalid" | "unavailable";

const DEFAULT_CLAIM_PATHS = ["idp.name", "idp.id", "officeLocation"];

export function getAccessConfig(env: CloudflareAccessEnv): AccessConfig | null {
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
    requiredEmailDomain:
      normalizedOptional(env.CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN)?.toLowerCase() ??
      null,
  };
}

export function emailMatchesRequiredDomain(
  email: string,
  config: AccessConfig,
): boolean {
  if (!config.requiredEmailDomain) return true;
  return email.endsWith(`@${config.requiredEmailDomain}`);
}

/**
 * Validate an Access-backed signed session cookie against the live Access
 * identity on the request. Sessions from other auth sources are always
 * "valid". Read-only: never creates or mutates users, orgs, or memberships.
 */
export async function validateAccessBackedSignedSession(
  request: Request,
  env: AccessValidationEnv,
  session: {
    auth_source?: string | null;
    user_email?: string | null;
    org_id?: string | null;
  },
): Promise<AccessSessionValidation> {
  if (session.auth_source !== CLOUDFLARE_ACCESS_AUTH_SOURCE) return "valid";
  return validateAccessIdentityMapsToOrg(
    request,
    env,
    session.user_email,
    session.org_id,
  );
}

/**
 * Check that the request carries a valid Access assertion for `expectedEmail`
 * whose current org candidates map to `orgId`. Read-only.
 */
export async function validateAccessIdentityMapsToOrg(
  request: Request,
  env: AccessValidationEnv,
  expectedEmail: string | null | undefined,
  orgId: string | null | undefined,
): Promise<AccessSessionValidation> {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) return "invalid";

  const config = getAccessConfig(env);
  if (!config || !orgId) return "invalid";

  let payload: AccessJwtPayload;
  try {
    payload = await verifyAccessJwt(token, config);
  } catch (error) {
    return error instanceof CloudflareAccessUnavailableError
      ? "unavailable"
      : "invalid";
  }

  const accessEmail = normalizeEmail(payload.email);
  const sessionEmail = normalizeEmail(expectedEmail);
  if (!accessEmail || !sessionEmail || accessEmail !== sessionEmail) {
    return "invalid";
  }
  if (!emailMatchesRequiredDomain(accessEmail, config)) return "invalid";

  // Fast path: candidates derived from the JWT alone (operator-configured
  // jwt.* claim paths) can prove the mapping without the identity round-trip.
  // The default-org fallback is excluded here — whether it applies depends on
  // the full identity yielding no candidates.
  const jwtCandidates = resolveOrgCandidates(config, payload, null, {
    includeDefaultFallback: false,
  });
  if (
    jwtCandidates.length > 0 &&
    (await kvMappingMatches(env, config, jwtCandidates, orgId))
  ) {
    return "valid";
  }

  let identity: AccessIdentity | null = null;
  let identityUnavailable = false;
  try {
    identity = await fetchAccessIdentity(request, token, config);
  } catch (error) {
    if (!(error instanceof CloudflareAccessUnavailableError)) throw error;
    // Candidates from the JWT alone may still prove the mapping; only report
    // "unavailable" if they cannot.
    identityUnavailable = true;
  }

  // When identity is unavailable, the default-org fallback must stay
  // excluded: it is the one candidate that needs no identity, so allowing it
  // here would let a stale default-org cookie validate as "valid" during an
  // outage even though the (unseen) identity might now map elsewhere or prove
  // de-provisioning. Report "unavailable" so the caller retries instead.
  const candidates = resolveOrgCandidates(config, payload, identity, {
    includeDefaultFallback: !identityUnavailable,
  });
  if (await kvMappingMatches(env, config, candidates, orgId)) return "valid";
  // APP_KV is eventually consistent across isolates: a mapping written during
  // a just-completed first login may not be visible here yet. The lock DO that
  // created the org holds the authoritative record.
  if (await lockMappingMatches(env, config, candidates, orgId)) return "valid";
  return identityUnavailable ? "unavailable" : "invalid";
}

function candidateKvKeys(
  config: AccessConfig,
  candidates: AccessOrgCandidate[],
): string[] {
  return candidates.map(
    (candidate) => `${ORG_KV_PREFIX}${config.teamDomain}:${candidate.key}`,
  );
}

async function kvMappingMatches(
  env: AccessValidationEnv,
  config: AccessConfig,
  candidates: AccessOrgCandidate[],
  orgId: string,
): Promise<boolean> {
  const mappedOrgIds = await Promise.all(
    candidateKvKeys(config, candidates).map((kvKey) => env.APP_KV.get(kvKey)),
  );
  return mappedOrgIds.includes(orgId);
}

async function lockMappingMatches(
  env: AccessValidationEnv,
  config: AccessConfig,
  candidates: AccessOrgCandidate[],
  orgId: string,
): Promise<boolean> {
  const mappedOrgIds = await Promise.all(
    candidateKvKeys(config, candidates).map((kvKey) =>
      env.ORG.get(env.ORG.idFromName(`${ORG_LOCK_PREFIX}${kvKey}`))
        .getAccessMappedOrgId(),
    ),
  );
  return mappedOrgIds.includes(orgId);
}

/**
 * Verify the Access JWT signature and claims. Throws
 * CloudflareAccessUnavailableError when the JWKS endpoint cannot be reached,
 * and a plain Error for any invalid token.
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
): Promise<AccessJwtPayload> {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("Invalid Cloudflare Access JWT");
  }

  const header = decodeJwtPart<JsonObject>(encodedHeader);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("Unsupported Cloudflare Access JWT");
  }

  const certsUrl = `${config.teamDomain}/cdn-cgi/access/certs`;
  let jwks = await loadJwks(certsUrl, { bypassCache: false });
  let jwk = jwks.keys?.find((key) => key.kid === header.kid);
  if (!jwk) {
    // Key rotation: the cached JWKS may predate this kid; refetch from origin.
    jwks = await loadJwks(certsUrl, { bypassCache: true });
    jwk = jwks.keys?.find((key) => key.kid === header.kid);
  }
  if (!jwk) throw new Error("Cloudflare Access signing key was not found");

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
  if (!valid) throw new Error("Cloudflare Access JWT signature is invalid");

  const payload = decodeJwtPart<AccessJwtPayload>(encodedPayload);
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== config.teamDomain) {
    throw new Error("Cloudflare Access issuer is invalid");
  }
  if (typeof payload.exp === "number" && payload.exp <= now) {
    throw new Error("Cloudflare Access JWT is expired");
  }
  if (typeof payload.nbf === "number" && payload.nbf > now) {
    throw new Error("Cloudflare Access JWT is not active yet");
  }
  const tokenAudiences = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === "string"
      ? [payload.aud]
      : [];
  if (!tokenAudiences.some((audience) => config.audiences.includes(audience))) {
    throw new Error("Cloudflare Access audience is invalid");
  }
  return payload;
}

/** Edge cache for the team-domain JWKS; null outside the Workers runtime. */
function defaultCache(): Cache | null {
  const cacheStorage = (globalThis as { caches?: { default?: Cache } }).caches;
  return cacheStorage?.default ?? null;
}

async function loadJwks(
  certsUrl: string,
  options: { bypassCache: boolean },
): Promise<{ keys?: JsonObject[] }> {
  const cache = defaultCache();
  if (cache && !options.bypassCache) {
    const cached = await cache.match(certsUrl);
    if (cached) return (await cached.json()) as { keys?: JsonObject[] };
  }
  let response: Response;
  try {
    response = await fetch(certsUrl);
  } catch (error) {
    throw new CloudflareAccessUnavailableError(
      `Unable to load Cloudflare Access signing keys: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new CloudflareAccessUnavailableError(
      "Unable to load Cloudflare Access signing keys",
    );
  }
  const body = await response.text();
  if (cache) {
    await cache.put(
      certsUrl,
      new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${JWKS_CACHE_TTL_SECONDS}`,
        },
      }),
    );
  }
  return JSON.parse(body) as { keys?: JsonObject[] };
}

// Request-scoped memo: getSession and a route guard (requireAccessMappedOrg)
// both validate the same request, and keying by the Request object cannot
// leak state across requests.
const identityRequestCache = new WeakMap<
  Request,
  Promise<AccessIdentity | null>
>();

/**
 * Fetch the full Access identity from the team domain. Returns null when the
 * endpoint deterministically has no identity for the request (4xx); throws
 * CloudflareAccessUnavailableError on network failures and 5xx so callers can
 * distinguish a transient outage from de-provisioning.
 */
export function fetchAccessIdentity(
  request: Request,
  token: string,
  config: AccessConfig,
): Promise<AccessIdentity | null> {
  const cached = identityRequestCache.get(request);
  if (cached) return cached;
  const result = fetchAccessIdentityFromOrigin(request, token, config);
  identityRequestCache.set(request, result);
  return result;
}

async function fetchAccessIdentityFromOrigin(
  request: Request,
  token: string,
  config: AccessConfig,
): Promise<AccessIdentity | null> {
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    [ACCESS_JWT_HEADER]: token,
  });
  // get-identity is cookie-based. CF_Authorization carries the same Access
  // application JWT as the assertion header, so when Cloudflare did not
  // forward the cookie to the origin, fall back to the assertion token —
  // otherwise group/claim-based mapping breaks on those deployments.
  const accessCookie =
    parseCookie(request.headers.get("Cookie"), ACCESS_COOKIE_NAME) ?? token;
  headers.set("Cookie", `${ACCESS_COOKIE_NAME}=${accessCookie}`);
  const identityUrl = new URL("/cdn-cgi/access/get-identity", config.teamDomain);
  let response: Response;
  try {
    response = await fetch(identityUrl.toString(), { headers });
  } catch (error) {
    throw new CloudflareAccessUnavailableError(
      `Unable to fetch Cloudflare Access identity: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (response.status >= 500) {
    throw new CloudflareAccessUnavailableError(
      `Cloudflare Access identity endpoint returned ${response.status}`,
    );
  }
  if (!response.ok) return null;
  return (await response.json()) as AccessIdentity;
}

export function resolveOrgCandidates(
  config: AccessConfig,
  payload: AccessJwtPayload,
  identity: AccessIdentity | null,
  options: { includeDefaultFallback?: boolean } = {},
): AccessOrgCandidate[] {
  const root = { jwt: payload, ...(identity ?? {}) };
  const candidates: AccessOrgCandidate[] = [];

  const claimPaths =
    config.orgClaimPaths.length > 0 ? config.orgClaimPaths : DEFAULT_CLAIM_PATHS;
  const valuesByPath = claimPaths.map(
    (path) => [path, valuesAtPath(root, path)] as const,
  );
  const claimValues = new Set(valuesByPath.flatMap(([, values]) => values));

  // Explicit org-map entries match only operator-designated claim locations,
  // never arbitrary identity fields: any IdP attribute that happened to equal
  // a map key would otherwise grant membership in the mapped org. Claim
  // values can be user-editable in common IdPs (e.g. officeLocation), so
  // these candidates never initialize orgs — creation requires an admin
  // group or the default-org fallback.
  for (const [key, name] of Object.entries(config.orgMap)) {
    if (claimValues.has(key)) {
      candidates.push({ key: `map:${key}`, name, role: "member" });
    }
  }

  for (const [path, values] of valuesByPath) {
    for (const value of values) {
      if (config.orgMap[value] !== undefined) continue;
      candidates.push({
        key: `${path}:${value}`,
        name: humanizeOrgName(value),
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

  if (
    candidates.length === 0 &&
    config.defaultOrgName &&
    (options.includeDefaultFallback ?? true)
  ) {
    candidates.push({
      key: `default:${config.defaultOrgName}`,
      name: config.defaultOrgName,
      role: "member",
      initializesOrg: true,
    });
  }

  const deduped = new Map<string, AccessOrgCandidate>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.key);
    if (!existing || (existing.role === "member" && candidate.role === "admin")) {
      deduped.set(candidate.key, candidate);
    }
  }
  return [...deduped.values()];
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
      .filter((item): item is string => Boolean(item));
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

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function normalizeEmail(value: unknown): string | null {
  const email = firstString(value)?.toLowerCase();
  return email && email.includes("@") ? email : null;
}

export function humanizeOrgName(value: string): string {
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
