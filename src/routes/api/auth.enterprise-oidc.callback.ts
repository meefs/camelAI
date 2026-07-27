import { redirect } from "react-router";
import type { Route } from "./+types/auth.enterprise-oidc.callback";
import { getEnv } from "@/lib/cloudflare.server";
import { getAuthEnv } from "@/lib/auth.server";
import { createSessionCookieHeader } from "@/lib/cookies.server";
import {
  completeOrgSsoLogin,
  exchangeOidcCode,
  getOidcConfiguration,
  getOidcConnectionTestErrorMessage,
  validateOrgSsoIdentityClaims,
} from "@/lib/org-sso.server";
import {
  deleteSsoBrowserBindingCookie,
  getSsoBrowserBindingCookie,
  hashSsoBrowserBinding,
} from "@/lib/org-sso-browser.server";
import { normalizeSsoIssuer } from "../../../workers/main/src/org-sso";
import { parseSignedEnterpriseSsoState } from "../../../workers/main/src/signed-session";

function failure(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const stateValue = new URL(request.url).searchParams.get("state");
  if (!stateValue) throw failure("Enterprise sign-in state is missing", 400);
  const state = await parseSignedEnterpriseSsoState(
    env.TOKEN_SIGNING_SECRET,
    stateValue,
  );
  if (!state)
    throw failure("Enterprise sign-in state is invalid or expired", 400);

  const browserBinding = getSsoBrowserBindingCookie(
    request,
    state.transaction_id,
  );
  if (!browserBinding)
    throw failure("Enterprise sign-in browser binding is missing", 400);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(state.org_id));
  const transaction = await orgStub.consumeSsoTransaction(
    state.transaction_id,
    await hashSsoBrowserBinding(browserBinding),
  );
  if (!transaction)
    throw failure("Enterprise sign-in state is invalid or expired", 400);

  if (state.purpose === "test") {
    const actorUserId = transaction.link_user_id;
    const test = actorUserId
      ? await orgStub.getSsoConnectionTest(state.transaction_id, actorUserId)
      : null;
    if (
      !actorUserId ||
      !test ||
      test.status !== "pending" ||
      test.config.connection_id !== state.connection_id ||
      test.config.config_version !== state.config_version ||
      transaction.connection_id !== state.connection_id ||
      transaction.config_version !== state.config_version
    ) {
      throw failure("SSO connection test is invalid or expired", 400);
    }

    const callbackUrl = new URL(
      "/api/auth/enterprise-oidc/callback",
      env.WORKER_BASE_URL,
    ).toString();
    try {
      const oidcConfig = await getOidcConfiguration(
        test.config,
        env.INTEGRATION_SECRET_KEY,
      );
      const claims = await exchangeOidcCode({
        request,
        callbackUrl,
        expectedState: stateValue,
        pkceVerifier: transaction.pkce_verifier,
        expectedNonce: transaction.nonce,
        oidcConfig,
      });
      const identity = validateOrgSsoIdentityClaims(claims, test.config);
      const discoveredConfig =
        test.config.email_domains.length === 0 &&
        identity.hostedDomain &&
        normalizeSsoIssuer(test.config.issuer) === "https://accounts.google.com"
          ? {
              ...test.config,
              email_domains: [identity.hostedDomain],
            }
          : test.config;
      await orgStub.completeSsoConnectionTest(test.id, actorUserId, {
        config: discoveredConfig,
        status: "succeeded",
        checks: {
          ...test.checks,
          token_exchange_succeeded: true,
        },
        identity: {
          email: identity.email,
          domain: identity.domain,
          email_verified: identity.emailVerified,
          hosted_domain: identity.hostedDomain,
        },
        error: null,
        completed_at: Date.now(),
      });
    } catch (error) {
      const message =
        error instanceof Response
          ? await error.text()
          : getOidcConnectionTestErrorMessage(error);
      await orgStub.completeSsoConnectionTest(test.id, actorUserId, {
        status: "failed",
        checks: test.checks,
        identity: null,
        error: message,
        completed_at: Date.now(),
      });
      console.warn("[enterprise-oidc] connection test failed", {
        orgId: state.org_id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }

    const headers = new Headers({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    headers.append(
      "Set-Cookie",
      deleteSsoBrowserBindingCookie(state.transaction_id),
    );
    return redirect(
      `/settings/organization/sso?sso_test=${encodeURIComponent(state.transaction_id)}`,
      { headers },
    );
  }

  const [org, config] = await Promise.all([
    orgStub.getInfo(),
    orgStub.getSsoConfig(),
  ]);
  if (
    !org ||
    !config?.enabled ||
    config.connection_id !== state.connection_id ||
    config.config_version !== state.config_version ||
    transaction.connection_id !== state.connection_id ||
    transaction.config_version !== state.config_version
  ) {
    throw failure("Enterprise SSO configuration changed; start again", 409);
  }

  const callbackUrl = new URL(
    "/api/auth/enterprise-oidc/callback",
    env.WORKER_BASE_URL,
  ).toString();
  let result;
  try {
    result = await completeOrgSsoLogin({
      request,
      callbackUrl,
      expectedState: stateValue,
      transaction,
      authEnv,
      org,
      config,
      encryptionKey: env.INTEGRATION_SECRET_KEY,
    });
  } catch (error) {
    if (error instanceof Response) {
      throw failure(await error.text(), error.status);
    }
    console.error("[enterprise-oidc] callback failed", {
      orgId: state.org_id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw failure("Enterprise sign-in failed", 502);
  }

  const headers = new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  headers.append(
    "Set-Cookie",
    createSessionCookieHeader(
      result.signedToken,
      request,
      config.session_ttl_seconds,
    ),
  );
  headers.append(
    "Set-Cookie",
    deleteSsoBrowserBindingCookie(state.transaction_id),
  );
  return redirect(transaction.redirect_path, { headers });
}
