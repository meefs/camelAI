'use server';

import * as authDO from '@/lib/auth-do';
import type { WorkerScript } from '@/types';
import { requireOrgAdmin, requireOrgMember } from '@/lib/server-guards';

function toSafeWorkerScript(script: authDO.WorkerScript): WorkerScript {
  return {
    script_name: script.script_name,
    workspace_id: script.workspace_id,
    created_by: script.created_by,
    created_at: script.created_at,
    updated_at: script.updated_at,
    is_public: script.is_public,
  };
}

export async function getOrgApps(orgId: string): Promise<WorkerScript[]> {
  await requireOrgMember(orgId, 'You must be a member of this organization');
  const scripts = await authDO.listWorkerScripts(orgId);
  return scripts.map(toSafeWorkerScript);
}

export async function setAppPublic(
  orgId: string,
  scriptName: string,
  isPublic: boolean
): Promise<WorkerScript> {
  const session = await requireOrgAdmin(orgId, 'Only admins can change app visibility');

  const script = await authDO.setWorkerScriptPublic(orgId, scriptName, isPublic, session.user_id);
  if (!script) {
    throw new Error('App not found');
  }
  return toSafeWorkerScript(script);
}

export async function deleteApp(orgId: string, scriptName: string): Promise<void> {
  const session = await requireOrgAdmin(orgId, 'Only admins can delete apps');

  const success = await authDO.deleteWorkerScript(orgId, scriptName, session.user_id);
  if (!success) {
    throw new Error('App not found or could not be deleted');
  }
}
