import * as authDO from '@/lib/auth-do';
import { AdminDashboard } from '@/components/admin/admin-dashboard';

export default async function AdminPage() {
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
    })),
    total_users: overview.total_users,
    total_orgs: overview.total_orgs,
    total_memberships: overview.total_memberships,
  };

  return (
    <AdminDashboard
      overview={safeOverview}
      threadCount={threads.length}
    />
  );
}
