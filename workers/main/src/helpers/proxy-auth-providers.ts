/**
 * Registry of enabled reverse-proxy identity providers and the generic,
 * provider-dispatching validators used by the Worker- and app-side auth paths.
 *
 * Separated from the individual adapter modules to avoid an import cycle: the
 * adapters import the core engine; this module imports the adapters.
 */

import {
  validateProxyBackedSignedSession,
  validateProxyIdentityMapsToOrg,
  type ProxyAuthProvider,
  type ProxyAuthValidationEnv,
  type ProxySessionValidation,
} from "./proxy-auth-core.js";
import { CLOUDFLARE_ACCESS_PROVIDER } from "./access-session.js";
import { POMERIUM_PROVIDER } from "./pomerium-session.js";

/**
 * All supported providers, in precedence order. Order only matters when more
 * than one is configured at once (an unusual deployment); silent login tries
 * them in this order. Cloudflare Access first, then Pomerium.
 */
export const PROXY_AUTH_PROVIDERS: readonly ProxyAuthProvider[] = [
  CLOUDFLARE_ACCESS_PROVIDER,
  POMERIUM_PROVIDER,
];

/** True when `authSource` belongs to a reverse-proxy identity provider. */
export function isProxyAuthSource(
  authSource: string | null | undefined,
): boolean {
  return PROXY_AUTH_PROVIDERS.some(
    (provider) => provider.authSource === authSource,
  );
}

/** Find the provider that minted a session with the given auth source. */
export function providerForAuthSource(
  authSource: string | null | undefined,
): ProxyAuthProvider | null {
  return (
    PROXY_AUTH_PROVIDERS.find(
      (provider) => provider.authSource === authSource,
    ) ?? null
  );
}

/**
 * Validate a proxy-backed signed session against the live assertion on the
 * request, dispatching on `auth_source`. Sessions from password/OAuth are
 * always "valid". Read-only.
 */
export function validateSessionMapsToOrg(
  request: Request,
  env: ProxyAuthValidationEnv,
  session: {
    auth_source?: string | null;
    user_email?: string | null;
    org_id?: string | null;
  },
): Promise<ProxySessionValidation> {
  return validateProxyBackedSignedSession(
    request,
    env,
    session,
    PROXY_AUTH_PROVIDERS,
  );
}

/**
 * Like {@link validateSessionMapsToOrg} but checks the session's identity
 * against an explicit target `orgId` (e.g. an org the user is switching into),
 * dispatching on the session's auth source. Non-proxy sessions are "valid".
 */
export function validateSessionIdentityMapsToOrg(
  request: Request,
  env: ProxyAuthValidationEnv,
  session: { auth_source?: string | null; user_email?: string | null },
  orgId: string | null | undefined,
): Promise<ProxySessionValidation> {
  const provider = providerForAuthSource(session.auth_source);
  if (!provider) return Promise.resolve("valid");
  return validateProxyIdentityMapsToOrg(
    request,
    env,
    provider,
    session.user_email,
    orgId,
  );
}
