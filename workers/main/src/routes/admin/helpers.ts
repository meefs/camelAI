/**
 * DO stub accessors for the admin API.
 */

import type { Env } from '../../types.js';
import type { OrgDO, UserDO } from '../../auth.js';
import type { AdminIndexDO } from '../../admin-index-do.js';

// ---------------------------------------------------------------------------
// DO stub helpers
// ---------------------------------------------------------------------------

export function getAdminIndexStub(env: Env) {
  return env.ADMIN_INDEX.get(env.ADMIN_INDEX.idFromName('admin_index')) as DurableObjectStub<AdminIndexDO>;
}

export function getOrgStub(env: Env, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId)) as DurableObjectStub<OrgDO>;
}

export function getUserStub(env: Env, userId: string) {
  return env.USER.get(env.USER.idFromName(userId)) as DurableObjectStub<UserDO>;
}
