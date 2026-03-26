import type { Route } from "./+types/auth.signup";
import { getEnv, type CloudflareEnv } from "@/lib/cloudflare.server";
import { createSessionCookieHeader } from "@/lib/cookies.server";
import { type AuthEnv } from "@/lib/auth-helpers";
import {
  getUserByEmail,
  createUser,
  createOrg,
  createSession,
} from "@/lib/auth-do";
import {
  isEmailDomainBlocked,
  isEmailDomainBlockedError,
} from "@/lib/email-domain-blocklist";
import { sendUserVerificationEmail } from "@/lib/email-verification.server";
import {
  consumeSalesPrompt,
  getPromptKeyFromUrl,
} from "@/lib/sales-prompt.server";
import { validateTurnstileToken } from "@/lib/turnstile.server";
import { waitUntil } from "@/lib/wait-until";

function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv["USER"],
    ORG: env.ORG as AuthEnv["ORG"],
    WORKSPACE: env.WORKSPACE as AuthEnv["WORKSPACE"],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
    TOKEN_SIGNING_SECRET: env.TOKEN_SIGNING_SECRET,
    EMAIL_DOMAIN_BLOCKLIST: env.EMAIL_DOMAIN_BLOCKLIST,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = (await request.json()) as {
      email?: string;
      password?: string;
      name?: string;
      redirectTo?: string;
      turnstileToken?: string;
    };
    const { email, password, name, redirectTo, turnstileToken } = body;

    if (!email || !password) {
      return Response.json(
        { error: "Email and password are required" },
        { status: 400 },
      );
    }

    const env = getEnv(context);
    const authEnv = getAuthEnv(env);
    const turnstileResult = await validateTurnstileToken({
      env,
      request,
      token: turnstileToken,
    });

    if (!turnstileResult.success) {
      const status =
        turnstileResult.errorCode === "not_configured" ? 503 : 400;
      const error =
        turnstileResult.errorCode === "not_configured"
          ? "Email signup is temporarily unavailable"
          : "Security check failed. Please try again.";

      if (turnstileResult.errorCode !== "missing_token") {
        console.warn("Turnstile signup verification failed", {
          errorCode: turnstileResult.errorCode,
          errorCodes: turnstileResult.errorCodes,
        });
      }

      return Response.json({ error }, { status });
    }

    if (isEmailDomainBlocked(email, env.EMAIL_DOMAIN_BLOCKLIST)) {
      return Response.json(
        { error: "Email signups from this domain are not allowed" },
        { status: 400 },
      );
    }

    const existingUser = await getUserByEmail(authEnv, email);
    if (existingUser) {
      return Response.json({ error: "User already exists" }, { status: 400 });
    }

    const { userId, user } = await createUser(
      authEnv,
      email,
      password,
      name ?? null,
    );
    const orgName = name || email.split("@")[0];
    const { org, defaultWorkspaceId } = await createOrg(
      authEnv,
      orgName,
      userId,
    );
    const { signedToken } = await createSession(
      authEnv,
      userId,
      org.id,
      defaultWorkspaceId,
      {
        name: user.name,
        email: user.email,
      },
    );

    // Consume the sales prompt from KV immediately and store on the UserDO.
    // This avoids the 30-minute KV TTL expiring during email verification.
    const promptKey = getPromptKeyFromRedirectPath(redirectTo);
    if (promptKey) {
      waitUntil(
        consumeSalesPrompt(env.APP_KV, promptKey)
          .then(async (prompt) => {
            if (prompt) {
              const userStub = authEnv.USER.get(
                authEnv.USER.idFromName(userId),
              );
              await userStub.setPendingSalesPrompt(prompt);
            }
          })
          .catch((error) => {
            console.error("Failed to consume sales prompt on signup:", error);
          }),
      );
    }

    waitUntil(
      sendUserVerificationEmail({
        env,
        requestUrl: new URL(request.url),
        userId,
        email: user.email,
      })
        .then((result) => {
          if (result.status !== "sent") {
            console.warn(
              "Failed to send verification email on signup:",
              result.reason,
            );
          }
        })
        .catch((error) => {
          console.error(
            "Unexpected verification email error on signup:",
            error,
          );
        }),
    );

    return Response.json(
      { success: true },
      {
        headers: {
          "Set-Cookie": createSessionCookieHeader(signedToken, request),
        },
      },
    );
  } catch (error) {
    if (isEmailDomainBlockedError(error)) {
      return Response.json(
        { error: "Email signups from this domain are not allowed" },
        { status: 400 },
      );
    }

    console.error("Signup error:", error);
    return Response.json({ error: "Signup failed" }, { status: 500 });
  }
}

function getPromptKeyFromRedirectPath(
  redirectTo: string | undefined,
): string | null {
  if (!redirectTo) return null;
  if (
    !redirectTo.startsWith("/") ||
    redirectTo.startsWith("//") ||
    redirectTo.includes(":")
  ) {
    return null;
  }

  try {
    return getPromptKeyFromUrl(new URL(redirectTo, "https://camelai.dev"));
  } catch {
    return null;
  }
}
