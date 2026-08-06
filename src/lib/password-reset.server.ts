import type { CloudflareEnv } from "./cloudflare.server";
import {
  resolveAppBaseUrl,
  sendPasswordResetEmail,
  type EmailDeliveryResult,
} from "./email.server";
import {
  createPasswordResetToken,
  PASSWORD_RESET_TOKEN_TTL_MS,
} from "./password-reset-token";

export async function sendUserPasswordResetEmail(args: {
  env: Pick<
    CloudflareEnv,
    | "TOKEN_SIGNING_SECRET"
    | "WORKER_BASE_URL"
    | "EMAIL"
    | "EMAIL_FROM_ADDRESS"
  >;
  requestUrl: URL;
  userId: string;
  email: string;
  nonce: string;
}): Promise<EmailDeliveryResult> {
  const { env, requestUrl, userId, nonce } = args;
  const email = args.email.trim().toLowerCase();

  const issuedAt = Date.now();
  const expiresAt = issuedAt + PASSWORD_RESET_TOKEN_TTL_MS;
  const token = await createPasswordResetToken(env.TOKEN_SIGNING_SECRET, {
    user_id: userId,
    email,
    nonce,
    issuedAt,
    ttlMs: PASSWORD_RESET_TOKEN_TTL_MS,
  });

  const baseUrl = resolveAppBaseUrl(env, requestUrl);
  const resetUrl = new URL("/reset-password", baseUrl);
  resetUrl.searchParams.set("token", token);

  return sendPasswordResetEmail({
    env,
    to: email,
    resetUrl: resetUrl.toString(),
    expiresAt,
  });
}
