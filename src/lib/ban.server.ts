import { redirect, type AppLoadContext } from "react-router";
import { getEnv } from "./cloudflare.server";
import { createDeleteSessionCookieHeader } from "./cookies.server";
import {
  isOrgBanned,
  isUserBanned,
  type BanRecord,
  normalizeBanEmail,
} from "../../workers/main/src/ban-list";

export async function getBanForEmail(
  context: AppLoadContext,
  email: string | null | undefined,
): Promise<BanRecord | null> {
  const normalized = normalizeBanEmail(email);
  if (!normalized) return null;
  return isUserBanned(getEnv(context).APP_KV, { email: normalized });
}

export async function getBanForSessionIdentifiers(
  context: AppLoadContext,
  identifiers: {
    userId?: string | null;
    userEmail?: string | null;
    orgId?: string | null;
  },
): Promise<BanRecord | null> {
  const env = getEnv(context);
  const userBan = await isUserBanned(env.APP_KV, {
    userId: identifiers.userId,
    email: identifiers.userEmail,
  });
  if (userBan) return userBan;

  if (identifiers.orgId) {
    const orgBan = await isOrgBanned(env.APP_KV, { orgId: identifiers.orgId });
    if (orgBan) return orgBan;
  }

  return null;
}

export async function redirectIfBannedSession(
  request: Request,
  context: AppLoadContext,
  identifiers: {
    userId?: string | null;
    userEmail?: string | null;
    orgId?: string | null;
  },
): Promise<void> {
  const ban = await getBanForSessionIdentifiers(context, identifiers);
  if (!ban) return;

  throw redirect("/banned", {
    headers: {
      "Set-Cookie": createDeleteSessionCookieHeader(request),
    },
  });
}
