import { useState } from 'react';
import { Loader2, Bug, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export type BugReportStatus = 'idle' | 'capturing' | 'uploading' | 'sending' | 'done' | 'error';

interface BugReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (report: { expected: string; actual: string }) => void;
  status: BugReportStatus;
  error?: string | null;
  appName?: string;
}

const statusMessages: Record<BugReportStatus, string> = {
  idle: '',
  capturing: 'Capturing page state...',
  uploading: 'Uploading debug data...',
  sending: 'Sending to agent...',
  done: 'Bug report submitted!',
  error: 'Failed to submit bug report',
};

export function BugReportDialog({
  open,
  onOpenChange,
  onSubmit,
  status,
  error,
  appName,
}: BugReportDialogProps) {
  const [expected, setExpected] = useState('');
  const [actual, setActual] = useState('');

  const isLoading = status === 'capturing' || status === 'uploading' || status === 'sending';
  const canSubmit = expected.trim() && actual.trim() && !isLoading;

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit({ expected: expected.trim(), actual: actual.trim() });
  }

  function handleOpenChange(nextOpen: boolean) {
    if (isLoading) return; // Prevent closing while loading
    if (!nextOpen) {
      // Reset form when closing
      setExpected('');
      setActual('');
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="h-5 w-5" />
            Report a Bug
          </DialogTitle>
          <DialogDescription>
            {appName ? (
              <>Describe the issue with <span className="font-medium">{appName}</span>. The agent will investigate and fix it.</>
            ) : (
              <>Describe the issue you encountered. The agent will investigate and fix it.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="expected">What did you expect to happen?</Label>
            <Textarea
              id="expected"
              placeholder="I expected the button to..."
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              disabled={isLoading}
              className="min-h-[80px] resize-none"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="actual">What actually happened?</Label>
            <Textarea
              id="actual"
              placeholder="Instead, when I clicked it..."
              value={actual}
              onChange={(e) => setActual(e.target.value)}
              disabled={isLoading}
              className="min-h-[80px] resize-none"
            />
          </div>

          {/* Status display */}
          {status !== 'idle' && (
            <div
              className={cn(
                'flex items-center gap-2 text-sm',
                status === 'error' ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {status === 'error' && <AlertCircle className="h-4 w-4" />}
              {status === 'done' && (
                <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
              <span>{error || statusMessages[status]}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Submitting...
              </>
            ) : (
              'Submit Bug Report'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
