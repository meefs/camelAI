import { encryptCredentials } from "../../../../src/lib/integration-crypto.js";
import type { OrgDO } from "../auth.js";
import {
  createIntegrationOAuthState,
  readIntegrationOAuthState,
  validateAndConsumeIntegrationOAuthState,
} from "../integration-oauth-state.js";
import {
  DISCORD_CHANNEL_PERMISSION_DECIMAL,
  discordBridgeRequest,
  discordChannelCatalogAvailable,
  discordChannelEnabled,
  parseDiscordChannelConfig,
  type DiscordChannelConfigV1,
  type DiscordSelectableChannel,
} from "../discord-types.js";
import { requireSession } from "../helpers/auth.js";
import { getOrgStub } from "../helpers/stubs.js";
import { redirect, text } from "../helpers/response.js";
import type { RouteContext } from "../types.js";
import { recordErrorEvent, recordObservabilityEvent } from "../observability.js";
import {
  hasConnectionSetupPromptContext,
  verifyWorkspaceManageConnectionsAccess,
} from "./integrations.js";

interface DiscordOAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
  guild?: {
    id?: string;
    name?: string;
  };
}

function safeDiscordOAuthProviderError(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().slice(0, 64);
  return /^[a-z0-9_.-]+$/i.test(normalized) ? normalized : "";
}

export function discordOAuthTokenFailureStatus(
  responseStatus: number,
  responseOk: boolean,
  token: DiscordOAuthTokenResponse | null,
): string | null {
  if (!responseOk) {
    const providerError = safeDiscordOAuthProviderError(token?.error);
    return providerError ? `provider_${providerError}` : `provider_http_${responseStatus}`;
  }
  if (!token?.access_token) return "missing_access_token";
  // Discord can omit `bot` from the returned scope even for a successful
  // advanced bot authorization. The callback verifies the selected guild,
  // installed bot identity, and application id with the bridge below.
  if (!token.guild?.id?.trim()) return "missing_guild";
  return null;
}

function sanitizeRedirectPath(input: string): string {
  if (!input.startsWith("/") || input.startsWith("//")) return "/connections";
  try {
    const parsed = new URL(input, "https://camel.invalid");
    return parsed.pathname.startsWith("//") ? "/connections" : `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/connections";
  }
}

export function discordOAuthCallbackUrl(url: URL): string {
  return new URL("/api/integrations/discord/callback", url.origin).toString();
}

export function buildDiscordAuthorizationUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): URL {
  const authorizationUrl = new URL("https://discord.com/oauth2/authorize");
  authorizationUrl.searchParams.set("client_id", args.clientId);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("redirect_uri", args.redirectUri);
  authorizationUrl.searchParams.set("scope", "bot");
  authorizationUrl.searchParams.set("integration_type", "0");
  authorizationUrl.searchParams.set("permissions", DISCORD_CHANNEL_PERMISSION_DECIMAL);
  authorizationUrl.searchParams.set("state", args.state);
  authorizationUrl.searchParams.set("prompt", "consent");
  return authorizationUrl;
}

export function discordBridgeIdentityMatches(
  clientId: string,
  bridge: { applicationId: string; botUserId: string | null },
  observedBotUserId: string,
): boolean {
  return bridge.applicationId === clientId &&
    bridge.botUserId !== null &&
    bridge.botUserId === bridge.applicationId &&
    bridge.botUserId === observedBotUserId;
}

function callbackRedirect(url: URL, error: string, redirectTo = "/connections"): Response {
  const destination = new URL(sanitizeRedirectPath(redirectTo), url.origin);
  destination.searchParams.set("error", error);
  return redirect(destination.toString());
}

function oauthFailureRedirect(
  env: RouteContext["env"],
  url: URL,
  status: string,
  context: { orgId?: string; workspaceId?: string; redirectTo?: string } = {},
): Response {
  recordObservabilityEvent(env, {
    event: "discord.oauth.failed",
    severity: "warn",
    component: "discord_oauth",
    operation: "callback",
    status,
    orgId: context.orgId,
    workspaceId: context.workspaceId,
    sampleIndex: context.workspaceId || "discord_oauth",
  });
  return callbackRedirect(url, status, context.redirectTo);
}

async function recoverableProviderFailureRedirect(
  env: RouteContext["env"],
  url: URL,
  status: string,
  state: string | null,
): Promise<Response> {
  const stateData = state
    ? await readIntegrationOAuthState(env.SESSIONS, state).catch(() => null)
    : null;
  return oauthFailureRedirect(env, url, status, {
    workspaceId: stateData?.workspace_id,
    redirectTo: stateData?.integration_type === "discord_channel"
      ? stateData.redirect_url
      : undefined,
  });
}

function stateString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function handleDiscordOAuthStart({
  req,
  env,
  url,
}: RouteContext): Promise<Response> {
  if (
    !(await discordChannelCatalogAvailable(env)) ||
    !env.DISCORD_CLIENT_ID?.trim() ||
    !env.DISCORD_CLIENT_SECRET?.trim()
  ) {
    return text("Discord channel is not configured", 503);
  }
  const auth = await requireSession(req, env);
  if ("error" in auth) return redirect(`${url.origin}/login?error=unauthorized`);
  const { session } = auth;
  if (!session.workspace_id) return callbackRedirect(url, "no_workspace");
  const access = await verifyWorkspaceManageConnectionsAccess(
    env,
    session.workspace_id,
    session.user_id,
  );
  if (!access.ok) return callbackRedirect(url, access.error);

  const redirectTo = sanitizeRedirectPath(
    url.searchParams.get("redirect") || "/connections",
  );
  const integrationId = url.searchParams.get("integration_id")?.trim();
  const securityAcknowledged = url.searchParams.get("security_acknowledged") === "true";
  const chatRequestId = url.searchParams.get("chat_request_id")?.trim();
  const chatThreadId = url.searchParams.get("chat_thread_id")?.trim();
  if ((chatRequestId || chatThreadId) && (!chatRequestId || !chatThreadId)) {
    return callbackRedirect(url, "chat_context_invalid");
  }
  if (chatRequestId && !securityAcknowledged) {
    return callbackRedirect(url, "security_acknowledgement_required");
  }
  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    "discord_channel",
    session.workspace_id,
    session.user_id,
    redirectTo,
    {
      org_id: access.orgId,
      ...(integrationId ? { reauth_integration_id: integrationId } : {}),
      ...(securityAcknowledged ? { security_acknowledged_at: Date.now() } : {}),
      ...(chatRequestId && chatThreadId
        ? { chat_request_id: chatRequestId, chat_thread_id: chatThreadId }
        : {}),
    },
  );
  const authorizationUrl = buildDiscordAuthorizationUrl({
    clientId: env.DISCORD_CLIENT_ID,
    redirectUri: discordOAuthCallbackUrl(url),
    state,
  });
  return redirect(authorizationUrl.toString());
}

export async function handleDiscordOAuthCallback({
  req,
  env,
  url,
}: RouteContext): Promise<Response> {
  const state = url.searchParams.get("state")?.trim() || null;
  if (url.searchParams.get("error")) {
    return recoverableProviderFailureRedirect(env, url, "oauth_denied", state);
  }
  const code = url.searchParams.get("code")?.trim();
  if (!code || !state) {
    return recoverableProviderFailureRedirect(env, url, "oauth_invalid", state);
  }
  const stateData = await validateAndConsumeIntegrationOAuthState(env.SESSIONS, state);
  if (!stateData || stateData.integration_type !== "discord_channel") {
    return oauthFailureRedirect(env, url, "oauth_state_invalid");
  }
  if (
    !discordChannelEnabled(env) ||
    !env.DISCORD_CLIENT_ID?.trim() ||
    !env.DISCORD_CLIENT_SECRET?.trim()
  ) {
    return oauthFailureRedirect(env, url, "oauth_config", {
      workspaceId: stateData.workspace_id,
      redirectTo: stateData.redirect_url,
    });
  }
  const auth = await requireSession(req, env);
  if (
    "error" in auth ||
    auth.session.user_id !== stateData.user_id
  ) {
    return oauthFailureRedirect(env, url, "access_denied", {
      workspaceId: stateData.workspace_id,
      redirectTo: stateData.redirect_url,
    });
  }
  const access = await verifyWorkspaceManageConnectionsAccess(
    env,
    stateData.workspace_id,
    stateData.user_id,
  );
  if (!access.ok) return oauthFailureRedirect(env, url, access.error, {
    workspaceId: stateData.workspace_id,
    redirectTo: stateData.redirect_url,
  });
  if (stateString(stateData.extra_config?.org_id) !== access.orgId) {
    return oauthFailureRedirect(env, url, "oauth_state_invalid", {
      orgId: access.orgId,
      workspaceId: stateData.workspace_id,
      redirectTo: stateData.redirect_url,
    });
  }

  try {
    const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: discordOAuthCallbackUrl(url),
      }),
    });
    const token = await tokenResponse.json().catch(() => null) as DiscordOAuthTokenResponse | null;
    const tokenFailureStatus = discordOAuthTokenFailureStatus(
      tokenResponse.status,
      tokenResponse.ok,
      token,
    );
    const guildId = token?.guild?.id?.trim();
    if (tokenFailureStatus || !guildId) {
      recordObservabilityEvent(env, {
        event: "discord.oauth.token_exchange_failed",
        severity: "warn",
        component: "discord_oauth",
        operation: "token_exchange",
        status: tokenFailureStatus || "missing_guild",
        statusCode: tokenResponse.status,
        provider: "discord",
        orgId: access.orgId,
        workspaceId: stateData.workspace_id,
        sampleIndex: stateData.workspace_id,
      });
      console.warn("[discord-oauth] token exchange failed", {
        status: tokenFailureStatus || "missing_guild",
        statusCode: tokenResponse.status,
        providerError: safeDiscordOAuthProviderError(token?.error) || undefined,
        responseParsed: token !== null,
        hasAccessToken: Boolean(token?.access_token),
        hasGuildId: Boolean(guildId),
      });
      return oauthFailureRedirect(env, url, "oauth_token_failed", {
        orgId: access.orgId,
        workspaceId: stateData.workspace_id,
        redirectTo: stateData.redirect_url,
      });
    }

    // The OAuth access/refresh tokens are deliberately not retained. The bridge
    // confirms the shared bot is present using its own bot credential.
    const [bridgeStatus, observed] = await Promise.all([
      discordBridgeRequest<{
        ok: true;
        applicationId: string;
        botUserId: string | null;
        gateway: { state: string };
      }>(env.DISCORD_BRIDGE, "/internal/v1/status"),
      discordBridgeRequest<{
        ok: true;
        guild: { id: string; name: string };
        botUserId: string;
        contentMode: "full" | "mention_only";
        channels: DiscordSelectableChannel[];
      }>(env.DISCORD_BRIDGE, `/internal/v1/guilds/${encodeURIComponent(guildId)}/channels`),
    ]);
    if (!discordBridgeIdentityMatches(env.DISCORD_CLIENT_ID, bridgeStatus, observed.botUserId)) {
      return oauthFailureRedirect(env, url, "discord_application_mismatch", {
        orgId: access.orgId,
        workspaceId: stateData.workspace_id,
        redirectTo: stateData.redirect_url,
      });
    }
    const guildName = observed.guild.name || token.guild?.name?.trim() || "Discord server";
    const orgStub = getOrgStub(env, access.orgId) as unknown as OrgDO;
    const requestedId = stateString(stateData.extra_config?.reauth_integration_id);
    const existing = requestedId
      ? await orgStub.getWorkspaceIntegration(stateData.workspace_id, requestedId)
      : null;
    if (requestedId && existing?.integration_type !== "discord_channel") {
      return oauthFailureRedirect(env, url, "reauth_integration_not_found", {
        orgId: access.orgId,
        workspaceId: stateData.workspace_id,
        redirectTo: stateData.redirect_url,
      });
    }
    const integrationId = requestedId || crypto.randomUUID();
    const previousConfig = existing
      ? parseDiscordChannelConfig(existing.config || "{}")
      : null;
    const stateAcknowledgedAt = Number(
      stateData.extra_config?.security_acknowledged_at,
    );
    const securityAcknowledgedAt =
      Number.isFinite(stateAcknowledgedAt) && stateAcknowledgedAt > 0
        ? stateAcknowledgedAt
        : typeof previousConfig?.security_acknowledged_at === "number"
          ? previousConfig.security_acknowledged_at
          : undefined;
    const pendingSetup = hasConnectionSetupPromptContext(stateData)
      ? {
          request_id: stateString(stateData.extra_config?.chat_request_id)!,
          thread_id: stateString(stateData.extra_config?.chat_thread_id)!,
          return_path: sanitizeRedirectPath(stateData.redirect_url),
          created_at: Date.now(),
        }
      : undefined;
    const activationAttemptId = crypto.randomUUID();
    const pendingReauthorization = {
      activation_attempt_id: activationAttemptId,
      application_id: env.DISCORD_CLIENT_ID,
      guild_id: guildId,
      guild_name: guildName,
      bot_user_id: observed.botUserId,
      message_content_mode: observed.contentMode,
    };
    // Ingress validates the top-level active binding. Stage OAuth's replacement
    // beside it so abandoning channel selection cannot make live messages fail
    // closed while the bridge still owns the old channel.
    const config: DiscordChannelConfigV1 = previousConfig?.status === "active"
      ? {
          ...previousConfig,
          pending_reauthorization: pendingReauthorization,
          activation_attempt_id: undefined,
          ...(securityAcknowledgedAt
            ? { security_acknowledged_at: securityAcknowledgedAt }
            : {}),
          ...(pendingSetup ? { pending_setup: pendingSetup } : {}),
        }
      : {
          schema_version: 1,
          status: "pending_channel",
          application_id: env.DISCORD_CLIENT_ID,
          guild_id: guildId,
          guild_name: guildName,
          bot_user_id: observed.botUserId,
          message_content_mode: observed.contentMode,
          activation_attempt_id: activationAttemptId,
          ...(securityAcknowledgedAt
            ? { security_acknowledged_at: securityAcknowledgedAt }
            : {}),
          ...(pendingSetup ? { pending_setup: pendingSetup } : {}),
        };
    const encryptedEmptyCredentials = await encryptCredentials(
      {},
      env.INTEGRATION_SECRET_KEY,
    );
    if (existing) {
      await orgStub.updateWorkspaceIntegration(
        stateData.workspace_id,
        integrationId,
        {
          name: previousConfig?.status === "active" ? existing.name : guildName,
          config: JSON.stringify(config),
          credentialsEncrypted: encryptedEmptyCredentials,
        },
        stateData.user_id,
      );
    } else {
      await orgStub.createWorkspaceIntegration(
        stateData.workspace_id,
        integrationId,
        "discord_channel",
        guildName,
        "communication",
        "oauth2",
        JSON.stringify(config),
        encryptedEmptyCredentials,
        stateData.user_id,
      );
    }

    const pendingChatSetup = hasConnectionSetupPromptContext(stateData);
    const destination = new URL(
      pendingChatSetup ? "/connections" : sanitizeRedirectPath(stateData.redirect_url),
      url.origin,
    );
    destination.searchParams.set("success", "discord_installed");
    destination.searchParams.set("selected", integrationId);
    if (pendingChatSetup) {
      destination.searchParams.set(
        "return_to",
        sanitizeRedirectPath(stateData.redirect_url),
      );
    }
    recordObservabilityEvent(env, {
      event: "discord.oauth.completed",
      component: "discord_oauth",
      operation: existing ? "reauthorize" : "install",
      status: "pending_channel",
      orgId: access.orgId,
      workspaceId: stateData.workspace_id,
      sampleIndex: integrationId,
    });
    return redirect(destination.toString());
  } catch (error) {
    recordErrorEvent(env, {
      event: "discord.oauth.failed",
      component: "discord_oauth",
      operation: "callback",
      status: "oauth_failed",
      orgId: access.orgId,
      workspaceId: stateData.workspace_id,
      sampleIndex: stateData.workspace_id,
      error,
    });
    console.error("[discord-oauth] callback failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return callbackRedirect(url, "oauth_failed", stateData.redirect_url);
  }
}
