"use client";

import { useId, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";

export const CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY =
  "camelai:close-chat-group-confirmation-suppressed:v1";

export function readCloseGroupConfirmationSuppressed() {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(
        CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      ) === "true"
    );
  } catch {
    return false;
  }
}

export function writeCloseGroupConfirmationSuppressed() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      "true",
    );
  } catch {
    // Closing should still succeed if the browser rejects local storage writes.
  }
}

export function CloseChatGroupDialog({
  open,
  onOpenChange,
  groupName,
  chatCount,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  chatCount: number;
  onConfirm: () => void;
}) {
  const suppressionCheckboxId = useId();
  const [rememberSuppression, setRememberSuppression] = useState(false);
  const chatNoun = chatCount === 1 ? "chat" : "chats";

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setRememberSuppression(false);
    }
    onOpenChange(nextOpen);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close "{groupName}"?</AlertDialogTitle>
          <AlertDialogDescription>
            Its {chatCount} {chatNoun} will be removed from this group. You can
            reopen any of them from Chat History.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-center gap-2 pt-1">
          <Checkbox
            id={suppressionCheckboxId}
            checked={rememberSuppression}
            onCheckedChange={(checked) =>
              setRememberSuppression(checked === true)
            }
          />
          <label
            htmlFor={suppressionCheckboxId}
            className="text-sm leading-none text-muted-foreground"
          >
            Do not show again
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (rememberSuppression) {
                writeCloseGroupConfirmationSuppressed();
              }
              onConfirm();
              handleOpenChange(false);
            }}
          >
            Close group
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
