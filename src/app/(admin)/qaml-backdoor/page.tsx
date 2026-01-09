import * as authDO from '@/lib/auth-do';
import { AdminDashboard } from '@/components/admin/admin-dashboard';
import { requireSuperuser } from '@/lib/server-guards';

export default async function AdminPage() {
  await requireSuperuser();

  const [overview, threads] = await Promise.all([
    authDO.getAdminOverview(),
    authDO.adminGetAllThreads(),
  ]);

  const safeOverview = {
    users: overview.users.map((entry) => ({
      id: entry.id,
      email: entry.email,
      name: entry.name,
      created_at: entry.created_at,
      is_superuser: entry.is_superuser,
      org_count: entry.org_count,
      avatar: {
        color: entry.avatar.color,
        content: entry.avatar.content,
      },
      is_orphaned: entry.is_orphaned,
    })),
    total_users: overview.total_users,
    total_orgs: overview.total_orgs,
    total_memberships: overview.total_memberships,
    total_workspaces: overview.total_workspaces,
    total_integrations: overview.total_integrations,
    orphaned_users: overview.orphaned_users,
  };

  return (
    <AdminDashboard
      overview={safeOverview}
      threadCount={threads.length}
    />
  );
}
