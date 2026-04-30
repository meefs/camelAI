import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ByokKeyForm } from "@/components/byok/byok-key-form";
import { type OnboardingByokProvider } from "@/lib/byok-providers";

interface ByokKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedProvider: OnboardingByokProvider;
  onProviderChange: (provider: OnboardingByokProvider) => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  awsRegion: string;
  onAwsRegionChange: (region: string) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  errorMessage?: string | null;
}

export function ByokKeyDialog({
  open,
  onOpenChange,
  selectedProvider,
  onProviderChange,
  apiKey,
  onApiKeyChange,
  awsRegion,
  onAwsRegionChange,
  onSubmit,
  isSubmitting,
  errorMessage,
}: ByokKeyDialogProps) {
  const submitDisabled = isSubmitting || apiKey.trim().length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add your API key</DialogTitle>
          <DialogDescription className="text-sm">
            Your provider bills you directly.
          </DialogDescription>
        </DialogHeader>

        <ByokKeyForm
          selectedProvider={selectedProvider}
          onProviderChange={onProviderChange}
          apiKey={apiKey}
          onApiKeyChange={onApiKeyChange}
          awsRegion={awsRegion}
          onAwsRegionChange={onAwsRegionChange}
          onSubmit={onSubmit}
          isSubmitting={isSubmitting}
          errorMessage={errorMessage}
          submitLabel="Continue"
          submittingLabel="Saving..."
          submitDisabled={submitDisabled}
          footer={
            <>
              <Separator />
              <DialogFooter>
                <Button type="submit" disabled={submitDisabled}>
                  {isSubmitting ? "Saving..." : "Continue"}
                </Button>
              </DialogFooter>
            </>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
