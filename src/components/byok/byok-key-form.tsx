import { ExternalLink, Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  AWS_REGIONS,
  BYOK_PROVIDER_ORDER,
  BYOK_PROVIDERS,
  type OnboardingByokProvider,
} from "@/lib/byok-providers";

interface ByokKeyFormProps {
  selectedProvider: OnboardingByokProvider;
  onProviderChange: (provider: OnboardingByokProvider) => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  awsRegion: string;
  onAwsRegionChange: (region: string) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  errorMessage?: string | null;
  submitLabel: string;
  submittingLabel?: string;
  apiKeyPlaceholderOverride?: string | null;
  submitDisabled?: boolean;
  autoFocusApiKey?: boolean;
  footer?: React.ReactNode;
  className?: string;
}

export function ByokKeyForm({
  selectedProvider,
  onProviderChange,
  apiKey,
  onApiKeyChange,
  awsRegion,
  onAwsRegionChange,
  onSubmit,
  isSubmitting,
  errorMessage,
  submitLabel,
  submittingLabel,
  apiKeyPlaceholderOverride,
  submitDisabled,
  autoFocusApiKey = true,
  footer,
  className,
}: ByokKeyFormProps) {
  const provider = BYOK_PROVIDERS[selectedProvider];
  const disabled =
    submitDisabled !== undefined
      ? submitDisabled || isSubmitting
      : isSubmitting || apiKey.trim().length === 0;

  return (
    <form
      className={cn("space-y-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      <div className="space-y-2">
        <Label className="text-sm">Provider</Label>
        <ToggleGroup
          type="single"
          value={selectedProvider}
          onValueChange={(value) => {
            if (value) {
              onProviderChange(value as OnboardingByokProvider);
            }
          }}
          variant="outline"
          size="lg"
          className="!grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          {BYOK_PROVIDER_ORDER.map((key) => (
            <ToggleGroupItem
              key={key}
              value={key}
              className="px-3 text-sm font-medium data-[state=on]:ring-2 data-[state=on]:ring-primary"
            >
              {BYOK_PROVIDERS[key].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="byok-api-key" className="text-sm">
            {provider.fieldLabel}
          </Label>
          <a
            href={provider.getKeyUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-sm text-primary hover:underline"
          >
            Get a key
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </div>
        <Input
          id="byok-api-key"
          type="password"
          autoComplete="off"
          autoFocus={autoFocusApiKey}
          value={apiKey}
          placeholder={apiKeyPlaceholderOverride ?? provider.placeholder}
          aria-invalid={errorMessage ? true : undefined}
          onChange={(event) => onApiKeyChange(event.target.value)}
          className="font-mono text-sm"
        />

        {provider.requiresRegion ? (
          <div className="space-y-2 pt-2">
            <Label htmlFor="byok-aws-region" className="text-sm">
              AWS Region
            </Label>
            <Select value={awsRegion} onValueChange={onAwsRegionChange}>
              <SelectTrigger id="byok-aws-region" className="w-full">
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
        ) : null}

        <p className="inline-flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{provider.modelCoverage}</span>
        </p>
      </div>

      {errorMessage ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {footer ?? (
        <div className="flex justify-end">
          <Button type="submit" disabled={disabled}>
            {isSubmitting ? (submittingLabel ?? "Saving…") : submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}
