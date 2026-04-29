import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { ChevronDown } from "lucide-react";
import type { Route } from "./+types/_app.settings.organization.ai-provider";
import { SettingsHeader } from "@/components/settings/settings-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  requireAuthContext,
  requireOrgAdmin,
  getAuthEnv,
} from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { AWS_REGIONS, BYOK_PROVIDERS } from "@/lib/byok-providers";
import { buildPublicLlmProviderConfig } from "@/lib/llm-provider-config";
import { cn } from "@/lib/utils";
import type { LlmProvider, LlmProviderConfigPublic } from "@/types";

type ProviderChoice = "default" | LlmProvider;
type FetcherIntent = "setProvider" | "deleteProvider" | "testProvider" | null;

interface ProviderActionResponse {
  success?: boolean;
  error?: string;
  message?: string;
  key_hint?: string;
}

interface ProviderGuide {
  displayName: string;
  description: string;
  fieldLabel: string;
  placeholder: string;
  href: string;
  firstStepLinkLabel: string;
  firstStepPrefix?: string;
  firstStepSuffix?: string;
  steps: string[];
  note: string;
}

const PROVIDER_CARD_OPTIONS: Array<{
  value: ProviderChoice;
  label: string;
  description: string;
}> = [
  {
    value: "default",
    label: "camelAI billing",
    description:
      "Uses camelAI-managed provider access and deducts usage from your credit balance",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    description: "Uses your Anthropic key for Claude turns",
  },
  {
    value: "openai",
    label: "OpenAI",
    description: "Uses your OpenAI key for Codex-powered threads",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "Uses your OpenRouter key for Codex and Claude threads",
  },
  {
    value: "bedrock",
    label: "AWS Bedrock",
    description: "Uses your AWS account for Claude via Bedrock",
  },
];

const PROVIDER_GUIDES: Record<LlmProvider, ProviderGuide> = {
  anthropic: {
    displayName: "Anthropic",
    description: "Direct access to Claude models",
    fieldLabel: "Anthropic API Key",
    placeholder: "sk-ant-...",
    href: BYOK_PROVIDERS.anthropic.getKeyUrl,
    firstStepLinkLabel: "console.anthropic.com/settings/keys",
    steps: [
      'Click "Create Key".',
      'Name it anything, such as "camelAI".',
      "Copy the key and paste it above.",
    ],
    note: "You'll need to add a payment method on Anthropic's site first if you haven't already.",
  },
  openai: {
    displayName: "OpenAI",
    description: "For Codex-powered threads",
    fieldLabel: "OpenAI API Key",
    placeholder: "sk-...",
    href: BYOK_PROVIDERS.openai.getKeyUrl,
    firstStepLinkLabel: "platform.openai.com/api-keys",
    steps: [
      'Click "Create new secret key".',
      'Name it anything, such as "camelAI".',
      "Copy the key and paste it above.",
    ],
    note: "You'll need to add a payment method on OpenAI's platform first if you haven't already.",
  },
  openrouter: {
    displayName: "OpenRouter",
    description: "Codex and Claude model access through OpenRouter",
    fieldLabel: "OpenRouter API Key",
    placeholder: "sk-or-...",
    href: BYOK_PROVIDERS.openrouter.getKeyUrl,
    firstStepLinkLabel: "openrouter.ai/settings/keys",
    steps: [
      'Click "Create Key".',
      'Name it anything, such as "camelAI".',
      "Copy the key and paste it above.",
    ],
    note: "OpenRouter usage is billed through your OpenRouter account.",
  },
  bedrock: {
    displayName: "AWS Bedrock",
    description: "Claude via your AWS account",
    fieldLabel: "Bedrock API Key",
    placeholder: "Enter your AWS Bedrock API key",
    href: BYOK_PROVIDERS.bedrock.getKeyUrl,
    firstStepPrefix: "Go to your ",
    firstStepLinkLabel: "AWS Console",
    firstStepSuffix: " and open Bedrock.",
    steps: [
      "Make sure Claude models are enabled in your region.",
      "Go to Bedrock API keys and create a new key.",
      "Copy the key and paste it above.",
      "Select your AWS region below.",
    ],
    note: "AWS Bedrock usage is billed through your AWS account.",
  },
};

function ProviderSetupInstructions({
  provider,
  open,
  onOpenChange,
}: {
  provider: LlmProvider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const guide = PROVIDER_GUIDES[provider];

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="rounded-lg border bg-muted/50">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 p-3 text-left text-xs font-medium"
          >
            <span>How to get your API key</span>
            <ChevronDown
              className={cn(
                "size-4 transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
          <div className="px-3 pb-3">
            <ol className="space-y-2 text-xs text-muted-foreground">
              <li className="flex gap-2">
                <span className="w-4 shrink-0 text-foreground">1.</span>
                <span>
                  {guide.firstStepPrefix ?? "Go to "}
                  <a
                    href={guide.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-foreground underline underline-offset-4"
                  >
                    {guide.firstStepLinkLabel}
                  </a>
                  {guide.firstStepSuffix ?? ""}
                </span>
              </li>
              {guide.steps.map((step, index) => (
                <li key={step} className="flex gap-2">
                  <span className="w-4 shrink-0 text-foreground">
                    {index + 2}.
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">{guide.note}</p>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function meta() {
  return [
    { title: "AI Provider - Settings - camelAI" },
    {
      name: "description",
      content:
        "Manage whether camelAI or your own provider handles model requests",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const orgStub = authEnv.ORG.get(
    authEnv.ORG.idFromName(authContext.currentOrg.id),
  );
  const record = await orgStub.getLlmProviderConfig();

  if (!record) {
    return { config: null, orgId: authContext.currentOrg.id };
  }

  const config: LlmProviderConfigPublic = await buildPublicLlmProviderConfig(
    record,
    env.INTEGRATION_SECRET_KEY,
  );

  return { config, orgId: authContext.currentOrg.id };
}

export default function AiProviderPage() {
  const { config, orgId } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ProviderActionResponse>();

  const [selectedProvider, setSelectedProvider] = useState<ProviderChoice>(
    config?.provider ?? "default",
  );
  const [apiKey, setApiKey] = useState("");
  const [openAiApiKey, setOpenAiApiKey] = useState("");
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [awsRegion, setAwsRegion] = useState(
    config?.config?.aws_region ?? "us-east-1",
  );
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [lastIntent, setLastIntent] = useState<FetcherIntent>(null);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const fetcherData = fetcher.data;
  const isSaving = fetcher.state !== "idle";
  const configuredProvider = config?.provider ?? null;
  const selectedLlmProvider =
    selectedProvider === "default" ? null : selectedProvider;
  const selectedGuide = selectedLlmProvider
    ? PROVIDER_GUIDES[selectedLlmProvider]
    : null;

  useEffect(() => {
    setSelectedProvider(config?.provider ?? "default");
    setAwsRegion(config?.config?.aws_region ?? "us-east-1");
  }, [config?.provider, config?.config?.aws_region]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcherData) {
      return;
    }

    if (fetcherData.message) {
      setTestResult({
        success: fetcherData.success ?? false,
        message: fetcherData.message,
      });
      return;
    }

    if (fetcherData.success) {
      setApiKey("");
      setOpenAiApiKey("");
      setOpenRouterApiKey("");
      setBearerToken("");
      setTestResult(null);
    }
  }, [fetcher.state, fetcherData]);

  const saveDisabled = useMemo(() => {
    if (isSaving) {
      return true;
    }

    if (selectedProvider === "default") {
      return !config;
    }

    if (selectedProvider === "anthropic") {
      return apiKey.trim().length === 0;
    }

    if (selectedProvider === "openai") {
      return openAiApiKey.trim().length === 0;
    }

    if (selectedProvider === "openrouter") {
      return openRouterApiKey.trim().length === 0;
    }

    const missingNewBedrockKey =
      configuredProvider !== "bedrock" && bearerToken.trim().length === 0;
    const regionUnchanged =
      configuredProvider === "bedrock" &&
      awsRegion === config?.config?.aws_region;
    return (
      missingNewBedrockKey ||
      (bearerToken.trim().length === 0 && regionUnchanged)
    );
  }, [
    apiKey,
    awsRegion,
    config,
    configuredProvider,
    isSaving,
    openAiApiKey,
    openRouterApiKey,
    selectedProvider,
    bearerToken,
  ]);

  const saveSuccessVisible =
    fetcher.state === "idle" &&
    fetcherData?.success &&
    !fetcherData.message &&
    lastIntent === "setProvider";

  function clearActionFeedback() {
    setLastIntent(null);
    setTestResult(null);
  }

  function handleSave() {
    clearActionFeedback();

    if (selectedProvider === "default") {
      setLastIntent("deleteProvider");
      fetcher.submit(
        { intent: "deleteProvider" },
        {
          method: "POST",
          action: `/api/orgs/${orgId}/llm-provider`,
          encType: "application/json",
        },
      );
      return;
    }

    setLastIntent("setProvider");

    if (selectedProvider === "anthropic") {
      fetcher.submit(
        {
          intent: "setProvider",
          provider: "anthropic",
          api_key: apiKey.trim(),
        },
        {
          method: "POST",
          action: `/api/orgs/${orgId}/llm-provider`,
          encType: "application/json",
        },
      );
      return;
    }

    if (selectedProvider === "openai") {
      fetcher.submit(
        {
          intent: "setProvider",
          provider: "openai",
          api_key: openAiApiKey.trim(),
        },
        {
          method: "POST",
          action: `/api/orgs/${orgId}/llm-provider`,
          encType: "application/json",
        },
      );
      return;
    }

    if (selectedProvider === "openrouter") {
      fetcher.submit(
        {
          intent: "setProvider",
          provider: "openrouter",
          api_key: openRouterApiKey.trim(),
        },
        {
          method: "POST",
          action: `/api/orgs/${orgId}/llm-provider`,
          encType: "application/json",
        },
      );
      return;
    }

    fetcher.submit(
      {
        intent: "setProvider",
        provider: "bedrock",
        ...(bearerToken.trim() ? { bearer_token: bearerToken.trim() } : {}),
        aws_region: awsRegion,
      },
      {
        method: "POST",
        action: `/api/orgs/${orgId}/llm-provider`,
        encType: "application/json",
      },
    );
  }

  function handleTest() {
    setLastIntent("testProvider");
    setTestResult(null);
    fetcher.submit(
      { intent: "testProvider" },
      {
        method: "POST",
        action: `/api/orgs/${orgId}/llm-provider`,
        encType: "application/json",
      },
    );
  }

  function handleRemove() {
    clearActionFeedback();
    setLastIntent("deleteProvider");
    setApiKey("");
    setOpenAiApiKey("");
    setOpenRouterApiKey("");
    setBearerToken("");
    setSelectedProvider("default");
    fetcher.submit(
      { intent: "deleteProvider" },
      {
        method: "POST",
        action: `/api/orgs/${orgId}/llm-provider`,
        encType: "application/json",
      },
    );
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="AI Provider"
        description="Choose which provider credentials camelAI should use when it runs model requests."
      />
      <Separator />

      <div className="max-w-2xl space-y-6">
        {config && (
          <div className="rounded-xl border bg-muted/40 p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium">Current key</p>
                  <Badge variant="outline">
                    {PROVIDER_GUIDES[config.provider].displayName}
                  </Badge>
                </div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>
                    Key: {config.key_hint}
                    {config.config.aws_region
                      ? ` | Region: ${config.config.aws_region}`
                      : ""}
                  </p>
                  <p>
                    Updated {new Date(config.updated_at).toLocaleDateString()}
                  </p>
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={isSaving}
                >
                  {isSaving && lastIntent === "testProvider"
                    ? "Testing..."
                    : "Test"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleRemove}
                  disabled={isSaving}
                >
                  {isSaving && lastIntent === "deleteProvider"
                    ? "Removing..."
                    : "Remove"}
                </Button>
              </div>
            </div>

            {testResult && (
              <p
                className={cn(
                  "mt-3 text-xs",
                  testResult.success
                    ? "text-green-700 dark:text-green-300"
                    : "text-destructive",
                )}
              >
                {testResult.message}
              </p>
            )}
          </div>
        )}

        {saveSuccessVisible && (
          <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-3">
            <p className="text-xs text-green-700 dark:text-green-300">
              API key saved. Active chats will reconnect onto the updated
              provider credentials automatically.
            </p>
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Choose a provider</h3>
            <p className="text-xs text-muted-foreground">
              Pick the option you want camelAI to use for new chat turns. BYOK
              still requires paid access, but those turns do not consume camelAI
              credits.
            </p>
          </div>

          <RadioGroup
            value={selectedProvider}
            onValueChange={(value) => {
              clearActionFeedback();
              setSelectedProvider(value as ProviderChoice);
              setInstructionsOpen(false);
            }}
            className="space-y-3"
          >
            {PROVIDER_CARD_OPTIONS.map((option) => (
              <div key={option.value} className="flex items-start gap-3">
                <RadioGroupItem
                  value={option.value}
                  id={`provider-${option.value}`}
                  className="mt-0.5"
                />
                <Label
                  htmlFor={`provider-${option.value}`}
                  className="cursor-pointer space-y-0.5"
                >
                  <span className="font-medium">{option.label}</span>
                  <p className="text-xs text-muted-foreground">
                    {option.description}
                  </p>
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>

        {selectedLlmProvider && selectedGuide ? (
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor={`${selectedProvider}-key`}>
                {selectedGuide.fieldLabel}
              </Label>
              <Input
                id={`${selectedProvider}-key`}
                type="password"
                placeholder={
                  configuredProvider === selectedProvider
                    ? config?.key_hint
                    : selectedGuide.placeholder
                }
                value={
                  selectedProvider === "anthropic"
                    ? apiKey
                    : selectedProvider === "openai"
                      ? openAiApiKey
                      : selectedProvider === "openrouter"
                        ? openRouterApiKey
                        : bearerToken
                }
                onChange={(event) => {
                  clearActionFeedback();
                  const nextValue = event.target.value;
                  if (selectedProvider === "anthropic") {
                    setApiKey(nextValue);
                    return;
                  }
                  if (selectedProvider === "openai") {
                    setOpenAiApiKey(nextValue);
                    return;
                  }
                  if (selectedProvider === "openrouter") {
                    setOpenRouterApiKey(nextValue);
                    return;
                  }
                  setBearerToken(nextValue);
                }}
              />
            </div>

            <ProviderSetupInstructions
              provider={selectedLlmProvider}
              open={instructionsOpen}
              onOpenChange={setInstructionsOpen}
            />

            {selectedProvider === "bedrock" && (
              <div className="space-y-2">
                <Label htmlFor="aws-region">AWS Region</Label>
                <Select
                  value={awsRegion}
                  onValueChange={(value) => {
                    clearActionFeedback();
                    setAwsRegion(value);
                  }}
                >
                  <SelectTrigger id="aws-region">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AWS_REGIONS.map((region) => (
                      <SelectItem key={region.value} value={region.value}>
                        {region.label} ({region.value})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Model selection is configured per thread in the chat UI.
        </p>

        {fetcherData?.error && (
          <p className="text-xs text-destructive">{fetcherData.error}</p>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saveDisabled}>
            {isSaving && lastIntent === "setProvider"
              ? "Saving..."
              : selectedProvider === "default"
                ? "Use camelAI billing"
                : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
