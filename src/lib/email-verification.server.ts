import type { CloudflareEnv } from "./cloudflare.server";
import {
  resolveAppBaseUrl,
  sendEmailVerificationEmail,
  type EmailDeliveryResult,
} from "./email.server";
import { createEmailVerificationToken } from "./email-verification-token";

const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function sendUserVerificationEmail(args: {
  env: Pick<
    CloudflareEnv,
    | "TOKEN_SIGNING_SECRET"
    | "WORKER_BASE_URL"
    | "EMAIL_FROM_ADDRESS"
    | "RESEND_API_KEY"
  >;
  requestUrl: URL;
  userId: string;
  email: string;
}): Promise<EmailDeliveryResult> {
  const { env, requestUrl, userId } = args;
  const email = args.email.trim().toLowerCase();

  const issuedAt = Date.now();
  const expiresAt = issuedAt + EMAIL_VERIFICATION_TOKEN_TTL_MS;
  const token = await createEmailVerificationToken(env.TOKEN_SIGNING_SECRET, {
    user_id: userId,
    email,
    issuedAt,
    ttlMs: EMAIL_VERIFICATION_TOKEN_TTL_MS,
  });

  const baseUrl = resolveAppBaseUrl(env, requestUrl);
  const verificationUrl = new URL("/api/auth/verify-email", baseUrl);
  verificationUrl.searchParams.set("token", token);

  return sendEmailVerificationEmail({
    env,
    to: email,
    verificationUrl: verificationUrl.toString(),
    expiresAt,
  });
}
