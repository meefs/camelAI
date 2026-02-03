import { useState, useRef } from 'react';
import { Loader2, Bug, AlertCircle, Mic } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useVoiceRecording } from '@/hooks/use-voice-recording';
import { VoiceRecorderBar } from '@/components/voice-recorder';

export type BugReportStatus = 'idle' | 'capturing' | 'uploading' | 'sending' | 'done' | 'error';

interface BugReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (report: { description: string }) => void;
  status: BugReportStatus;
  error?: string | null;
  /** Message from MCP agent explaining why the capture is needed */
  mcpMessage?: string;
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
  mcpMessage,
}: BugReportDialogProps) {
  const [description, setDescription] = useState('');
  const descriptionRef = useRef(description);
  descriptionRef.current = description;

  const {
    state: voiceState,
    startRecording,
    stopRecording,
    cancelRecording,
    isSupported: isVoiceSupported,
    analyser,
    recordingStartTime,
  } = useVoiceRecording({
    onTranscript: (text) => {
      const currentValue = descriptionRef.current;
      const nextValue = currentValue.trim() ? `${currentValue} ${text}` : text;
      setDescription(nextValue);
    },
    onError: (voiceError) => {
      console.error('[BugReportDialog] Voice error:', voiceError);
    },
  });

  const isLoading = status === 'capturing' || status === 'uploading' || status === 'sending';
  const isWarmingUp = voiceState === 'warming_up';
  const isRecording = voiceState === 'recording';
  const isTranscribing = voiceState === 'transcribing';
  const isActiveRecording = isWarmingUp || isRecording;
  const canSubmit = !isLoading && !isActiveRecording && !isTranscribing;

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit({ description: description.trim() });
  }

  function handleOpenChange(nextOpen: boolean) {
    if (isLoading) return; // Prevent closing while loading
    if (!nextOpen) {
      // Reset form when closing
      if (isActiveRecording || isTranscribing) {
        cancelRecording();
      }
      setDescription('');
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[500px]"
        onEscapeKeyDown={(event) => {
          if (isActiveRecording || isTranscribing) {
            event.preventDefault();
            cancelRecording();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="h-5 w-5" />
            {mcpMessage ? 'Capture Bug Report' : 'Report a Bug'}
          </DialogTitle>
          <DialogDescription>
            {mcpMessage ? (
              <>
                <span className="block mb-2 text-foreground/80">{mcpMessage}</span>
                <span>Optionally add a description of what you see, then click Capture to send the debug data to the agent.</span>
              </>
            ) : (
              'Tell us what went wrong - what you expected vs what actually happened, steps to reproduce, or anything else that might help.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="relative">
            <Textarea
              placeholder='e.g. "I clicked the submit button but nothing happened - I expected it to save my changes"'
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isLoading || isActiveRecording}
              className="min-h-[100px] resize-none pr-10"
            />
            {isVoiceSupported && voiceState === 'idle' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={(event) => {
                      event.preventDefault();
                      void startRecording();
                    }}
                    disabled={isLoading}
                    className="absolute bottom-2 right-2 rounded-full text-muted-foreground hover:text-foreground"
                    aria-label="Dictate"
                  >
                    <Mic className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Dictate</TooltipContent>
              </Tooltip>
            )}
          </div>

          {(isActiveRecording || isTranscribing) && (
            <VoiceRecorderBar
              analyser={analyser}
              recordingStartTime={recordingStartTime}
              isWarmingUp={isWarmingUp}
              isTranscribing={isTranscribing}
              onCancel={cancelRecording}
              onConfirm={stopRecording}
              className="w-full"
            />
          )}

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
                {mcpMessage ? 'Capturing...' : 'Submitting...'}
              </>
            ) : (
              mcpMessage ? 'Capture' : 'Submit Bug Report'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
