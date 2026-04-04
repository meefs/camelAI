import { useState, useEffect } from 'react';
import { useLoaderData, useFetcher } from 'react-router';
import type { Route } from './+types/_app.settings.organization.ai-provider';
import { requireAuthContext, requireOrgAdmin, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { buildPublicLlmProviderConfig } from '@/lib/llm-provider-config';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { LlmProvider, LlmProviderConfigPublic } from '@/types';

const AWS_REGIONS = [
  { value: 'us-east-1', label: 'US East (N. Virginia)' },
  { value: 'us-east-2', label: 'US East (Ohio)' },
  { value: 'us-west-2', label: 'US West (Oregon)' },
  { value: 'eu-west-1', label: 'EU (Ireland)' },
  { value: 'eu-west-2', label: 'EU (London)' },
  { value: 'eu-west-3', label: 'EU (Paris)' },
  { value: 'eu-central-1', label: 'EU (Frankfurt)' },
  { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
  { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
  { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
  { value: 'ap-south-1', label: 'Asia Pacific (Mumbai)' },
  { value: 'sa-east-1', label: 'South America (Sao Paulo)' },
  { value: 'ca-central-1', label: 'Canada (Central)' },
];

export function meta() {
  return [
    { title: 'AI Provider - Settings - camelAI' },
    { name: 'description', content: 'Configure your AI provider API keys' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(authContext.currentOrg.id));
  const record = await orgStub.getLlmProviderConfig();

  if (!record) {
    return { config: null, orgId: authContext.currentOrg.id };
  }

  const config: LlmProviderConfigPublic = await buildPublicLlmProviderConfig(
    record,
    env.INTEGRATION_SECRET_KEY
  );

  return { config, orgId: authContext.currentOrg.id };
}

export default function AiProviderPage() {
  const { config, orgId } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const [selectedProvider, setSelectedProvider] = useState<'default' | LlmProvider>(
    config?.provider ?? 'default'
  );
  const [apiKey, setApiKey] = useState('');
  const [openAiApiKey, setOpenAiApiKey] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [awsRegion, setAwsRegion] = useState(config?.config?.aws_region ?? 'us-east-1');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const isSaving = fetcher.state !== 'idle';
  const fetcherData = fetcher.data as
    | { success?: boolean; error?: string; message?: string; key_hint?: string }
    | undefined;

  useEffect(() => {
    if (fetcherData && fetcher.state === 'idle') {
      if (fetcherData.success && !fetcherData.message) {
        // Save succeeded, clear form
        setApiKey('');
        setOpenAiApiKey('');
        setBearerToken('');
        setTestResult(null);
      }
      if (fetcherData.message) {
        setTestResult({ success: fetcherData.success ?? false, message: fetcherData.message });
      }
    }
  }, [fetcherData, fetcher.state]);

  function handleSave() {
    setTestResult(null);
    if (selectedProvider === 'default') {
      fetcher.submit(
        { intent: 'deleteProvider' },
        { method: 'POST', action: `/api/orgs/${orgId}/llm-provider`, encType: 'application/json' }
      );
      return;
    }

    if (selectedProvider === 'anthropic') {
      if (!apiKey && config?.provider === 'anthropic') {
        // No change if key isn't re-entered and already configured
        return;
      }
      fetcher.submit(
        { intent: 'setProvider', provider: 'anthropic', api_key: apiKey },
        { method: 'POST', action: `/api/orgs/${orgId}/llm-provider`, encType: 'application/json' }
      );
      return;
    }

    if (selectedProvider === 'openai') {
      if (!openAiApiKey && config?.provider === 'openai') {
        return;
      }
      fetcher.submit(
        { intent: 'setProvider', provider: 'openai', api_key: openAiApiKey },
        { method: 'POST', action: `/api/orgs/${orgId}/llm-provider`, encType: 'application/json' }
      );
      return;
    }

    if (selectedProvider === 'bedrock') {
      if (
        !bearerToken &&
        config?.provider === 'bedrock' &&
        awsRegion === config.config.aws_region
      ) {
        // Nothing changed
        return;
      }
      fetcher.submit(
        {
          intent: 'setProvider',
          provider: 'bedrock',
          ...(bearerToken ? { bearer_token: bearerToken } : {}),
          aws_region: awsRegion,
        },
        { method: 'POST', action: `/api/orgs/${orgId}/llm-provider`, encType: 'application/json' }
      );
      return;
    }
  }

  function handleTest() {
    setTestResult(null);
    fetcher.submit(
      { intent: 'testProvider' },
      { method: 'POST', action: `/api/orgs/${orgId}/llm-provider`, encType: 'application/json' }
    );
  }

  function handleRemove() {
    setTestResult(null);
    setApiKey('');
    setOpenAiApiKey('');
    setBearerToken('');
    setSelectedProvider('default');
    fetcher.submit(
      { intent: 'deleteProvider' },
      { method: 'POST', action: `/api/orgs/${orgId}/llm-provider`, encType: 'application/json' }
    );
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="AI Provider"
        description="Configure your own provider key for Claude or Codex. Keys are encrypted at rest and used through the sandbox proxy."
      />
      <Separator />

      <div className="space-y-6 max-w-lg">
        {config && (
          <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">
                  Current provider:{' '}
                  <span className="font-semibold capitalize">{config.provider}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Key: {config.key_hint}
                  {config.config.aws_region && ` | Region: ${config.config.aws_region}`}
                </p>
                <p className="text-xs text-muted-foreground">
                  Updated {new Date(config.updated_at).toLocaleDateString()}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleTest} disabled={isSaving}>
                  {isSaving && fetcherData === undefined ? 'Testing...' : 'Test'}
                </Button>
                <Button variant="destructive" size="sm" onClick={handleRemove} disabled={isSaving}>
                  Remove
                </Button>
              </div>
            </div>
            {testResult && (
              <p
                className={`text-xs ${testResult.success ? 'text-green-600' : 'text-destructive'}`}
              >
                {testResult.message}
              </p>
            )}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <Label className="text-sm font-medium">Provider</Label>
            <p className="text-xs text-muted-foreground mb-3">
              Choose which AI provider to use for chat. "Default" uses the built-in proxy.
            </p>
            <RadioGroup
              value={selectedProvider}
              onValueChange={(v) => {
                setSelectedProvider(v as 'default' | LlmProvider);
                setTestResult(null);
              }}
              className="space-y-2"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="default" id="default" />
                <Label htmlFor="default" className="font-normal cursor-pointer">
                  Default (camelAI proxy)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="anthropic" id="anthropic" />
                <Label htmlFor="anthropic" className="font-normal cursor-pointer">
                  Anthropic (direct API)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="openai" id="openai" />
                <Label htmlFor="openai" className="font-normal cursor-pointer">
                  OpenAI / Codex (direct API)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="bedrock" id="bedrock" />
                <Label htmlFor="bedrock" className="font-normal cursor-pointer">
                  AWS Bedrock (API key)
                </Label>
              </div>
            </RadioGroup>
          </div>

          {selectedProvider === 'anthropic' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="anthropic-key">Anthropic API Key</Label>
                <Input
                  id="anthropic-key"
                  type="password"
                  placeholder={config?.provider === 'anthropic' ? config.key_hint : 'sk-ant-...'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Get your API key from{' '}
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    console.anthropic.com
                  </a>
                </p>
              </div>
            </div>
          )}

          {selectedProvider === 'openai' && (
            <div className="space-y-2">
              <Label htmlFor="openai-key">OpenAI API Key</Label>
              <Input
                id="openai-key"
                type="password"
                placeholder={config?.provider === 'openai' ? config.key_hint : 'sk-...'}
                value={openAiApiKey}
                onChange={(e) => setOpenAiApiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Codex chats use this key through the same sandbox proxy path as Claude.
              </p>
            </div>
          )}

          {selectedProvider === 'bedrock' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="bedrock-key">Bedrock API Key</Label>
                <Input
                  id="bedrock-key"
                  type="password"
                  placeholder={
                    config?.provider === 'bedrock' ? config.key_hint : 'Enter your Bedrock API key'
                  }
                  value={bearerToken}
                  onChange={(e) => setBearerToken(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Create a Bedrock API key in your{' '}
                  <a
                    href="https://console.aws.amazon.com/bedrock/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    AWS Bedrock console
                  </a>
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="aws-region">AWS Region</Label>
                <Select value={awsRegion} onValueChange={setAwsRegion}>
                  <SelectTrigger id="aws-region">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AWS_REGIONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label} ({r.value})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Claude model selection is configured per thread in the web chat UI.
          </p>

          {fetcherData?.error && (
            <p className="text-sm text-destructive">{fetcherData.error}</p>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleSave}
              disabled={
                isSaving ||
                (selectedProvider === 'anthropic' && !apiKey && config?.provider !== 'anthropic') ||
                (selectedProvider === 'openai' &&
                  !openAiApiKey &&
                  config?.provider !== 'openai') ||
                (selectedProvider === 'bedrock' &&
                  !bearerToken &&
                  config?.provider !== 'bedrock')
              }
            >
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
