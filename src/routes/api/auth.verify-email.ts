import type { AppLoadContext } from "react-router";
import { getEnv } from "@/lib/cloudflare.server";
import { getSignedSessionFromRequest } from "@/lib/cookies.server";
import { validateEmailVerificationToken } from "@/lib/email-verification-token";

function redirectWithParams(
  request: Request,
  path: string,
  params: Record<string, string>,
): Response {
  const destination = new URL(path, request.url);
  for (const [key, value] of Object.entries(params)) {
    destination.searchParams.set(key, value);
  }
  return Response.redirect(destination.toString(), 302);
}

export async function loader({
  request,
  context,
}: {
  request: Request;
  context: AppLoadContext;
}) {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim();
  if (!token) {
    return redirectWithParams(request, "/login", {
      error: "email_verification_invalid",
    });
  }

  const env = getEnv(context);
  const payload = await validateEmailVerificationToken(
    env.TOKEN_SIGNING_SECRET,
    token,
  );
  if (!payload) {
    return redirectWithParams(request, "/login", {
      error: "email_verification_invalid",
    });
  }

  const userStub = env.USER.get(env.USER.idFromName(payload.user_id));
  const profile = await userStub.getProfile();
  if (!profile || profile.email.toLowerCase() !== payload.email.toLowerCase()) {
    return redirectWithParams(request, "/login", {
      error: "email_verification_invalid",
    });
  }

  await userStub.markEmailVerified();

  return redirectWithParams(request, "/onboarding", {
    emailVerified: "1",
  });
}
