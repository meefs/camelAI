import { CircleAlert } from "lucide-react";
import { Link } from "react-router";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CamelCodePickerAlert({
  isOrgAdmin,
  settingsHref,
  className,
}: {
  isOrgAdmin: boolean;
  settingsHref: string;
  className?: string;
}) {
  return (
    <Alert className={cn("px-3 py-2 text-sm", className)}>
      <CircleAlert className="h-4 w-4 text-muted-foreground" />
      <AlertTitle className="text-sm">Premium models are paused</AlertTitle>
      <AlertDescription className="space-y-2 text-sm text-muted-foreground">
        <p>
          {isOrgAdmin
            ? "Add camelCode to this picker to continue for free."
            : "Ask an organization admin to add camelCode to this picker."}
        </p>
        {isOrgAdmin ? (
          <Button asChild size="sm" className="h-7">
            <Link to={settingsHref}>Open model settings</Link>
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
