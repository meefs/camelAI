import { ArrowRight } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { ByokProviderMeta } from "@/lib/byok-providers";

interface ByokProviderInfoCardProps {
  provider: ByokProviderMeta;
}

export function ByokProviderInfoCard({ provider }: ByokProviderInfoCardProps) {
  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4 text-sm">
      <p className="text-foreground">{provider.description}</p>

      {provider.steps ? (
        <ol className="ml-5 list-decimal space-y-1.5 marker:font-medium marker:text-muted-foreground">
          {provider.steps.map((step) => (
            <li key={step} className="pl-2 text-foreground">
              {step}
            </li>
          ))}
        </ol>
      ) : provider.enterpriseNote ? (
        <p className="text-muted-foreground">{provider.enterpriseNote}</p>
      ) : null}

      {provider.getKeyUrl && provider.getKeyLinkLabel ? (
        <a
          href={provider.getKeyUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          {provider.getKeyLinkLabel}
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </a>
      ) : null}

      <Separator />

      <div className="space-y-1">
        <p className="font-medium text-foreground">{provider.warning.title}</p>
        <p className="text-muted-foreground">{provider.warning.body}</p>
      </div>
    </div>
  );
}
