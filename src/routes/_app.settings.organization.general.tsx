import { useLoaderData } from 'react-router';
import { parseWithZod } from '@conform-to/zod/v4';
import type { Route } from './+types/_app.settings.organization.general';
import { requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getOrgStub } from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { OrgGeneralForm } from '@/components/settings/org-general-form';
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
  const submission = parseWithZod(formData, { schema: orgNameSchema });

  if (submission.status !== 'success') {
    return { result: submission.reply() };
  }

  const { name } = submission.value;

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const stub = getOrgStub(authEnv, authContext.currentOrg!.id);
  await stub.updateName(name.trim(), authContext.user!.id);

  return { result: submission.reply(), success: true };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  return {
    org: authContext.currentOrg,
  };
}

export default function OrganizationGeneralPage() {
  const { org } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Organization"
        description="Manage your organization settings."
      />
      <Separator />
      <OrgGeneralForm org={org} canEdit={true} />
    </div>
  );
}
