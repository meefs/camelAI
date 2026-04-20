import type { AppLoadContext } from 'react-router';
import { requireAuthContext, requireOrgAdmin } from '@/lib/auth.server';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function meta() {
  return [
    { title: 'Organization Experimental - Settings - camelAI' },
    { name: 'description', content: 'Manage organization experimental features' },
  ];
}

export async function loader({ request, context }: { request: Request; context: AppLoadContext }) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);

  return null;
}

export default function OrganizationExperimentalPage() {
  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Experimental"
        description="Enable early access features for your organization."
      />
      <Separator />

      <div className="max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>Chat Models</CardTitle>
            <CardDescription>
              Codex and GPT models are now available without an experimental flag.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Claude on the camelAI proxy is limited to organizations with special access.
              Anthropic and AWS Bedrock keys still enable Claude models through AI Provider settings.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
