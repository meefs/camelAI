'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ArrowUp } from 'lucide-react';

interface SlotMachinePromptProps {
  prompts: string[];
  className?: string;
  displayDuration?: number;
  scrambleSpeed?: number;
}

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function getRandomChar() {
  return CHARS[Math.floor(Math.random() * CHARS.length)];
}

interface CharState {
  char: string;
  revealed: boolean;
}

export function SlotMachinePrompt({
  prompts,
  className,
  displayDuration = 1000,
  scrambleSpeed = 15,
}: SlotMachinePromptProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [chars, setChars] = useState<CharState[]>([]);
  const [revealedCount, setRevealedCount] = useState(0);
  const [isScrambling, setIsScrambling] = useState(true);

  const targetText = prompts[currentIndex] || '';

  // Scramble effect - update random characters for unrevealed positions
  useEffect(() => {
    if (!isScrambling || revealedCount >= targetText.length) return;

    const interval = setInterval(() => {
      setChars(() => {
        const result: CharState[] = [];
        for (let i = 0; i < targetText.length; i++) {
          if (i < revealedCount) {
            result.push({ char: targetText[i], revealed: true });
          } else if (targetText[i] === ' ') {
            result.push({ char: ' ', revealed: true });
          } else {
            result.push({ char: getRandomChar(), revealed: false });
          }
        }
        return result;
      });
    }, scrambleSpeed);

    return () => clearInterval(interval);
  }, [isScrambling, revealedCount, targetText, scrambleSpeed]);

  // Reveal characters one by one
  useEffect(() => {
    if (!isScrambling || revealedCount >= targetText.length) return;

    const timeout = setTimeout(() => {
      setRevealedCount((prev) => prev + 1);
    }, scrambleSpeed * 2);

    return () => clearTimeout(timeout);
  }, [isScrambling, revealedCount, targetText.length, scrambleSpeed]);

  // When all characters revealed, stop scrambling
  useEffect(() => {
    if (revealedCount >= targetText.length && targetText.length > 0) {
      setChars(targetText.split('').map((char) => ({ char, revealed: true })));
      setIsScrambling(false);
    }
  }, [revealedCount, targetText]);

  // Cycle to next prompt after display duration
  useEffect(() => {
    if (isScrambling) return;

    const timeout = setTimeout(() => {
      setCurrentIndex((prev) => (prev + 1) % prompts.length);
      setRevealedCount(0);
      setIsScrambling(true);
    }, displayDuration);

    return () => clearTimeout(timeout);
  }, [isScrambling, displayDuration, prompts.length]);

  // Initialize on mount
  useEffect(() => {
    setChars(
      targetText.split('').map((c) => ({
        char: c === ' ' ? ' ' : getRandomChar(),
        revealed: false,
      }))
    );
  }, [targetText]);

  return (
    <div className={cn('relative w-full max-w-md', className)}>
      <div className="relative">
        <div className="border-input min-h-[80px] rounded-md border px-2 py-2 pr-12 text-sm md:text-xs/relaxed bg-background/85 backdrop-blur-md">
          {chars.map((c, i) => (
            <span
              key={i}
              className={cn(
                'transition-colors duration-150',
                c.revealed ? 'text-foreground' : 'text-muted-foreground/50'
              )}
            >
              {c.char}
            </span>
          ))}
        </div>
        <Button
          size="icon"
          variant="default"
          className="absolute bottom-2 right-2 size-8 rounded-md pointer-events-none opacity-60"
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
}
