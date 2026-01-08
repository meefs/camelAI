"use client";

import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TodoStatus } from './floating-todo-list';

interface TodoStatusIconProps {
  status: TodoStatus;
  className?: string;
}

export function TodoStatusIcon({ status, className }: TodoStatusIconProps) {
  switch (status) {
    case 'pending':
      return (
        <Circle
          className={cn("h-4 w-4 text-muted-foreground/40", className)}
        />
      );
    case 'in_progress':
      return (
        <Loader2
          className={cn("h-4 w-4 text-blue-500 animate-spin", className)}
        />
      );
    case 'completed':
      return (
        <CheckCircle2
          className={cn("h-4 w-4 text-green-500", className)}
        />
      );
  }
}
