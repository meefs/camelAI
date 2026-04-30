import { redirect } from "react-router";
import type { Route } from "./+types/dev.verify-email";
import { requireAuthContext } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";

function isDevVerificationEnabled(env: { NEXTJS_ENV?: string }): boolean {
  return env.NEXTJS_ENV === "development";
}

function getRedirectPath(request: Request): string {
  const url = new URL(request.url);
  const redirectTo = url.searchParams.get("redirect");
  return redirectTo?.startsWith("/") && !redirectTo.startsWith("//")
    ? redirectTo
    : "/onboarding";
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  if (!isDevVerificationEnabled(env)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const authContext = await requireAuthContext(request, context);
  await env.USER.get(env.USER.idFromName(authContext.user.id)).markEmailVerified();

  throw redirect(getRedirectPath(request));
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const env = getEnv(context);
  if (!isDevVerificationEnabled(env)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const authContext = await requireAuthContext(request, context);
  await env.USER.get(env.USER.idFromName(authContext.user.id)).markEmailVerified();

  return Response.json({ success: true });
}
