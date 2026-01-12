import AppsClient from './apps-client';
import { requireAuthContextLite } from '@/lib/server-guards';
import { getOrgApps } from '@/lib/server-actions/apps';

export default async function AppsPage() {
  const authContext = await requireAuthContextLite();
  const apps = await getOrgApps(authContext.currentOrg.id);

  return (
    <AppsClient
      initialApps={apps}
      orgId={authContext.currentOrg.id}
    />
  );
}
