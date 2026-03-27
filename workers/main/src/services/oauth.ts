/**
 * OAuth user management service
 */

import type { Env } from '../types.js';
import type { OAuthProvider } from '../../../../src/lib/oauth-config.js';
import { assertEmailDomainAllowed, getBlocklistFromKV } from '../../../../src/lib/email-domain-blocklist.js';
import { getUserStub, getOrgStub, getWorkspaceStub } from '../helpers/stubs.js';

function normalizeSignupIp(ip: string | null | undefined): string | null {
  const normalized = ip?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export async function getOrCreateUserFromOAuth(
  env: Env,
  provider: OAuthProvider,
  userInfo: { email: string; name?: string; providerId: string },
  signupIp: string | null = null
): Promise<string> {
  const email = userInfo.email.toLowerCase();
  const emailKey = `email:${email}`;
  const oauthKey = `oauth:${provider}:${userInfo.providerId}`;
  const normalizedSignupIp = normalizeSignupIp(signupIp);

  // Check by email first
  let userId = await env.EMAIL_TO_USER.get(emailKey);
  if (userId) {
    const userStub = getUserStub(env, userId);
    const profile = await userStub.getProfile();

    if (!profile) {
      // Zombie KV entry: email maps to a UserDO with no profile (e.g. hard-deleted user).
      // Re-create the profile so the user can log in.
      console.warn('[oauth] zombie user detected, re-creating profile', { userId, email, provider });
      await userStub.createUserFromOAuth(
        userId,
        email,
        userInfo.name || email.split('@')[0],
        provider,
        userInfo.providerId
      );
      return userId;
    }

    // Link OAuth if not already linked
    const existingOAuth = await env.EMAIL_TO_USER.get(oauthKey);
    if (!existingOAuth || existingOAuth === userId) {
      await env.EMAIL_TO_USER.put(oauthKey, userId);
      await userStub.linkOAuthProvider(provider, userInfo.providerId);
    }
    return userId;
  }

  // Check by OAuth key (email might have changed)
  userId = await env.EMAIL_TO_USER.get(oauthKey);
  if (userId) {
    const userStub = getUserStub(env, userId);
    const profile = await userStub.getProfile();

    if (!profile) {
      // Zombie: oauth KV entry exists but UserDO has no profile.
      // Re-create profile and update email KV mapping.
      console.warn('[oauth] zombie user detected via oauth key, re-creating profile', { userId, email, provider });
      await userStub.createUserFromOAuth(
        userId,
        email,
        userInfo.name || email.split('@')[0],
        provider,
        userInfo.providerId
      );
      await env.EMAIL_TO_USER.put(emailKey, userId);
    }

    return userId;
  }

  // Create new user
  if (normalizedSignupIp && env.ADMIN_INDEX) {
    const adminIndex = env.ADMIN_INDEX.get(env.ADMIN_INDEX.idFromName('admin_index'));
    if (await adminIndex.isSignupIpBlocked(normalizedSignupIp)) {
      throw new Error('signup_ip_blocked');
    }
  }
  const blocklist = await getBlocklistFromKV(env.APP_KV);
  assertEmailDomainAllowed(email, blocklist);

  if (normalizedSignupIp && env.ADMIN_INDEX) {
    const adminIndex = env.ADMIN_INDEX.get(env.ADMIN_INDEX.idFromName('admin_index'));
    if (await adminIndex.isSignupIpBlocked(normalizedSignupIp)) {
      throw new Error('signup_ip_blocked');
    }
  }

  userId = crypto.randomUUID();
  await Promise.all([
    env.EMAIL_TO_USER.put(emailKey, userId),
    env.EMAIL_TO_USER.put(oauthKey, userId),
  ]);

  // Verify writes (race condition check)
  const [v1, v2] = await Promise.all([
    env.EMAIL_TO_USER.get(emailKey),
    env.EMAIL_TO_USER.get(oauthKey),
  ]);
  if (v1 !== userId || v2 !== userId) {
    await Promise.all([env.EMAIL_TO_USER.delete(emailKey), env.EMAIL_TO_USER.delete(oauthKey)]);
    throw new Error('oauth_race_condition');
  }

  try {
    await getUserStub(env, userId).createUserFromOAuth(
      userId,
      email,
      userInfo.name || email.split('@')[0],
      provider,
      userInfo.providerId,
      normalizedSignupIp
    );
  } catch (error) {
    // Clean up KV entries if DO profile creation fails to prevent zombie users
    await Promise.all([env.EMAIL_TO_USER.delete(emailKey), env.EMAIL_TO_USER.delete(oauthKey)]);
    throw error;
  }

  return userId;
}

export async function ensureDefaultOrgWorkspace(
  env: Env,
  userId: string,
  displayName: string
): Promise<{ orgId: string; workspaceId: string | null }> {
  const userStub = getUserStub(env, userId);
  const userOrgs = await userStub.getOrgs();

  if (userOrgs.length === 0) {
    // Create default org
    const orgId = crypto.randomUUID();
    const { defaultWorkspaceId } = await getOrgStub(env, orgId).createOrg(
      orgId,
      displayName,
      userId
    );
    await userStub.addOrg(orgId, 'owner', defaultWorkspaceId);
    return { orgId, workspaceId: defaultWorkspaceId };
  }

  // Use existing org
  const orgId = userOrgs[0].org_id;
  let workspaceId = userOrgs[0].last_workspace_id ?? null;

  if (!workspaceId) {
    const orgStub = getOrgStub(env, orgId);
    const workspaces = await orgStub.getWorkspaces();
    const existing = workspaces.find((w) => !w.archived);

    if (existing) {
      workspaceId = existing.id;
    } else {
      workspaceId = crypto.randomUUID();
      await getWorkspaceStub(env, workspaceId).createWorkspace(
        workspaceId,
        orgId,
        'Default Workspace',
        userId,
        null
      );
      await userStub.setOrgLastWorkspace(orgId, workspaceId);
    }
  }

  return { orgId, workspaceId };
}
