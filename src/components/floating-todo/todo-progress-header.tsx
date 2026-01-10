"use client";

import * as React from 'react';
import { ChevronDown, ChevronUp, ListTodo } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TodoProgressHeaderProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  completed: number;
  total: number;
  isExpanded: boolean;
}

export const TodoProgressHeader = React.forwardRef<HTMLButtonElement, TodoProgressHeaderProps>(
  ({ completed, total, isExpanded, className, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "flex w-full items-center gap-2 px-4 py-3 text-sm text-muted-foreground",
          "hover:bg-muted/30 transition-colors",
          "cursor-pointer",
          className
        )}
        {...props}
      >
        <ListTodo className="h-4 w-4 text-muted-foreground/60" />
        <span className="flex-1 text-left">
          {completed} out of {total} tasks completed
        </span>
        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground/40" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground/40" />
        )}
      </button>
    );
  }
);

TodoProgressHeader.displayName = "TodoProgressHeader";
