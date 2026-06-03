import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getChannelBrand, orderedChannelBrands } from "@/lib/channel-branding";
import { IntegrationIcon, hasIntegrationIcon } from "@/lib/integration-icons";
import { cn } from "@/lib/utils";

type ChannelLogoProps = {
  channel: string;
  tooltip: string;
  className?: string;
};

export function ChannelLogo({
  channel,
  tooltip,
  className,
}: ChannelLogoProps) {
  const brand = getChannelBrand(channel);
  if (!brand) return null;

  const Glyph = brand.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-md bg-muted",
            className,
          )}
          role="img"
          aria-label={tooltip}
        >
          {Glyph ? (
            <Glyph className="size-3.5" />
          ) : brand.logoType && hasIntegrationIcon(brand.logoType) ? (
            <IntegrationIcon type={brand.logoType} size={14} className="size-3.5" />
          ) : (
            <span className="text-[9px] font-medium text-muted-foreground">
              {brand.label[0]}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

type ChannelLogoStackProps = {
  channels: string[];
  tooltipFor: (label: string) => string;
};

export function ChannelLogoStack({
  channels,
  tooltipFor,
}: ChannelLogoStackProps) {
  const brands = orderedChannelBrands(channels);
  if (brands.length === 0) return null;

  return (
    <div className="flex items-center -space-x-1">
      {brands.map((brand) => (
        <ChannelLogo
          key={brand.kind}
          channel={brand.kind}
          tooltip={tooltipFor(brand.label)}
          className="ring-2 ring-background"
        />
      ))}
    </div>
  );
}
