import { Code2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { PreviewTarget } from '@/types';
import { getTabIcon } from './preview-utils';

export type PreviewSourceMode = 'preview' | 'source';

interface PreviewSourceToggleProps {
  target: PreviewTarget;
  value: PreviewSourceMode;
  onChange: (mode: PreviewSourceMode) => void;
}

function triggerClasses(isActive: boolean) {
  return cn(
    'h-[22px]! w-7! rounded-md! p-0! transition-colors',
    isActive
      ? 'bg-background! text-foreground! shadow-sm! dark:bg-white/15! dark:shadow-none!'
      : 'text-muted-foreground! hover:text-foreground!'
  );
}

export function PreviewSourceToggle({
  target,
  value,
  onChange,
}: PreviewSourceToggleProps) {
  const PreviewIcon = getTabIcon(target);

  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue === 'preview' || nextValue === 'source') {
          onChange(nextValue);
        }
      }}
      className="shrink-0 gap-0"
    >
      <TabsList className="h-6! rounded-md! bg-muted/70! p-px!">
        <Tooltip>
          <TooltipTrigger asChild>
            <TabsTrigger
              value="preview"
              className={triggerClasses(value === 'preview')}
              aria-label="Preview"
            >
              <PreviewIcon className="h-3.5 w-3.5" />
            </TabsTrigger>
          </TooltipTrigger>
          <TooltipContent>Preview</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <TabsTrigger
              value="source"
              className={triggerClasses(value === 'source')}
              aria-label="Source code"
            >
              <Code2 className="h-3.5 w-3.5" />
            </TabsTrigger>
          </TooltipTrigger>
          <TooltipContent>Source code</TooltipContent>
        </Tooltip>
      </TabsList>
    </Tabs>
  );
}
