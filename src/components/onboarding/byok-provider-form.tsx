import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { LlmProvider } from "@/types";

export type OnboardingByokProvider = Extract<
  LlmProvider,
  "anthropic" | "openai" | "openrouter"
>;

interface ProviderOption {
  value: OnboardingByokProvider;
  label: string;
  placeholder: string;
  helper: string;
}

export const BYOK_PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: "openrouter",
    label: "OpenRouter",
    placeholder: "sk-or-...",
    helper: "Codex and Claude models billed through OpenRouter.",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    placeholder: "sk-ant-...",
    helper: "Claude models billed through your Anthropic account.",
  },
  {
    value: "openai",
    label: "OpenAI",
    placeholder: "sk-...",
    helper: "Codex models billed through your OpenAI account.",
  },
];

export interface ByokProviderFormProps {
  selectedProvider: OnboardingByokProvider;
  onProviderChange: (provider: OnboardingByokProvider) => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  isSubmitting: boolean;
  submitLabel: string;
}

export function ByokProviderForm({
  selectedProvider,
  onProviderChange,
  apiKey,
  onApiKeyChange,
  onSubmit,
  disabled = false,
  isSubmitting,
  submitLabel,
}: ByokProviderFormProps) {
  const selectedOption =
    BYOK_PROVIDER_OPTIONS.find((option) => option.value === selectedProvider) ??
    BYOK_PROVIDER_OPTIONS[0];

  return (
    <div className="space-y-4 rounded-lg border p-4 text-left">
      <div className="space-y-1">
        <p className="font-medium">Use your own provider</p>
        <p className="text-sm text-muted-foreground">
          Continue without camelAI-hosted credits. Your provider bills you
          directly.
        </p>
      </div>
      <RadioGroup
        value={selectedProvider}
        onValueChange={(value) =>
          onProviderChange(value as OnboardingByokProvider)
        }
        className="grid gap-2 sm:grid-cols-3"
      >
        {BYOK_PROVIDER_OPTIONS.map((option) => (
          <Label
            key={option.value}
            htmlFor={`provider-${option.value}`}
            className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm"
          >
            <RadioGroupItem
              id={`provider-${option.value}`}
              value={option.value}
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium">{option.label}</span>
              <span className="block text-muted-foreground">
                {option.helper}
              </span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      <div className="space-y-2">
        <Label htmlFor="provider-api-key">{selectedOption.label} API key</Label>
        <Input
          id="provider-api-key"
          type="password"
          value={apiKey}
          placeholder={selectedOption.placeholder}
          autoComplete="off"
          onChange={(event) => onApiKeyChange(event.target.value)}
        />
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={onSubmit}
      >
        {isSubmitting ? "Saving..." : submitLabel}
      </Button>
    </div>
  );
}
