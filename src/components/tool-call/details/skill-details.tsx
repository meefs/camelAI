"use client";

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow } from './shared';
import { getResultText } from '../tool-utils';
import { cn } from '@/lib/utils';

interface SkillDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  skillSheet?: string;
}

export function SkillDetails({ tool, result, skillSheet }: SkillDetailsProps) {
  const [isSheetExpanded, setIsSheetExpanded] = useState(false);
  const input = tool?.input ?? {};
  const skillName = typeof input.skill === 'string' ? input.skill : '';
  const skillPath = skillName
    ? `/home/claude/.claude/skills/${skillName}/SKILL.md`
    : '';
  const resultText = getResultText(result);
  const sheetText = skillSheet ?? '';
  const previewLength = 200;
  const hasLongSheet = sheetText.length > previewLength;
  const sheetPreview = hasLongSheet
    ? `${sheetText.slice(0, previewLength)}...`
    : sheetText;

  return (
    <div className="space-y-1">
      <DetailRow
        label="Skill:"
        value={skillName}
        mono
        asFileLink={Boolean(skillName)}
        filePath={skillPath || undefined}
      />
      {resultText ? <DetailRow label="Status:" value={resultText} /> : null}

      {sheetText ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setIsSheetExpanded(prev => !prev)}
            className={cn(
              "flex items-center gap-1 text-[0.7rem] text-muted-foreground/60 hover:text-muted-foreground transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 rounded"
            )}
          >
            {isSheetExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span>Skill Sheet</span>
          </button>

          <div
            className={cn(
              "mt-2 font-mono text-xs bg-muted/30 rounded p-2 overflow-auto transition-all",
              isSheetExpanded ? "max-h-64" : "max-h-16"
            )}
          >
            <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground/80">
              {isSheetExpanded ? sheetText : sheetPreview}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
