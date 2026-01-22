import { useLoaderData, useActionData } from 'react-router';
import { parseWithZod } from '@conform-to/zod/v4';
import type { Route } from './+types/_app.settings.profile';
import { requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { ProfileForm } from '@/components/settings/profile-form';
import { ThemePreference } from '@/components/settings/theme-preference';
import { profileSchema } from '@/lib/schemas';

export function meta() {
  return [
    { title: 'Profile - Settings - Chiridion' },
    { name: 'description', content: 'Manage your profile settings' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema: profileSchema });

  if (submission.status !== 'success') {
    return { result: submission.reply() };
  }

  const { name, avatarColor, avatarContent } = submission.value;

  const updates: { name?: string | null; avatar?: { color: string; content: string } } = {};
  if (name !== undefined) {
    updates.name = name.trim() || null;
  }
  if (avatarColor && avatarContent) {
    updates.avatar = { color: avatarColor, content: avatarContent };
  }

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  await authDO.updateUserProfile(authEnv, authContext.user!.id, updates);

  return { result: submission.reply(), success: true };
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
      <Separator />
      <ThemePreference />
    </div>
  );
}
