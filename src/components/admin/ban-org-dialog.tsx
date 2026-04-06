"use client";

import { useEffect, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { toast } from "sonner";
import { ShieldBan } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface BanOrgDialogProps {
  orgId: string;
  orgName: string;
  memberCount: number;
  workspaceCount: number;
  disabled?: boolean;
}

interface BanOrgActionResult {
  success?: boolean;
  error?: string;
  banStarted?: boolean;
  jobId?: string;
}

export function BanOrgDialog({
  orgId,
  orgName,
  memberCount,
  workspaceCount,
  disabled = false,
}: BanOrgDialogProps) {
  const navigate = useNavigate();
  const fetcher = useFetcher<BanOrgActionResult>();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const loading = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        toast.success("Organization banned and purge started");
        setOpen(false);
        setConfirmText("");
        setReason("");
        setError(null);
        navigate("/qaml-backdoor/orgs");
      } else if (fetcher.data.error) {
        setError(fetcher.data.error);
      }
    }
  }, [fetcher.state, fetcher.data, navigate]);

  const handleBan = () => {
    setError(null);
    fetcher.submit({ intent: "banOrg", orgId, reason }, { method: "POST" });
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="destructive"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <ShieldBan className="mr-2 h-4 w-4" />
        Ban Org + Purge Data
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Ban Organization and Purge Data</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently block the organization, destroy workspace
            containers, and purge apps, files, sessions, and related data.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Alert variant="destructive">
          <AlertDescription>
            This action is irreversible. The ban survives org deletion.
          </AlertDescription>
        </Alert>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            About to purge {memberCount}{" "}
            {memberCount === 1 ? "member" : "members"} and {workspaceCount}{" "}
            {workspaceCount === 1 ? "workspace" : "workspaces"}.
          </p>
          <Label htmlFor="ban-org-reason">Reason</Label>
          <Textarea
            id="ban-org-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Spam / fraud / abuse details"
            rows={4}
          />
          <Label htmlFor="ban-org-confirm">
            Type &quot;{orgName}&quot; to confirm
          </Label>
          <Input
            id="ban-org-confirm"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <Button
            onClick={handleBan}
            disabled={loading || !reason.trim() || confirmText !== orgName}
            variant="destructive"
          >
            {loading ? "Starting..." : "Ban and Purge"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
