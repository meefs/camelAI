import { Form, redirect, useLoaderData } from 'react-router';
import { parseWithZod } from '@conform-to/zod/v4';
import type { Route } from './+types/_app.settings.profile';
import { requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do';
import { resetOnboardingForUser } from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { SettingsHeader } from '@/components/settings/settings-header';
import { ProfileForm } from '@/components/settings/profile-form';
import { ThemePreference } from '@/components/settings/theme-preference';
import { profileSchema } from '@/lib/schemas';

export function meta() {
  return [
    { title: 'Profile - Settings - camelAI' },
    { name: 'description', content: 'Manage your profile settings' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'restartOnboarding') {
    if (!authContext.user?.is_superuser) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    await resetOnboardingForUser(authEnv, authContext.user.id);
    throw redirect('/onboarding?reset=1');
  }

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

  await authDO.updateUser(authEnv, authContext.user!.id, updates);

  return { result: submission.reply(), success: true };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  return { user: authContext.user };
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
      {user.is_superuser ? (
        <>
          <Separator />
          <div className="space-y-3 rounded-lg border border-dashed p-4">
            <h2 className="text-sm font-semibold">Onboarding Testing</h2>
            <p className="text-sm text-muted-foreground">
              Temporary superuser-only control to reset your onboarding state and
              jump back into the flow.
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="restartOnboarding" />
              <Button type="submit" variant="outline">
                Restart Onboarding
              </Button>
            </Form>
          </div>
        </>
      ) : null}
    </div>
  );
}
