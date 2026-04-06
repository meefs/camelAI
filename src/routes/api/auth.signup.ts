import type { Route } from "./+types/auth.signup";
import { getEnv } from "@/lib/cloudflare.server";
import { createSessionCookieHeader } from "@/lib/cookies.server";
import { getAuthEnv } from "@/lib/auth-helpers";
import {
  getUserByEmail,
  createUser,
  createOrg,
  createSession,
  isSignupIpBlocked,
} from "@/lib/auth-do";
import {
  isEmailDomainBlocked,
  isEmailDomainBlockedError,
  getBlocklistFromKV,
} from "@/lib/email-domain-blocklist";
import { getBanForEmail } from "@/lib/ban.server";
import { sendUserVerificationEmail } from "@/lib/email-verification.server";
import {
  consumeSalesPrompt,
  getPromptKeyFromUrl,
} from "@/lib/sales-prompt.server";
import { validateTurnstileToken } from "@/lib/turnstile.server";
import { waitUntil } from "@/lib/wait-until";
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
    const signupIp = getSignupIpFromRequest(request);
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

    if (await isSignupIpBlocked(authEnv, signupIp)) {
      return Response.json(
        { error: "Signups from this IP address are blocked" },
        { status: 403 },
      );
    }

    const blocklist = await getBlocklistFromKV(env.APP_KV);
    if (isEmailDomainBlocked(email, blocklist)) {
      return Response.json(
        { error: "Email signups from this domain are not allowed" },
        { status: 400 },
      );
    }

    const existingBan = await getBanForEmail(context, email);
    if (existingBan) {
      return Response.json(
        { error: "This account has been blocked.", redirect: "/banned" },
        { status: 403 },
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
      signupIp,
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

function getSignupIpFromRequest(request: Request): string | null {
  const cfConnectingIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) {
    return null;
  }

  const firstIp = forwardedFor.split(",")[0]?.trim();
  return firstIp || null;
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
