"use client";

import { cn } from '@/lib/utils';
import { TodoStatusIcon } from './todo-status-icon';
import type { TodoStatus } from './floating-todo-list';

interface TodoTaskItemProps {
  index: number;
  content: string;
  status: TodoStatus;
}

export function TodoTaskItem({ index, content, status }: TodoTaskItemProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 py-1",
        status === 'completed' && "text-muted-foreground/50"
      )}
    >
      <TodoStatusIcon status={status} className="mt-0.5 shrink-0" />
      <span
        className={cn(
          "text-sm text-muted-foreground leading-relaxed",
          status === 'completed' && "line-through"
        )}
      >
        {index}. {content}
      </span>
    </div>
  );
}
