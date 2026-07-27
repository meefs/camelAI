import { Form, redirect, useLoaderData } from 'react-router';
import { parseWithZod } from '@conform-to/zod/v4';
import type { Route } from './+types/_app.settings.profile';
import { canUseSuperuserAccess, requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do';
import { resetOnboardingForUser } from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { SettingsHeader } from '@/components/settings/settings-header';
import { ProfileForm } from '@/components/settings/profile-form';
import { ThemePreference } from '@/components/settings/theme-preference';
import { profileSchema } from '@/lib/schemas';
import { normalizeAvatarColor, validateAvatarContent } from '@/lib/avatar';
import { ENTERPRISE_OIDC_AUTH_SOURCE } from '../../workers/main/src/signed-session';

export function meta() {
  return [
    { title: 'Profile - Settings - camelAI' },
    { name: 'description', content: 'Manage your profile settings' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  // The IdP owns enterprise-session profile claims. In particular, a legacy
  // SSO mapping may point at a global account that is also used in other orgs.
  if (authContext.session.auth_source === ENTERPRISE_OIDC_AUTH_SOURCE) {
    return Response.json(
      { error: 'Profile changes are unavailable in an enterprise SSO session' },
      { status: 403 },
    );
  }
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'restartOnboarding') {
    if (!canUseSuperuserAccess(authContext)) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    await resetOnboardingForUser(authEnv, authContext.user.id);
    throw redirect('/onboarding?reset=1');
  }

  if (intent === 'updateAvatar') {
    const avatarColor = normalizeAvatarColor(formData.get('avatarColor'));
    const avatarContentValue = formData.get('avatarContent');
    const avatarContent =
      typeof avatarContentValue === 'string' ? avatarContentValue.trim() : '';
    if (!avatarColor || !validateAvatarContent(avatarContent)) {
      return { error: 'Invalid avatar' };
    }

    const avatar = { color: avatarColor, content: avatarContent };
    await authDO.updateUser(authEnv, authContext.user!.id, { avatar });
    return { success: true, avatar };
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
  const env = getEnv(context);
  const orgStub = env.ORG.get(env.ORG.idFromName(authContext.currentOrg.id));
  const ssoConfig = await orgStub.getSsoConfig();
  return {
    user: authContext.user,
    canUseSuperuser: canUseSuperuserAccess(authContext),
    sso: ssoConfig?.enabled && !authContext.user.is_superuser
      ? { orgId: authContext.currentOrg.id, orgName: authContext.currentOrg.name }
      : null,
  };
}

export default function ProfilePage() {
  const { user, sso, canUseSuperuser } = useLoaderData<typeof loader>();

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
      {sso ? (
        <>
          <Separator />
          <div className="space-y-3 rounded-lg border p-4">
            <h2 className="text-sm font-semibold">Enterprise SSO</h2>
            <p className="text-sm text-muted-foreground">
              Link this account to the identity provider configured for {sso.orgName}.
            </p>
            <Form method="post" action="/api/auth/enterprise-oidc/link">
              <input type="hidden" name="org_id" value={sso.orgId} />
              <Button type="submit" variant="outline">Link my account with SSO</Button>
            </Form>
          </div>
        </>
      ) : null}
      {canUseSuperuser ? (
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
