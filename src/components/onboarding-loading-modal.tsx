import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const BOOT_LINES = [
  { text: 'Creating your workspace' },
  {
    text: 'Mounting persistent filesystem',
    subtitle: 'Your files live here permanently — even between sessions',
  },
  {
    text: 'Starting first conversation',
    subtitle: 'The agent will ask a couple questions to get you started',
  },
  {
    text: 'Enabling live publishing',
    subtitle: 'Anything you build can go live with a shareable link',
  },
  {
    text: 'Preparing integrations',
    subtitle: 'Slack, databases, APIs — ready to connect when you are',
  },
  {
    text: 'Installing tools',
    subtitle: 'Image generation, web search, deep research',
  },
] as const;

const LINE_INTERVAL_MS = 850;
const READY_DELAY_MS = 400;
const DISMISS_DELAY_MS = 600;

interface OnboardingLoadingModalProps {
  open: boolean;
  onDismiss: () => void;
}

export function OnboardingLoadingModal({ open, onDismiss }: OnboardingLoadingModalProps) {
  const [visibleLines, setVisibleLines] = useState(0);
  const [showReadyLine, setShowReadyLine] = useState(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;

    let lineCount = 0;
    let readyTimer: ReturnType<typeof setTimeout>;
    let dismissTimer: ReturnType<typeof setTimeout>;

    const lineTimer = setInterval(() => {
      lineCount++;
      setVisibleLines(lineCount);

      if (lineCount >= BOOT_LINES.length) {
        clearInterval(lineTimer);

        readyTimer = setTimeout(() => {
          setShowReadyLine(true);

          dismissTimer = setTimeout(() => {
            onDismissRef.current();
          }, DISMISS_DELAY_MS);
        }, READY_DELAY_MS);
      }
    }, LINE_INTERVAL_MS);

    return () => {
      clearInterval(lineTimer);
      clearTimeout(readyTimer);
      clearTimeout(dismissTimer);
    };
  }, [open]);

  const isComplete = showReadyLine;

  return (
    <Dialog open={open} modal>
      <DialogContent
        showCloseButton={false}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        className={cn(
          'sm:max-w-md',
          'bg-white text-zinc-600 ring-zinc-200 dark:bg-zinc-950 dark:text-zinc-300 dark:ring-zinc-800',
          'font-mono text-[13px] leading-relaxed',
          'p-6',
        )}
      >
          {/* Status header */}
          <div className="flex items-center gap-2.5 mb-5">
            <div
              className={cn(
                'h-2 w-2 rounded-full transition-colors duration-300',
                isComplete
                  ? 'bg-emerald-400'
                  : 'bg-amber-400 animate-pulse',
              )}
            />
            <span className="text-zinc-800 dark:text-zinc-200 text-sm font-medium">
              {isComplete ? 'Machine ready' : 'Setting up your machine'}
            </span>
          </div>

          {/* Boot lines */}
          <div className="space-y-2.5 min-h-[200px]">
            {BOOT_LINES.slice(0, visibleLines).map((line, i) => (
              <div
                key={i}
                className="animate-in fade-in slide-in-from-left-2 duration-300 ease-out"
              >
                <div className="flex items-start gap-2">
                  <span className="text-zinc-400 dark:text-zinc-600 shrink-0">&rsaquo;</span>
                  <div>
                    <span className="text-zinc-600 dark:text-zinc-300">{line.text}</span>
                    {'subtitle' in line && line.subtitle && (
                      <p className="text-[11px] text-zinc-400 dark:text-zinc-600 mt-0.5">
                        {line.subtitle}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {/* Blinking cursor */}
            {!showReadyLine && visibleLines > 0 && (
              <div className="ml-5 mt-1">
                <div className="h-4 w-1.5 bg-zinc-400 dark:bg-zinc-500 animate-[blink_1s_steps(1)_infinite]" />
              </div>
            )}

            {/* Ready line */}
            {showReadyLine && (
              <div className="animate-in fade-in slide-in-from-left-2 duration-300 ease-out">
                <div className="flex items-start gap-2">
                  <span className="text-emerald-400 shrink-0">&bull;</span>
                  <span className="text-zinc-900 dark:text-zinc-100 font-medium">
                    Your machine is ready
                    <Check className="ml-1.5 inline h-3.5 w-3.5 text-emerald-400" />
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between mt-6 text-[11px] text-zinc-400 dark:text-zinc-700">
            <span>camelAI</span>
            <span>one-time setup</span>
          </div>
      </DialogContent>
    </Dialog>
  );
}
