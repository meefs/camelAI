'use client';

import { useState, useLayoutEffect } from 'react';
import { cn } from '@/lib/utils';

interface RecordingTimerProps {
  startTime: number | null;
  className?: string;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function RecordingTimer({ startTime, className }: RecordingTimerProps) {
  const [, setTick] = useState(0);

  useLayoutEffect(() => {
    if (!startTime) {
      return;
    }

    const interval = setInterval(() => {
      setTick((tick) => tick + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  const elapsed = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;

  return (
    <span className={cn('font-mono', className)}>
      {formatTime(elapsed)}
    </span>
  );
}
