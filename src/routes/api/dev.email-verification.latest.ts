import type { Route } from "./+types/dev.email-verification.latest";
import { requireAuthContext } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import {
  isDevEmailOutboxEnabled,
  listDevEmailOutboxEntries,
} from "@/lib/dev-email-outbox";

const VERIFICATION_EMAIL_SUBJECT = "Verify your email for camelAI";
const VERIFICATION_URL_PATTERN =
  /https?:\/\/[^\s<>()"']+\/api\/auth\/verify-email\?token=[A-Za-z0-9._~-]+/;

function extractVerificationUrl(textBody: string): string | null {
  return textBody.match(VERIFICATION_URL_PATTERN)?.[0] ?? null;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  if (!isDevEmailOutboxEnabled(env)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  let authContext: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    authContext = await requireAuthContext(request, context);
  } catch (error) {
    if (error instanceof Response && error.status >= 300 && error.status < 400) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw error;
  }

  const email = authContext.user.email.trim().toLowerCase();
  const { entries } = await listDevEmailOutboxEntries(env, { limit: 100 });
  const verificationEmail = entries.find(
    (entry) =>
      entry.to.trim().toLowerCase() === email &&
      entry.subject === VERIFICATION_EMAIL_SUBJECT,
  );
  const verificationUrl = verificationEmail
    ? extractVerificationUrl(verificationEmail.textBody)
    : null;

  if (!verificationEmail || !verificationUrl) {
    return Response.json(
      { error: "Verification email not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    {
      verificationUrl,
      createdAt: verificationEmail.createdAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
