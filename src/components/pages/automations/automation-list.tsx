"use client";

import { Clock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { AutomationRow } from "./automation-row";
import type { AutomationListItem } from "@/lib/automations-shared";

interface RenameState {
  id: string;
  kind: AutomationListItem["kind"];
  value: string;
}

interface AutomationListProps {
  automations: AutomationListItem[];
  filteredCount: number;
  searchQuery: string;
  selectedId: string | null;
  renaming: RenameState | null;
  onRenameValueChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSelect: (automation: AutomationListItem) => void;
  onRun: (automation: AutomationListItem) => void;
  onOpen: (automation: AutomationListItem) => void;
  onStartRename: (automation: AutomationListItem) => void;
  onDelete: (automation: AutomationListItem) => void;
  onNewAutomation: () => void;
}

export function AutomationList({
  automations,
  filteredCount,
  searchQuery,
  selectedId,
  renaming,
  onRenameValueChange,
  onCommitRename,
  onCancelRename,
  onSelect,
  onRun,
  onOpen,
  onStartRename,
  onDelete,
  onNewAutomation,
}: AutomationListProps) {
  if (filteredCount === 0 && !searchQuery) {
    return (
      <div className="mt-24 flex flex-col items-center justify-center text-center">
        <div className="flex size-20 items-center justify-center rounded-full bg-muted">
          <Clock className="size-8 text-muted-foreground" />
        </div>
        <h2 className="mt-6 text-xl font-semibold">No automations yet</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Schedule a chat or workflow to run on its own. Describe what you want in a chat.
        </p>
        <Button type="button" className="mt-6" onClick={onNewAutomation}>
          <Plus />
          New automation
        </Button>
      </div>
    );
  }

  if (automations.length === 0) {
    return (
      <p className="mt-8 text-sm text-muted-foreground">
        No automations match &quot;{searchQuery}&quot;.
      </p>
    );
  }

  return (
    <div className="mt-6">
      {automations.map((automation, index) => (
        <div key={`${automation.kind}:${automation.id}`}>
          <AutomationRow
            automation={automation}
            isSelected={automation.id === selectedId}
            isRenaming={
              renaming?.id === automation.id && renaming.kind === automation.kind
            }
            renameValue={
              renaming?.id === automation.id && renaming.kind === automation.kind
                ? renaming.value
                : automation.name
            }
            onRenameValueChange={onRenameValueChange}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
            onSelect={() => onSelect(automation)}
            onRun={() => onRun(automation)}
            onOpen={() => onOpen(automation)}
            onStartRename={() => onStartRename(automation)}
            onDelete={() => onDelete(automation)}
          />
          {index < automations.length - 1 ? <Separator /> : null}
        </div>
      ))}
    </div>
  );
}
