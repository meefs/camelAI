import { notFound, redirect } from 'next/navigation';
import * as authDO from '@/lib/auth-do';
import { getSessionId } from '@/lib/auth';
import { AdminDashboard } from '@/components/admin/admin-dashboard';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const sessionId = await getSessionId();
  if (!sessionId) {
    redirect('/login');
  }

  const session = await authDO.getSession(sessionId);
  if (!session) {
    redirect('/login');
  }

  const user = await authDO.getUserById(session.user_id);
  if (!user) {
    redirect('/login');
  }

  if (!user.is_superuser) {
    notFound();
  }

  const overview = await authDO.getAdminOverview();
  const safeOverview = {
    users: overview.users.map((entry) => ({
      id: entry.id,
      email: entry.email,
      name: entry.name,
      created_at: entry.created_at,
      is_superuser: entry.is_superuser,
      org_count: entry.org_count,
    })),
    total_users: overview.total_users,
    total_orgs: overview.total_orgs,
    total_memberships: overview.total_memberships,
  };
  return <AdminDashboard overview={safeOverview} />;
}
