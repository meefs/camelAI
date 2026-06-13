import type { User } from "@/types";
import type { AuthEnv } from "./auth-helpers";

export type UserProfileSummary = Pick<User, "id" | "name" | "email" | "avatar">;

interface LoadUserProfilesOptions {
  request?: Request;
  preloadedUsers?: Iterable<User | null | undefined>;
  allowPartialFailures?: boolean;
}

const requestUserProfileCache = new WeakMap<
  Request,
  Map<string, Promise<User | null>>
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
): Map<string, Promise<User | null>> | null {
  if (!request) return null;
  let cache = requestUserProfileCache.get(request);
  if (!cache) {
    cache = new Map();
    requestUserProfileCache.set(request, cache);
  }
  return cache;
}

export async function loadUsersById(
  env: AuthEnv,
  userIds: Iterable<string | null | undefined>,
  options: LoadUserProfilesOptions = {},
): Promise<Map<string, User>> {
  const ids = Array.from(new Set(Array.from(userIds).filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();

  const requestCache = getRequestCache(options.request);
  const preloadedProfiles = new Map<string, User>();
  for (const user of options.preloadedUsers ?? []) {
    if (!user?.id) continue;
    preloadedProfiles.set(user.id, user);
    requestCache?.set(user.id, Promise.resolve(user));
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
              .then((profile) => profile ?? null);
        requestCache?.set(id, profilePromise);
      }

      let profile: User | null;
      try {
        profile = await profilePromise;
      } catch (error) {
        if (!options.allowPartialFailures) {
          throw error;
        }
        profile = null;
      }
      return [id, profile] as const;
    }),
  );

  const profiles = new Map<string, User>();
  for (const [id, profile] of entries) {
    if (profile) {
      profiles.set(id, profile);
    }
  }
  return profiles;
}

export async function loadUserProfileSummaries(
  env: AuthEnv,
  userIds: Iterable<string | null | undefined>,
  options: LoadUserProfilesOptions = {},
): Promise<Map<string, UserProfileSummary>> {
  const users = await loadUsersById(env, userIds, options);
  return new Map(
    Array.from(users, ([id, user]) => [id, toProfileSummary(user)] as const),
  );
}
