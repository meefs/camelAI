import * as oidc from "openid-client";
import { redirect } from "react-router";
import type { Route } from "./+types/sso.$slug";
import { getEnv } from "@/lib/cloudflare.server";
import { getAuthEnv, requireAuthContext } from "@/lib/auth.server";
import { getOidcConfiguration } from "@/lib/org-sso.server";
import {
  createSsoBrowserBinding,
  createSsoBrowserBindingCookie,
  deleteSsoLinkCookie,
  getSsoLinkCookie,
  hashSsoBrowserBinding,
} from "@/lib/org-sso-browser.server";
import { getSafeSsoRedirect } from "../../workers/main/src/org-sso";
import { ORG_SLUG_KV_PREFIX } from "../../workers/main/src/identity/org-slugs";
import {
  createSignedEnterpriseSsoState,
  parseSignedEnterpriseSsoLink,
} from "../../workers/main/src/signed-session";

const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const slug = params.slug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Response("SSO organization not found", { status: 404 });
  }

  const orgId = await env.APP_KV.get(`${ORG_SLUG_KV_PREFIX}${slug}`);
  if (!orgId) throw new Response("SSO organization not found", { status: 404 });
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const [org, config] = await Promise.all([orgStub.getInfo(), orgStub.getSsoConfig()]);
  if (
    !org ||
    org.slug !== slug ||
    org.billing_status !== "enterprise" ||
    !config?.enabled
  ) {
    throw new Response("SSO is not configured for this organization", { status: 404 });
  }

  const linkRequested = new URL(request.url).searchParams.get("link") === "1";
  let linkUserId: string | null = null;
  if (linkRequested) {
    const auth = await requireAuthContext(request, context);
    const linkCookie = getSsoLinkCookie(request, org.id);
    const linkIntent = linkCookie
      ? await parseSignedEnterpriseSsoLink(env.TOKEN_SIGNING_SECRET, linkCookie)
      : null;
    if (
      !linkIntent ||
      linkIntent.org_id !== org.id ||
      linkIntent.user_id !== auth.user.id ||
      auth.currentOrg.id !== org.id ||
      !(await orgStub.getMember(auth.user.id))
    ) {
      throw new Response("Start SSO linking from your authenticated account settings", { status: 403 });
    }
    linkUserId = auth.user.id;
  }

  const clientRateKey = await hashSsoBrowserBinding(
    request.headers.get("CF-Connecting-IP") ?? "unknown-client",
  );
  if (!(await orgStub.allowSsoLoginAttempt(clientRateKey))) {
    throw new Response("Too many SSO sign-in attempts; try again shortly", { status: 429 });
  }
  const oidcConfig = await getOidcConfiguration(config, env.INTEGRATION_SECRET_KEY);
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const nonce = oidc.randomNonce();
  const transactionId = crypto.randomUUID();
  const browserBinding = createSsoBrowserBinding();
  const now = Date.now();
  const redirectPath = getSafeSsoRedirect(new URL(request.url).searchParams.get("redirect"));
  await orgStub.createSsoTransaction({
    id: transactionId,
    connection_id: config.connection_id,
    config_version: config.config_version,
    pkce_verifier: verifier,
    nonce,
    browser_binding_hash: await hashSsoBrowserBinding(browserBinding),
    link_user_id: linkUserId,
    redirect_path: redirectPath,
    created_at: now,
    expires_at: now + TRANSACTION_TTL_MS,
  });
  const state = await createSignedEnterpriseSsoState(env.TOKEN_SIGNING_SECRET, {
    org_id: org.id,
    transaction_id: transactionId,
    connection_id: config.connection_id,
    config_version: config.config_version,
    created_at: now,
  });
  const callbackUrl = new URL("/api/auth/enterprise-oidc/callback", env.WORKER_BASE_URL).toString();
  const authorizationUrl = oidc.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: callbackUrl,
    scope: "openid email profile",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce,
    state,
  });
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  headers.append(
    "Set-Cookie",
    createSsoBrowserBindingCookie(
      transactionId,
      browserBinding,
      TRANSACTION_TTL_MS / 1000,
    ),
  );
  if (linkRequested) headers.append("Set-Cookie", deleteSsoLinkCookie(org.id));
  return redirect(authorizationUrl.toString(), { headers });
}
