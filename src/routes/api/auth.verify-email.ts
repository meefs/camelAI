import type { AppLoadContext } from "react-router";
import { getEnv } from "@/lib/cloudflare.server";
import { createSessionCookieHeader } from "@/lib/cookies.server";
import { getAuthEnv } from "@/lib/auth-helpers";
import {
  createSession,
  getUserOrgs,
  listUserWorkspaces,
} from "@/lib/auth-do";
import { getBanForEmail } from "@/lib/ban.server";
import { validateEmailVerificationToken } from "@/lib/email-verification-token";

function redirectWithParams(
  request: Request,
  path: string,
  params: Record<string, string>,
  headers?: HeadersInit,
): Response {
  const destination = new URL(path, request.url);
  for (const [key, value] of Object.entries(params)) {
    destination.searchParams.set(key, value);
  }
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Location", destination.toString());
  return new Response(null, { status: 302, headers: responseHeaders });
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

  if (await getBanForEmail(context, profile.email)) {
    return redirectWithParams(request, "/banned", {});
  }

  await userStub.markEmailVerified();

  const authEnv = getAuthEnv(env);
  const orgs = await getUserOrgs(authEnv, payload.user_id);
  if (orgs.length === 0) {
    return redirectWithParams(request, "/login", {
      error: "email_verification_signin_failed",
    });
  }

  const orgId = orgs[0].org_id;
  const workspaces = await listUserWorkspaces(authEnv, payload.user_id, orgId);
  const workspaceId = workspaces[0]?.id ?? null;
  const { signedToken } = await createSession(
    authEnv,
    payload.user_id,
    orgId,
    workspaceId,
    { name: profile.name, email: profile.email },
  );

  return redirectWithParams(request, "/onboarding", {
    emailVerified: "1",
  }, {
    "Set-Cookie": createSessionCookieHeader(signedToken, request),
  });
}
