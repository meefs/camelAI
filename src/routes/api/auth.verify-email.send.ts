import type { AppLoadContext } from "react-router";
import { requireAuthContext } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { sendUserVerificationEmail } from "@/lib/email-verification.server";

export async function action({
  request,
  context,
}: {
  request: Request;
  context: AppLoadContext;
}) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const userStub = env.USER.get(env.USER.idFromName(authContext.user.id));
  const verificationStatus = await userStub.getEmailVerificationStatus();

  if (!verificationStatus.required || verificationStatus.verified) {
    return Response.json({
      success: true,
      alreadyVerified: verificationStatus.verified,
    });
  }

  const delivery = await sendUserVerificationEmail({
    env,
    requestUrl: new URL(request.url),
    userId: authContext.user.id,
    email: authContext.user.email,
  });

  if (delivery.status === "sent") {
    return Response.json({ success: true });
  }

  console.error("Failed to send verification email:", delivery.reason);
  return Response.json(
    {
      error: "Unable to send verification email right now. Please try again.",
    },
    { status: delivery.status === "skipped" ? 503 : 500 },
  );
}
