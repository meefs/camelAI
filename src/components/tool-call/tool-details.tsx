"use client";

import type { ReactNode } from 'react';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { ReadDetails } from './details/read-details';
import { WriteDetails } from './details/write-details';
import { EditDetails } from './details/edit-details';
import { BashDetails } from './details/bash-details';
import { SearchDetails } from './details/search-details';
import { TaskDetails } from './details/task-details';
import { WebDetails } from './details/web-details';
import { TodoDetails } from './details/todo-details';
import { NotebookDetails } from './details/notebook-details';
import { GenericDetails } from './details/generic-details';
import { SkillDetails } from './details/skill-details';

interface ToolCallDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  skillSheet?: string;
}

export function ToolCallDetails({ tool, result, skillSheet }: ToolCallDetailsProps) {
  const name = tool?.name;

  let content: ReactNode;
  switch (name) {
    case 'Skill':
      content = <SkillDetails tool={tool} result={result} skillSheet={skillSheet} />;
      break;
    case 'Read':
      content = <ReadDetails tool={tool} result={result} />;
      break;
    case 'Write':
      content = <WriteDetails tool={tool} />;
      break;
    case 'Edit':
      content = <EditDetails tool={tool} />;
      break;
    case 'Bash':
      content = <BashDetails tool={tool} result={result} />;
      break;
    case 'Glob':
      content = <SearchDetails tool={tool} result={result} mode="glob" />;
      break;
    case 'Grep':
      content = <SearchDetails tool={tool} result={result} mode="grep" />;
      break;
    case 'Task':
    case 'TaskOutput':
      content = <TaskDetails tool={tool} result={result} />;
      break;
    case 'WebFetch':
      content = <WebDetails tool={tool} result={result} mode="fetch" />;
      break;
    case 'WebSearch':
      content = <WebDetails tool={tool} result={result} mode="search" />;
      break;
    case 'TodoWrite':
      content = <TodoDetails tool={tool} result={result} />;
      break;
    case 'NotebookEdit':
      content = <NotebookDetails tool={tool} />;
      break;
    default:
      content = <GenericDetails tool={tool} result={result} />;
  }

  return (
    <div className="pl-4 mt-1 text-xs text-muted-foreground/80 border-l border-border/50 ml-1">
      {content}
    </div>
  );
}
