"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Info, Plus, Plug, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  TYPE_COPY,
  type PanelItem,
} from "@/lib/connections-shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IntegrationIcon } from "@/lib/integration-icons";
import { CHANNEL_BRANDS } from "@/lib/channel-branding";
import type { ChannelIndicatorKind } from "@/lib/channel-kinds";
import { ConnectionRow, type ConnectionActionHandlers } from "./connection-row";

interface ConnectionGroupListProps extends ConnectionActionHandlers {
  channelItems: PanelItem[];
  connectionItems: PanelItem[];
  connectedIntegrationTypes: string[];
  availableIntegrationTypes: string[];
  totalConnectionCount: number;
  selectedId: string | null;
  isAdmin: boolean;
  mounted: boolean;
  workspaceId: string;
  otherWorkspacesCount: number;
  searchQuery: string;
  getMentionSlug: (item: PanelItem) => string | null;
  onSelect: (item: PanelItem) => void;
  onNewChat: (item: PanelItem, mentionSlug: string) => void;
  onAddConnection: () => void;
  onAddChannel: (integrationType: string) => void;
}

function GroupHeader({
  label,
  count,
  info,
}: {
  label: string;
  count: number;
  info?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">{count}</span>
      {info ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="What is a channel?">
              <Info className="size-3.5 text-muted-foreground/70" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-72">
            {info}
          </TooltipContent>
        </Tooltip>
      ) : null}
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
  children,
}: {
  items: PanelItem[];
  selectedId: string | null;
  isAdmin: boolean;
  otherWorkspacesCount: number;
  getMentionSlug: (item: PanelItem) => string | null;
  onSelect: (item: PanelItem) => void;
  onNewChat: (item: PanelItem, mentionSlug: string) => void;
  actions: ConnectionActionHandlers;
  children?: ReactNode;
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
      {children}
    </div>
  );
}

const CHANNEL_SUGGESTIONS = [
  { kind: "slack", integrationType: "slack" },
  { kind: "telegram", integrationType: "telegram" },
  { kind: "discord", integrationType: "discord_channel" },
] as const satisfies ReadonlyArray<{
  kind: Exclude<ChannelIndicatorKind, "email">;
  integrationType: string;
}>;

function ChannelGhostCards({
  connectedIntegrationTypes,
  availableIntegrationTypes,
  dismissedKinds,
  onAddChannel,
  onDismiss,
}: {
  connectedIntegrationTypes: string[];
  availableIntegrationTypes: string[];
  dismissedKinds: ChannelIndicatorKind[];
  onAddChannel: (integrationType: string) => void;
  onDismiss: (kind: ChannelIndicatorKind) => void;
}) {
  const connected = new Set(connectedIntegrationTypes);
  const available = new Set(availableIntegrationTypes);
  const dismissed = new Set(dismissedKinds);

  return CHANNEL_SUGGESTIONS.flatMap(({ kind, integrationType }) => {
    if (
      connected.has(integrationType) ||
      !available.has(integrationType) ||
      dismissed.has(kind)
    ) {
      return [];
    }

    const brand = CHANNEL_BRANDS[kind];
    if (!brand.logoType) return [];

    return [
      <div
        key={kind}
        className="group/ghost relative flex animate-in items-center gap-3 rounded-lg border border-dashed bg-transparent px-3 py-2.5 text-muted-foreground fade-in transition-colors hover:bg-muted/40 hover:text-foreground"
      >
        <button
          type="button"
          onClick={() => onAddChannel(integrationType)}
          aria-label={`Connect ${brand.label}`}
          className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed">
          <IntegrationIcon
            type={brand.logoType}
            className="size-5 opacity-50 grayscale transition-[filter,opacity] group-hover/ghost:opacity-100 group-hover/ghost:grayscale-0"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{brand.label}</div>
          <div className="text-xs">Not connected</div>
        </div>
        <Plus className="size-4 shrink-0" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="relative z-10 size-7 text-muted-foreground/60 hover:text-foreground"
              aria-label={`Hide ${brand.label} suggestion`}
              onClick={(event) => {
                event.stopPropagation();
                onDismiss(kind);
              }}
            >
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Hide this suggestion</TooltipContent>
        </Tooltip>
      </div>,
    ];
  });
}

export function ConnectionGroupList({
  channelItems,
  connectionItems,
  connectedIntegrationTypes,
  availableIntegrationTypes,
  totalConnectionCount,
  selectedId,
  isAdmin,
  mounted,
  workspaceId,
  otherWorkspacesCount,
  searchQuery,
  getMentionSlug,
  onSelect,
  onNewChat,
  onAddConnection,
  onAddChannel,
  onStartRename,
  onConfigure,
  onReconnect,
  onVerify,
  onClone,
  onDelete,
  onCopyEmailAddress,
  onManageEmailSettings,
}: ConnectionGroupListProps) {
  const [dismissedKinds, setDismissedKinds] = useState<ChannelIndicatorKind[]>([]);
  const [dismissalsLoaded, setDismissalsLoaded] = useState(false);
  const hasChannels = channelItems.length > 0;
  const hasConnections = connectionItems.length > 0;
  const actions = {
    onStartRename,
    onConfigure,
    onReconnect,
    onVerify,
    onClone,
    onDelete,
    onCopyEmailAddress,
    onManageEmailSettings,
  };
  const channelSuggestionStorageKey =
    `camelai.connections.channel-suggestions.${workspaceId}`;

  useEffect(() => {
    if (!mounted) {
      setDismissalsLoaded(false);
      return;
    }

    try {
      const stored = JSON.parse(
        window.localStorage.getItem(channelSuggestionStorageKey) ?? "[]",
      );
      setDismissedKinds(
        Array.isArray(stored)
          ? stored.filter(
              (kind): kind is ChannelIndicatorKind =>
                typeof kind === "string" &&
                CHANNEL_SUGGESTIONS.some((suggestion) => suggestion.kind === kind),
            )
          : [],
      );
    } catch {
      setDismissedKinds([]);
    }
    setDismissalsLoaded(true);
  }, [channelSuggestionStorageKey, mounted]);

  const dismissSuggestion = (kind: ChannelIndicatorKind) => {
    setDismissedKinds((current) => {
      const next = current.includes(kind) ? current : [...current, kind];
      try {
        window.localStorage.setItem(
          channelSuggestionStorageKey,
          JSON.stringify(next),
        );
      } catch {
        // Client-only persistence is best effort; keep the current view dismissed.
      }
      return next;
    });
  };

  const showChannelSuggestions =
    mounted &&
    dismissalsLoaded &&
    isAdmin &&
    searchQuery.length === 0;

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
          <GroupHeader
            label="Channels"
            count={channelItems.length}
            info={TYPE_COPY.channel}
          />
          <ItemGrid
            items={channelItems}
            selectedId={selectedId}
            isAdmin={isAdmin}
            otherWorkspacesCount={otherWorkspacesCount}
            getMentionSlug={getMentionSlug}
            onSelect={onSelect}
            onNewChat={onNewChat}
            actions={actions}
          >
            {showChannelSuggestions ? (
              <ChannelGhostCards
                connectedIntegrationTypes={connectedIntegrationTypes}
                availableIntegrationTypes={availableIntegrationTypes}
                dismissedKinds={dismissedKinds}
                onAddChannel={onAddChannel}
                onDismiss={dismissSuggestion}
              />
            ) : null}
          </ItemGrid>
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
