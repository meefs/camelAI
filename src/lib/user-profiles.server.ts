import type { User } from "@/types";
import type { AuthEnv } from "./auth-helpers";

export type UserProfileSummary = Pick<User, "id" | "name" | "email" | "avatar">;

interface LoadUserProfileSummariesOptions {
  request?: Request;
  preloadedUsers?: Iterable<UserProfileSummary | null | undefined>;
}

const requestUserProfileCache = new WeakMap<
  Request,
  Map<string, Promise<UserProfileSummary | null>>
>();

function toProfileSummary(user: UserProfileSummary): UserProfileSummary {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
  };
}

function getRequestCache(
  request: Request | undefined,
): Map<string, Promise<UserProfileSummary | null>> | null {
  if (!request) return null;
  let cache = requestUserProfileCache.get(request);
  if (!cache) {
    cache = new Map();
    requestUserProfileCache.set(request, cache);
  }
  return cache;
}

export async function loadUserProfileSummaries(
  env: AuthEnv,
  userIds: Iterable<string | null | undefined>,
  options: LoadUserProfileSummariesOptions = {},
): Promise<Map<string, UserProfileSummary>> {
  const ids = Array.from(new Set(Array.from(userIds).filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();

  const requestCache = getRequestCache(options.request);
  const preloadedProfiles = new Map<string, UserProfileSummary>();
  for (const user of options.preloadedUsers ?? []) {
    if (!user?.id) continue;
    const profile = toProfileSummary(user);
    preloadedProfiles.set(profile.id, profile);
    requestCache?.set(profile.id, Promise.resolve(profile));
  }

  const entries = await Promise.all(
    ids.map(async (id) => {
      let profilePromise = requestCache?.get(id) ?? null;
      if (!profilePromise) {
        const preloaded = preloadedProfiles.get(id);
        profilePromise = preloaded
          ? Promise.resolve(preloaded)
          : env.USER.get(env.USER.idFromName(id))
              .getProfile()
              .then((profile) => (profile ? toProfileSummary(profile) : null));
        requestCache?.set(id, profilePromise);
      }

      const profile = await profilePromise;
      return [id, profile] as const;
    }),
  );

  const profiles = new Map<string, UserProfileSummary>();
  for (const [id, profile] of entries) {
    if (profile) {
      profiles.set(id, profile);
    }
  }
  return profiles;
}
