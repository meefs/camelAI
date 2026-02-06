import type { Route } from './+types/_admin._index';
import { getAuthEnv, requireSuperuser } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do.server';
import { resetOnboardingForUser } from '@/lib/auth-do';
import { AdminDashboard } from '@/components/admin/admin-dashboard';
import { redirect } from 'react-router';

export function meta() {
  return [
    { title: 'Admin Dashboard - Chiridion' },
    { name: 'description', content: 'Admin dashboard' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const [overview, threads, appCount] = await Promise.all([
    authDO.getAdminOverview(context),
    authDO.adminGetAllThreads(context),
    authDO.adminGetAppCount(context),
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

  return {
    overview: safeOverview,
    threadCount: threads.length,
    appCount,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireSuperuser(request, context);
  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'restartOwnOnboarding') {
    const authEnv = getAuthEnv(getEnv(context));
    await resetOnboardingForUser(authEnv, authContext.user.id);
    throw redirect('/onboarding');
  }

  return Response.json({ error: 'Unknown intent' }, { status: 400 });
}

export default function AdminIndexPage({ loaderData }: Route.ComponentProps) {
  const { overview, threadCount, appCount } = loaderData;

  return (
    <AdminDashboard
      overview={overview}
      threadCount={threadCount}
      appCount={appCount}
    />
  );
}
