/**
 * OpenAI's managed Codex device-code flow. Subscription tokens are only used
 * with the ChatGPT Codex backend; they are never sent to the Platform API.
 */
export const OPENAI_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_AUTH_ORIGIN = "https://auth.openai.com";
export const OPENAI_CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const OPENAI_CODEX_DEVICE_VERIFICATION_URL = `${OPENAI_CODEX_AUTH_ORIGIN}/codex/device`;

const DEFAULT_DEVICE_CODE_LIFETIME_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

export interface OpenAiSubscriptionCredentials {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id: string;
  expires_at: number;
}

export interface OpenAiSubscriptionIdentity {
  accountId: string | null;
  email: string | null;
  planType: string | null;
}

interface OpenAiTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  if (typeof record.error_description === "string") return record.error_description;
  if (typeof record.error === "string") return record.error;
  return fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> {
  if (!token) return {};
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(padded)) as unknown;
    return decoded && typeof decoded === "object" ? decoded as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function getOpenAiSubscriptionIdentity(
  accessToken: string | null | undefined,
  idToken?: string | null,
): OpenAiSubscriptionIdentity {
  const accessClaims = decodeJwtPayload(accessToken);
  const idClaims = decodeJwtPayload(idToken);
  const authValue = accessClaims["https://api.openai.com/auth"];
  const authClaims = authValue && typeof authValue === "object"
    ? authValue as Record<string, unknown>
    : {};
  const firstString = (values: unknown[]) =>
    values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
  return {
    accountId: firstString([
      authClaims.chatgpt_account_id,
      accessClaims.chatgpt_account_id,
      idClaims.chatgpt_account_id,
    ]),
    email: firstString([idClaims.email, accessClaims.email]),
    planType: firstString([
      authClaims.chatgpt_plan_type,
      accessClaims.chatgpt_plan_type,
      idClaims.chatgpt_plan_type,
    ]),
  };
}

export async function startOpenAiDeviceAuthorization(): Promise<{
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: number;
}> {
  const response = await fetch(`${OPENAI_CODEX_AUTH_ORIGIN}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: OPENAI_CODEX_OAUTH_CLIENT_ID }),
  });
  const payload = await readJson(response);
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error(errorMessage(payload, `OpenAI device sign-in returned ${response.status}.`));
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.device_auth_id !== "string" || typeof record.user_code !== "string") {
    throw new Error("OpenAI device sign-in returned an incomplete response.");
  }
  const intervalSeconds = typeof record.interval === "number" && Number.isFinite(record.interval)
    ? Math.max(1, Math.floor(record.interval))
    : DEFAULT_POLL_INTERVAL_SECONDS;
  const expiresInSeconds = typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
    ? Math.max(60, Math.floor(record.expires_in))
    : DEFAULT_DEVICE_CODE_LIFETIME_SECONDS;
  return {
    deviceAuthId: record.device_auth_id,
    userCode: record.user_code,
    verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
    intervalSeconds,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
}

export async function pollOpenAiDeviceAuthorization(
  deviceAuthId: string,
  userCode: string,
): Promise<
  | { status: "pending" }
  | { status: "complete"; credentials: OpenAiSubscriptionCredentials; identity: OpenAiSubscriptionIdentity }
> {
  const response = await fetch(`${OPENAI_CODEX_AUTH_ORIGIN}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  });
  if (response.status === 403 || response.status === 404) return { status: "pending" };
  const payload = await readJson(response);
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error(errorMessage(payload, `OpenAI device sign-in returned ${response.status}.`));
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.authorization_code !== "string" || typeof record.code_verifier !== "string") {
    throw new Error("OpenAI device sign-in returned an incomplete authorization.");
  }
  const result = await exchangeOpenAiAuthorizationCode(record.authorization_code, record.code_verifier);
  return { status: "complete", ...result };
}

async function exchangeOpenAiAuthorizationCode(
  authorizationCode: string,
  codeVerifier: string,
): Promise<{ credentials: OpenAiSubscriptionCredentials; identity: OpenAiSubscriptionIdentity }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: `${OPENAI_CODEX_AUTH_ORIGIN}/deviceauth/callback`,
    client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const response = await fetch(`${OPENAI_CODEX_AUTH_ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(errorMessage(payload, `OpenAI token exchange returned ${response.status}.`));
  }
  return normalizeTokenResponse(payload, null);
}

function normalizeTokenResponse(
  payload: unknown,
  previous: OpenAiSubscriptionCredentials | null,
): { credentials: OpenAiSubscriptionCredentials; identity: OpenAiSubscriptionIdentity } {
  const tokens = (payload ?? {}) as OpenAiTokenResponse;
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : "";
  const refreshToken = typeof tokens.refresh_token === "string"
    ? tokens.refresh_token
    : previous?.refresh_token ?? "";
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : previous?.id_token;
  if (!accessToken || !refreshToken) {
    throw new Error("OpenAI token response did not include usable credentials.");
  }
  const identity = getOpenAiSubscriptionIdentity(accessToken, idToken);
  const accountId = identity.accountId ?? previous?.account_id ?? null;
  if (!accountId) throw new Error("OpenAI sign-in did not identify a ChatGPT workspace.");
  const expiresIn = typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
    ? Math.max(60, Math.floor(tokens.expires_in))
    : 60 * 60;
  return {
    credentials: {
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(idToken ? { id_token: idToken } : {}),
      account_id: accountId,
      expires_at: Date.now() + expiresIn * 1000,
    },
    identity,
  };
}

export async function refreshOpenAiSubscriptionCredentials(
  credentials: OpenAiSubscriptionCredentials,
): Promise<{ credentials: OpenAiSubscriptionCredentials; identity: OpenAiSubscriptionIdentity }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh_token,
    client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
  });
  const response = await fetch(`${OPENAI_CODEX_AUTH_ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      throw new Error(
        "Your OpenAI connection has expired or was revoked. Reconnect it in Settings → AI Provider.",
      );
    }
    throw new Error(errorMessage(payload, `OpenAI token refresh returned ${response.status}.`));
  }
  return normalizeTokenResponse(payload, credentials);
}
