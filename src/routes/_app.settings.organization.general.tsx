import { useLoaderData } from 'react-router';
import { parseWithZod } from '@conform-to/zod/v4';
import type { Route } from './+types/_app.settings.organization.general';
import { requireAuthContext, requireOrgAdmin, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { archiveOrg, transferOrgOwnership, getOrgMembersWithWorkspaceAccess } from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { OrgGeneralForm } from '@/components/settings/org-general-form';
import { ArchiveOrgSection } from '@/components/settings/archive-org-section';
import { TransferOwnershipSection } from '@/components/settings/transfer-ownership-section';
import { orgNameSchema } from '@/lib/schemas';

export function meta() {
  return [
    { title: 'Organization General - Settings - camelAI' },
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

  if (intent === 'transferOwnership') {
    const currentUserOrg = authContext.orgs.find((o) => o.org_id === authContext.currentOrg.id);
    if (currentUserOrg?.role !== 'owner') {
      return { error: 'Only the organization owner can transfer ownership' };
    }
    const newOwnerId = formData.get('newOwnerId') as string;
    if (!newOwnerId) {
      return { error: 'New owner is required' };
    }
    try {
      await transferOrgOwnership(authEnv, authContext.currentOrg.id, newOwnerId, authContext.user.id);
      return { success: true, transferred: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to transfer ownership' };
    }
  }

  // Default: update org name
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
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
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const currentUserOrg = authContext.orgs.find((o) => o.org_id === authContext.currentOrg.id);
  const isOwner = currentUserOrg?.role === 'owner';

  // Load eligible transfer targets (admins who are not the owner) - only when owner
  let transferCandidates: Array<{ id: string; name: string | null; email: string }> = [];
  if (isOwner) {
    const members = await getOrgMembersWithWorkspaceAccess(authEnv, authContext.currentOrg.id);
    transferCandidates = members
      .filter((m) => m.role === 'admin')
      .map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email }));
  }

  return {
    org: authContext.currentOrg,
    isOwner,
    transferCandidates,
  };
}

export default function OrganizationGeneralPage() {
  const { org, isOwner, transferCandidates } = useLoaderData<typeof loader>();

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
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-medium text-destructive">Danger zone</h3>
              <p className="text-sm text-muted-foreground">
                Irreversible actions that affect this organization.
              </p>
            </div>
            <div className="rounded-lg border border-destructive/50 p-4 space-y-6">
              {transferCandidates.length > 0 ? (
                <TransferOwnershipSection candidates={transferCandidates} orgName={org.name} />
              ) : null}
              <ArchiveOrgSection orgName={org.name} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
