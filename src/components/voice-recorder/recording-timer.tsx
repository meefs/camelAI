'use client';

import { useState, useEffect } from 'react';
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
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) {
      setElapsed(0);
      return;
    }

    setElapsed(Math.floor((Date.now() - startTime) / 1000));

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <span className={cn('font-mono', className)}>
      {formatTime(elapsed)}
    </span>
  );
}
