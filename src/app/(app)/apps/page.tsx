import { headers } from 'next/headers';
import AppsClient from './apps-client';
import { requireAuthContextLite } from '@/lib/server-guards';
import { getOrgApps } from '@/lib/server-actions/apps';

export default async function AppsPage() {
  const authContext = await requireAuthContextLite();
  const apps = await getOrgApps(authContext.currentOrg.id);
  const headerStore = await headers();
  const hostname = headerStore.get('host')?.split(':')[0] ?? 'chiridion.ai';
  const renderedAt = Date.now();

  return (
    <AppsClient
      initialApps={apps}
      orgId={authContext.currentOrg.id}
      hostname={hostname}
      initialNow={renderedAt}
    />
  );
}
