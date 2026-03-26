import type { CloudflareEnv } from "@/lib/cloudflare.server";

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_ACTION = "email_signup";

type TurnstileSiteverifyResponse = {
  success: boolean;
  "error-codes"?: string[];
  action?: string;
  hostname?: string;
};

export type TurnstileValidationResult =
  | { success: true }
  | {
      success: false;
      errorCode:
        | "not_configured"
        | "missing_token"
        | "invalid_response"
        | "invalid_action"
        | "invalid_hostname";
      errorCodes?: string[];
    };

export function shouldBypassTurnstile(
  env: Pick<CloudflareEnv, "NEXTJS_ENV">,
  requestUrl?: URL | string,
) {
  if (env.NEXTJS_ENV === "development") {
    return true;
  }

  if (!requestUrl) {
    return false;
  }

  const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

export function getTurnstileAction() {
  return TURNSTILE_ACTION;
}

export async function validateTurnstileToken({
  env,
  request,
  token,
}: {
  env: Pick<
    CloudflareEnv,
    "NEXTJS_ENV" | "TURNSTILE_SECRET_KEY" | "TURNSTILE_SITE_KEY"
  >;
  request: Request;
  token: string | undefined;
}): Promise<TurnstileValidationResult> {
  if (shouldBypassTurnstile(env, request.url)) {
    return { success: true };
  }

  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) {
    return { success: false, errorCode: "not_configured" };
  }

  if (!token) {
    return { success: false, errorCode: "missing_token" };
  }

  const formData = new FormData();
  formData.set("secret", env.TURNSTILE_SECRET_KEY);
  formData.set("response", token);

  const clientIp = getClientIp(request);
  if (clientIp) {
    formData.set("remoteip", clientIp);
  }

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: formData,
    });

    const result = (await response.json()) as TurnstileSiteverifyResponse;
    if (!response.ok || !result.success) {
      return {
        success: false,
        errorCode: "invalid_response",
        errorCodes: result["error-codes"],
      };
    }

    if (result.action && result.action !== TURNSTILE_ACTION) {
      return {
        success: false,
        errorCode: "invalid_action",
        errorCodes: result["error-codes"],
      };
    }

    const expectedHostname = new URL(request.url).hostname;
    if (result.hostname && result.hostname !== expectedHostname) {
      return {
        success: false,
        errorCode: "invalid_hostname",
        errorCodes: result["error-codes"],
      };
    }
  } catch {
    return {
      success: false,
      errorCode: "invalid_response",
    };
  }

  return { success: true };
}

function getClientIp(request: Request) {
  const cfConnectingIp = request.headers.get("CF-Connecting-IP");
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const xForwardedFor = request.headers.get("X-Forwarded-For");
  if (!xForwardedFor) {
    return null;
  }

  return xForwardedFor.split(",")[0]?.trim() || null;
}
