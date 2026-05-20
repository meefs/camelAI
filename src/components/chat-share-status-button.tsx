import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { ChevronDown, Globe, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { buildSetAppPublicPayload } from "@/lib/app-visibility";
import { cn } from "@/lib/utils";

interface ShareStatusButtonProps {
  threadId?: string;
  scriptName: string;
  isPublic: boolean;
  isAdmin: boolean;
  disabled?: boolean;
  onStatusChange?: (isPublic: boolean) => void;
}

export function ShareStatusButton({
  threadId,
  scriptName,
  isPublic,
  isAdmin,
  disabled,
  onStatusChange,
}: ShareStatusButtonProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const pendingValueRef = useRef<boolean | null>(null);
  const isPending = fetcher.state !== "idle";
  const optimisticIsPublic =
    isPending && fetcher.formData
      ? fetcher.formData.get("isPublic") === "true"
      : fetcher.data?.success && pendingValueRef.current !== null
        ? pendingValueRef.current
        : isPublic;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    if (fetcher.data.success && pendingValueRef.current !== null) {
      onStatusChange?.(pendingValueRef.current);
    } else if (fetcher.data.error) {
      toast.error(fetcher.data.error);
    }

    pendingValueRef.current = null;
  }, [fetcher.state, fetcher.data, onStatusChange]);

  useEffect(() => {
    pendingValueRef.current = null;
  }, [scriptName, threadId]);

  const handleChange = (value: string) => {
    if (!isAdmin || disabled || isPending) return;
    if (!scriptName) return;

    const nextIsPublic = value === "true";
    if (nextIsPublic === isPublic) return;

    pendingValueRef.current = nextIsPublic;
    fetcher.submit(
      buildSetAppPublicPayload({
        scriptName,
        isPublic: nextIsPublic,
        threadId,
      }),
      { method: "POST", action: "/apps" },
    );
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || isPending}
              className={cn(
                "h-6 gap-1.5 rounded-md border px-2 text-xs font-medium",
                optimisticIsPublic
                  ? "border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 dark:border-primary/30 dark:bg-primary/10 dark:text-primary dark:hover:bg-primary/20"
                  : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              {optimisticIsPublic ? (
                <Globe className="h-3.5 w-3.5" />
              ) : (
                <Lock className="h-3.5 w-3.5" />
              )}
              {optimisticIsPublic ? "Public" : "Private"}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Update visibility</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Visibility</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={optimisticIsPublic ? "true" : "false"}
          onValueChange={handleChange}
        >
          <DropdownMenuRadioItem
            value="false"
            disabled={!isAdmin || disabled || isPending}
            className="items-start"
          >
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Private</span>
              <span className="text-muted-foreground text-[10px]">
                Only workspace members can view
              </span>
            </div>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="true"
            disabled={!isAdmin || disabled || isPending}
            className="items-start"
          >
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Public</span>
              <span className="text-muted-foreground text-[10px]">
                Anyone with the link can view
              </span>
            </div>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
