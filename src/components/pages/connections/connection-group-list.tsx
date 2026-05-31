"use client";

import { Plus, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PanelItem } from "@/lib/connections-shared";
import { ConnectionRow, type ConnectionActionHandlers } from "./connection-row";

interface ConnectionGroupListProps extends ConnectionActionHandlers {
  channelItems: PanelItem[];
  connectionItems: PanelItem[];
  totalConnectionCount: number;
  selectedId: string | null;
  isAdmin: boolean;
  otherWorkspacesCount: number;
  searchQuery: string;
  getMentionSlug: (item: PanelItem) => string | null;
  onSelect: (item: PanelItem) => void;
  onNewChat: (item: PanelItem, mentionSlug: string) => void;
  onAddConnection: () => void;
}

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">{count}</span>
    </div>
  );
}

function ItemGrid({
  items,
  selectedId,
  isAdmin,
  otherWorkspacesCount,
  getMentionSlug,
  onSelect,
  onNewChat,
  actions,
}: {
  items: PanelItem[];
  selectedId: string | null;
  isAdmin: boolean;
  otherWorkspacesCount: number;
  getMentionSlug: (item: PanelItem) => string | null;
  onSelect: (item: PanelItem) => void;
  onNewChat: (item: PanelItem, mentionSlug: string) => void;
  actions: ConnectionActionHandlers;
}) {
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 @[768px]:grid-cols-2">
      {items.map((item) => {
        return (
          <ConnectionRow
            key={`${item.kind}:${item.id}`}
            item={item}
            isSelected={item.id === selectedId}
            isAdmin={isAdmin}
            otherWorkspacesCount={otherWorkspacesCount}
            mentionSlug={getMentionSlug(item)}
            onSelect={() => onSelect(item)}
            onNewChat={onNewChat}
            {...actions}
          />
        );
      })}
    </div>
  );
}

export function ConnectionGroupList({
  channelItems,
  connectionItems,
  totalConnectionCount,
  selectedId,
  isAdmin,
  otherWorkspacesCount,
  searchQuery,
  getMentionSlug,
  onSelect,
  onNewChat,
  onAddConnection,
  onStartRename,
  onConfigure,
  onReconnect,
  onClone,
  onDelete,
  onCopyEmailAddress,
  onManageEmailSettings,
}: ConnectionGroupListProps) {
  const hasChannels = channelItems.length > 0;
  const hasConnections = connectionItems.length > 0;
  const actions = {
    onStartRename,
    onConfigure,
    onReconnect,
    onClone,
    onDelete,
    onCopyEmailAddress,
    onManageEmailSettings,
  };

  if (!hasChannels && !hasConnections) {
    return (
      <p className="mt-8 text-sm text-muted-foreground">
        No connections match &quot;{searchQuery}&quot;.
      </p>
    );
  }

  return (
    <div className="mt-8 space-y-8">
      {hasChannels ? (
        <section>
          <GroupHeader label="Channels" count={channelItems.length} />
          <ItemGrid
            items={channelItems}
            selectedId={selectedId}
            isAdmin={isAdmin}
            otherWorkspacesCount={otherWorkspacesCount}
            getMentionSlug={getMentionSlug}
            onSelect={onSelect}
            onNewChat={onNewChat}
            actions={actions}
          />
        </section>
      ) : null}

      {hasConnections ? (
        <section>
          <GroupHeader label="Connections" count={connectionItems.length} />
          <ItemGrid
            items={connectionItems}
            selectedId={selectedId}
            isAdmin={isAdmin}
            otherWorkspacesCount={otherWorkspacesCount}
            getMentionSlug={getMentionSlug}
            onSelect={onSelect}
            onNewChat={onNewChat}
            actions={actions}
          />
        </section>
      ) : null}

      {totalConnectionCount === 0 ? (
        <div className="rounded-lg border border-dashed p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
              <Plug className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">No saved connections yet</p>
              <p className="text-xs text-muted-foreground">
                Add a connection to give your apps access to external services.
              </p>
            </div>
            {isAdmin ? (
              <Button type="button" variant="outline" onClick={onAddConnection}>
                <Plus />
                Add your first connection
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Only admins can add connections.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
