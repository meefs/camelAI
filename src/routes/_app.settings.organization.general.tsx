import { useLoaderData } from 'react-router';
import { parseWithZod } from '@conform-to/zod/v4';
import type { Route } from './+types/_app.settings.organization.general';
import { requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { archiveOrg } from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { OrgGeneralForm } from '@/components/settings/org-general-form';
import { ArchiveOrgSection } from '@/components/settings/archive-org-section';
import { orgNameSchema } from '@/lib/schemas';

export function meta() {
  return [
    { title: 'Organization General - Settings - Chiridion' },
    { name: 'description', content: 'Manage organization settings' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const formData = await request.formData();
  const intent = formData.get('intent');
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  if (intent === 'archiveOrg') {
    // Only the owner can archive the org
    const currentUserOrg = authContext.orgs.find((o) => o.org_id === authContext.currentOrg.id);
    if (currentUserOrg?.role !== 'owner') {
      return { error: 'Only the organization owner can archive the organization' };
    }
    await archiveOrg(authEnv, authContext.currentOrg.id, authContext.user.id);
    return { success: true, archived: true };
  }

  // Default: update org name
  const submission = parseWithZod(formData, { schema: orgNameSchema });

  if (submission.status !== 'success') {
    return { result: submission.reply() };
  }

  const { name } = submission.value;
  const stub = authEnv.ORG.get(authEnv.ORG.idFromName(authContext.currentOrg!.id));
  await stub.updateName(name.trim(), authContext.user!.id);

  return { result: submission.reply(), success: true };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  const currentUserOrg = authContext.orgs.find((o) => o.org_id === authContext.currentOrg.id);
  const isOwner = currentUserOrg?.role === 'owner';

  return {
    org: authContext.currentOrg,
    isOwner,
  };
}

export default function OrganizationGeneralPage() {
  const { org, isOwner } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Organization"
        description="Manage your organization settings."
      />
      <Separator />
      <OrgGeneralForm org={org} canEdit={true} />
      {isOwner ? (
        <>
          <Separator />
          <ArchiveOrgSection orgName={org.name} />
        </>
      ) : null}
    </div>
  );
}
