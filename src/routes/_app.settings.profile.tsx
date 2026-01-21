import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.profile';
import { requireAuthContext } from '@/lib/auth.server';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { ProfileForm } from '@/components/settings/profile-form';

export function meta() {
  return [
    { title: 'Profile - Settings - Chiridion' },
    { name: 'description', content: 'Manage your profile settings' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  const safeUser = {
    id: authContext.user.id,
    email: authContext.user.email,
    name: authContext.user.name,
    created_at: authContext.user.created_at,
    is_superuser: authContext.user.is_superuser,
    avatar: {
      color: authContext.user.avatar.color,
      content: authContext.user.avatar.content,
    },
    is_orphaned: authContext.user.is_orphaned,
  };

  return { user: safeUser };
}

export default function ProfilePage() {
  const { user } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Profile"
        description="Manage your personal account settings."
      />
      <Separator />
      <ProfileForm user={user} />
    </div>
  );
}
