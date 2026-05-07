import type { LlmModel } from "@/types";
import { IntegrationIcon } from "@/lib/integration-icons";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import { cn } from "@/lib/utils";

export function ModelLogo({
  model,
  size = 16,
  className,
}: {
  model: LlmModel;
  size?: number;
  className?: string;
}) {
  const entry = MODEL_CATALOG[model];
  return (
    <IntegrationIcon
      type={entry.providerLogo}
      size={size}
      className={cn("shrink-0", className)}
    />
  );
}
