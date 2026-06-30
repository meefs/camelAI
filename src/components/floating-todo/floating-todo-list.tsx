"use client";

import { useLayoutEffect, useMemo, useState } from 'react';
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

function normalizeTodoStatus(status: unknown): TodoStatus {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : '';
  switch (value) {
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'inprogress':
    case 'in_progress':
    case 'in-progress':
    case 'running':
    case 'active':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function normalizeTodoText(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeTodoText).filter(Boolean).join('');
  }
  return '';
}

function normalizeTodoItem(value: unknown, index: number): TodoItem | null {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    const content = String(value).trim();
    return content ? { content, status: 'pending', activeForm: content } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const content =
    normalizeTodoText(record.content) ||
    normalizeTodoText(record.step) ||
    normalizeTodoText(record.title) ||
    normalizeTodoText(record.task) ||
    normalizeTodoText(record.text) ||
    normalizeTodoText(record.description) ||
    normalizeTodoText(record.name) ||
    `Task ${index + 1}`;
  const activeForm =
    normalizeTodoText(record.activeForm) ||
    normalizeTodoText(record.active_form) ||
    normalizeTodoText(record.active) ||
    content;

  return {
    content,
    status: normalizeTodoStatus(record.status),
    activeForm,
  };
}

function normalizeTodosForDisplay(todos: TodoItem[]): TodoItem[] {
  return todos
    .map(normalizeTodoItem)
    .filter((todo): todo is TodoItem => todo !== null);
}

export function FloatingTodoList({ todos, isStreaming, className }: FloatingTodoListProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const displayTodos = useMemo(() => normalizeTodosForDisplay(todos), [todos]);

  const completedCount = displayTodos.filter(todo => todo.status === 'completed').length;
  const totalCount = displayTodos.length;

  useLayoutEffect(() => {
    if (!displayTodos.length) return;
    const hasInProgress = displayTodos.some(todo => todo.status === 'in_progress');
    if (hasInProgress) {
      setIsExpanded(true);
    }
  }, [displayTodos, isStreaming]);

  if (displayTodos.length === 0) return null;

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
              {displayTodos.map((todo, index) => (
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
