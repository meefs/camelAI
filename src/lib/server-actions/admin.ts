'use server';

import * as authDO from '@/lib/auth-do';
import { requireSuperuser } from '@/lib/server-guards';

export async function updateAdminUser(
  userId: string,
  updates: { name?: string | null; is_superuser?: boolean }
) {
  await requireSuperuser('Forbidden');
  const profile = await authDO.adminUpdateUser(userId, {
    name: updates.name ?? undefined,
    is_superuser: updates.is_superuser,
  });
  if (!profile) {
    throw new Error('User not found');
  }
  return profile;
}

export async function updateAdminOrg(orgId: string, updates: { name?: string }) {
  await requireSuperuser('Forbidden');
  if (updates.name !== undefined) {
    await authDO.updateOrgName(orgId, updates.name);
  }
  const org = await authDO.getOrg(orgId);
  if (!org) {
    throw new Error('Organization not found');
  }
  return org;
}

export async function updateAdminThread(threadId: string, updates: { title?: string }) {
  await requireSuperuser('Forbidden');
  const thread = await authDO.adminUpdateThread(threadId, updates);
  if (!thread) {
    throw new Error('Thread not found');
  }
  return thread;
}
