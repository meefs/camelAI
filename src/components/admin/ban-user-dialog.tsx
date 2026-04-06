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

interface BanUserDialogProps {
  userId: string;
  userEmail: string;
  orgCount: number;
  disabled?: boolean;
}

interface BanUserActionResult {
  success?: boolean;
  error?: string;
  banStarted?: boolean;
  jobId?: string;
}

export function BanUserDialog({
  userId,
  userEmail,
  orgCount,
  disabled = false,
}: BanUserDialogProps) {
  const navigate = useNavigate();
  const fetcher = useFetcher<BanUserActionResult>();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const loading = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        toast.success("User banned and purge started");
        setOpen(false);
        setConfirmText("");
        setReason("");
        setError(null);
        navigate("/qaml-backdoor/users");
      } else if (fetcher.data.error) {
        setError(fetcher.data.error);
      }
    }
  }, [fetcher.state, fetcher.data, navigate]);

  const handleBan = () => {
    setError(null);
    fetcher.submit({ intent: "banUser", userId, reason }, { method: "POST" });
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
        Ban User + Purge Data
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Ban User and Purge Data</AlertDialogTitle>
          <AlertDialogDescription>
            This will block the user from camelAI going forward, invalidate
            their sessions, and permanently delete their account data. Any orgs
            they own will also be banned and purged.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Alert variant="destructive">
          <AlertDescription>
            This action is irreversible. The ban survives account deletion.
          </AlertDescription>
        </Alert>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-2">
          {orgCount > 0 ? (
            <p className="text-sm text-muted-foreground">
              This user currently belongs to {orgCount}{" "}
              {orgCount === 1 ? "organization" : "organizations"}.
            </p>
          ) : null}
          <Label htmlFor="ban-user-reason">Reason</Label>
          <Textarea
            id="ban-user-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Spam / fraud / abuse details"
            rows={4}
          />
          <Label htmlFor="ban-user-confirm">
            Type &quot;{userEmail}&quot; to confirm
          </Label>
          <Input
            id="ban-user-confirm"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <Button
            onClick={handleBan}
            disabled={loading || !reason.trim() || confirmText !== userEmail}
            variant="destructive"
          >
            {loading ? "Starting..." : "Ban and Purge"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
