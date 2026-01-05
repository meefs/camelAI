"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow, OutputBlock } from './shared';
import { getResultText } from '../tool-utils';

interface TodoDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
}

type TodoItem = {
  content?: string;
  status?: string;
  activeForm?: string;
};

export function TodoDetails({ tool, result }: TodoDetailsProps) {
  const input = tool?.input ?? {};
  const todos = Array.isArray(input.todos) ? (input.todos as TodoItem[]) : [];
  const resultText = getResultText(result);

  return (
    <div className="space-y-2">
      {todos.length > 0 ? (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground/60">Tasks:</div>
          <div className="space-y-1 pl-6">
            {todos.map((todo, index) => {
              const status = todo.status || 'pending';
              const marker = status === 'completed' ? '[x]' : '[ ]';
              return (
                <div key={`${status}-${index}`} className="flex items-start gap-2 text-xs text-muted-foreground/80">
                  <span className="font-mono text-muted-foreground/60">{marker}</span>
                  <span className="flex-1">{todo.content || todo.activeForm || 'Untitled task'}</span>
                  <span className="text-[0.65rem] uppercase text-muted-foreground/50">{status}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <DetailRow label="Tasks:" value="No tasks provided" />
      )}
      <OutputBlock value={resultText} label="Result" copyValue={resultText} />
    </div>
  );
}
