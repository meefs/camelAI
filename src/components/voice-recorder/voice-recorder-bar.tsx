'use client';

import { X, Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { AudioWaveform } from './audio-waveform';
import { RecordingTimer } from './recording-timer';

interface VoiceRecorderBarProps {
  analyser: AnalyserNode | null;
  recordingStartTime: number | null;
  isWarmingUp: boolean;
  isTranscribing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  className?: string;
}

export function VoiceRecorderBar({
  analyser,
  recordingStartTime,
  isWarmingUp,
  isTranscribing,
  onCancel,
  onConfirm,
  className,
}: VoiceRecorderBarProps) {
  return (
    <div className={cn('flex-1 flex items-center gap-2', className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onCancel}
        disabled={isTranscribing}
        className={cn(
          'size-8 rounded-full bg-muted/80 hover:bg-muted text-muted-foreground shrink-0',
          isTranscribing && 'opacity-50 cursor-not-allowed'
        )}
        aria-label="Cancel recording"
      >
        <X className="size-4" />
      </Button>

      <div className="flex-1 flex items-center justify-center gap-3 min-w-0">
        {isTranscribing ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-sm">Transcribing...</span>
          </div>
        ) : isWarmingUp ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-sm">Starting mic...</span>
          </div>
        ) : (
          <>
            <AudioWaveform
              analyser={analyser}
              className="flex-1 h-6 min-w-0 w-full"
            />
            <RecordingTimer
              startTime={recordingStartTime}
              className="shrink-0 text-sm text-muted-foreground tabular-nums"
            />
          </>
        )}
      </div>

      <Button
        type="button"
        variant="default"
        size="icon"
        onClick={onConfirm}
        disabled={isWarmingUp || isTranscribing}
        className={cn(
          'size-8 rounded-full shrink-0 transition-transform active:scale-95',
          (isWarmingUp || isTranscribing) && 'opacity-50 cursor-not-allowed'
        )}
        aria-label="Finish recording"
      >
        <Check className="size-4" />
      </Button>
    </div>
  );
}
