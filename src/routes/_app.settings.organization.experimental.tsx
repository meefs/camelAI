import { useEffect, useState } from 'react';
import type { AppLoadContext } from 'react-router';
import { useFetcher, useLoaderData } from 'react-router';
import { toast } from 'sonner';
import { requireAuthContext, requireOrgAdmin, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';

export function meta() {
  return [
    { title: 'Organization Experimental - Settings - camelAI' },
    { name: 'description', content: 'Manage organization experimental features' },
  ];
}

export async function loader({ request, context }: { request: Request; context: AppLoadContext }) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(authContext.currentOrg.id));

  return {
    orgId: authContext.currentOrg.id,
    experimentalSettings: await orgStub.getExperimentalSettings(),
  };
}

export async function action({ request, context }: { request: Request; context: AppLoadContext }) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);

  const formData = await request.formData();
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(authContext.currentOrg.id));

  const codexGptModels = formData.get('codex_gpt_models') === 'true';
  const experimentalSettings = await orgStub.setExperimentalSettings({
    codex_gpt_models: codexGptModels,
  });

  return {
    success: true,
    experimentalSettings,
  };
}

export default function OrganizationExperimentalPage() {
  const { experimentalSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [codexGptModels, setCodexGptModels] = useState(experimentalSettings.codex_gpt_models);

  useEffect(() => {
    setCodexGptModels(experimentalSettings.codex_gpt_models);
  }, [experimentalSettings.codex_gpt_models]);

  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success) {
      toast.success('Experimental settings updated');
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Experimental"
        description="Enable early access features for your organization."
      />
      <Separator />

      <fetcher.Form method="post" className="max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>Chat Models</CardTitle>
            <CardDescription>
              Turn on experimental GPT models in Camel chat for this organization.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-1">
                <Label htmlFor="codex-gpt-models" className="text-sm font-medium">
                  Enable GPT-5.4 and GPT-5.4 Mini
                </Label>
                <p className="text-sm text-muted-foreground">
                  Shows GPT model options in chat creation and model pickers for OpenAI-backed chats.
                </p>
              </div>
              <Switch
                id="codex-gpt-models"
                checked={codexGptModels}
                onCheckedChange={setCodexGptModels}
              />
            </div>

            <input
              type="hidden"
              name="codex_gpt_models"
              value={codexGptModels ? 'true' : 'false'}
            />

            <div className="flex justify-end">
              <Button type="submit" disabled={fetcher.state !== 'idle'}>
                {fetcher.state === 'idle' ? 'Save Changes' : 'Saving...'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </fetcher.Form>
    </div>
  );
}
