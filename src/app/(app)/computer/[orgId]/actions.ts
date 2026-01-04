'use server';

import { redirect } from 'next/navigation';
import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';
import * as computerDO from '@/lib/computer-do';

export async function resetSandboxContainerAction(orgId: string) {
  const sessionId = await getSessionId();
  if (!sessionId) {
    redirect('/login');
  }

  const session = await authDO.getSession(sessionId);
  if (!session) {
    redirect('/login');
  }

  if (session.org_id !== orgId) {
    redirect(`/computer/${session.org_id}`);
  }

  await computerDO.resetSandboxContainer(orgId);
}
