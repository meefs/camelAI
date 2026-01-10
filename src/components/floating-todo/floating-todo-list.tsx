"use client";

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TodoProgressHeader } from './todo-progress-header';
import { TodoTaskItem } from './todo-task-item';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

interface FloatingTodoListProps {
  todos: TodoItem[];
  isStreaming: boolean;
  className?: string;
}

export function FloatingTodoList({ todos, isStreaming, className }: FloatingTodoListProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const completedCount = todos.filter(todo => todo.status === 'completed').length;
  const totalCount = todos.length;

  useEffect(() => {
    if (!todos.length) return;
    const hasInProgress = todos.some(todo => todo.status === 'in_progress');
    if (hasInProgress) {
      setIsExpanded(true);
    }
  }, [todos, isStreaming]);

  if (todos.length === 0) return null;

  return (
    <div
      className={cn(
        "rounded-xl border border-border/50 bg-background/95 backdrop-blur-sm shadow-sm",
        "overflow-hidden",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
        className
      )}
    >
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleTrigger asChild>
          <TodoProgressHeader
            completed={completedCount}
            total={totalCount}
            isExpanded={isExpanded}
          />
        </CollapsibleTrigger>

        <CollapsibleContent
          className={cn(
            "overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
            "motion-reduce:animate-none"
          )}
        >
          <ScrollArea viewportClassName="max-h-[200px]">
            <div className="space-y-2 px-4 pb-3">
              {todos.map((todo, index) => (
                <TodoTaskItem
                  key={`${todo.content}-${index}`}
                  index={index + 1}
                  content={todo.status === 'in_progress' ? todo.activeForm : todo.content}
                  status={todo.status}
                />
              ))}
            </div>
          </ScrollArea>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
