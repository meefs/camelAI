import type { LlmProvider } from "@/types";

export type OnboardingByokProvider = Extract<
  LlmProvider,
  "anthropic" | "bedrock" | "openai" | "openrouter"
>;

export interface ByokProviderMeta {
  value: OnboardingByokProvider;
  label: string;
  fieldLabel: string;
  placeholder: string;
  modelCoverage: string;
  getKeyUrl: string;
  requiresRegion: boolean;
}

export const BYOK_PROVIDERS: Record<OnboardingByokProvider, ByokProviderMeta> =
  {
    openrouter: {
      value: "openrouter",
      label: "OpenRouter",
      fieldLabel: "OpenRouter API key",
      placeholder: "sk-or-...",
      modelCoverage:
        "Any model - Claude, GPT, Gemini, and more via OpenRouter.",
      getKeyUrl: "https://openrouter.ai/settings/keys",
      requiresRegion: false,
    },
    anthropic: {
      value: "anthropic",
      label: "Anthropic",
      fieldLabel: "Anthropic API key",
      placeholder: "sk-ant-...",
      modelCoverage: "Claude models only.",
      getKeyUrl: "https://console.anthropic.com/settings/keys",
      requiresRegion: false,
    },
    openai: {
      value: "openai",
      label: "OpenAI",
      fieldLabel: "OpenAI API key",
      placeholder: "sk-...",
      modelCoverage: "GPT and Codex models only.",
      getKeyUrl: "https://platform.openai.com/api-keys",
      requiresRegion: false,
    },
    bedrock: {
      value: "bedrock",
      label: "Bedrock",
      fieldLabel: "Bedrock API key",
      placeholder: "Enter your AWS Bedrock API key",
      modelCoverage: "Claude models only, served from your AWS account.",
      getKeyUrl: "https://console.aws.amazon.com/bedrock/",
      requiresRegion: true,
    },
  };

export const BYOK_PROVIDER_ORDER: OnboardingByokProvider[] = [
  "openrouter",
  "anthropic",
  "openai",
  "bedrock",
];

export const AWS_REGIONS = [
  { value: "us-east-1", label: "US East (N. Virginia)" },
  { value: "us-east-2", label: "US East (Ohio)" },
  { value: "us-west-2", label: "US West (Oregon)" },
  { value: "eu-west-1", label: "EU (Ireland)" },
  { value: "eu-west-2", label: "EU (London)" },
  { value: "eu-west-3", label: "EU (Paris)" },
  { value: "eu-central-1", label: "EU (Frankfurt)" },
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
  { value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
  { value: "ap-south-1", label: "Asia Pacific (Mumbai)" },
  { value: "sa-east-1", label: "South America (Sao Paulo)" },
  { value: "ca-central-1", label: "Canada (Central)" },
] as const;
