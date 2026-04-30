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

interface RemoveKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerLabel: string;
  onConfirm: () => void;
  isRemoving: boolean;
  title?: string;
  description?: string;
  confirmLabel?: string;
  removingLabel?: string;
}

export function RemoveKeyDialog({
  open,
  onOpenChange,
  providerLabel,
  onConfirm,
  isRemoving,
  title,
  description,
  confirmLabel,
  removingLabel,
}: RemoveKeyDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {title ?? `Remove your ${providerLabel} key?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {description ??
              "Your org will switch back to camelAI hosted credits, which may incur charges."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            disabled={isRemoving}
          >
            {isRemoving
              ? (removingLabel ?? "Removing…")
              : (confirmLabel ?? "Remove key")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
