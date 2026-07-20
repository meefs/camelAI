"use client";

import type { MouseEvent, ReactNode } from "react";
import {
  Copy,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plug,
  RefreshCw,
  ShieldCheck,
  Settings,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IntegrationIcon, hasIntegrationIcon, resolveLogoType } from "@/lib/integration-icons";
import { cn } from "@/lib/utils";
import {
  canReconnectConnection,
  panelItemConnection,
  panelItemName,
  type ConnectionListItem,
  type PanelItem,
} from "@/lib/connections-shared";
import { Badge } from "@/components/ui/badge";

export interface ConnectionActionHandlers {
  onStartRename: (item: PanelItem) => void;
  onConfigure: (connection: ConnectionListItem, forceCredentialUpdate?: boolean) => void;
  onReconnect: (connection: ConnectionListItem) => void;
  onVerify: (connection: ConnectionListItem) => void;
  onClone: (connection: ConnectionListItem) => void;
  onDelete: (connection: ConnectionListItem) => void;
  onCopyEmailAddress: () => void;
  onManageEmailSettings: () => void;
}

function MenuItemIcon({ children }: { children: ReactNode }) {
  return <span className="mr-2 inline-flex size-3.5 items-center justify-center">{children}</span>;
}

interface ConnectionActionsMenuProps extends ConnectionActionHandlers {
  item: PanelItem;
  isAdmin: boolean;
  otherWorkspacesCount: number;
  align?: "start" | "center" | "end";
  triggerClassName?: string;
}

export function ConnectionActionsMenu({
  item,
  isAdmin,
  otherWorkspacesCount,
  align = "end",
  triggerClassName,
  onStartRename,
  onConfigure,
  onReconnect,
  onVerify,
  onClone,
  onDelete,
  onCopyEmailAddress,
  onManageEmailSettings,
}: ConnectionActionsMenuProps) {
  const connection = panelItemConnection(item);
  const isEmail = item.kind === "channel" && item.channel === "email";
  const showRecordActions = Boolean(connection && isAdmin);
  const showReconnect = Boolean(connection && isAdmin && canReconnectConnection(connection));
  const showClone = Boolean(connection && isAdmin && otherWorkspacesCount > 0);
  const showVerify = Boolean(connection);
  const hasActions = isEmail || showVerify || showRecordActions || showReconnect || showClone;

  if (!hasActions) return null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("size-7", triggerClassName)}
              aria-label="More"
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">More</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align={align}
        className="w-48"
        onClick={(event) => event.stopPropagation()}
      >
        {isEmail ? (
          <>
            <DropdownMenuItem
              disabled={!item.email.address}
              onSelect={(event) => {
                event.stopPropagation();
                onCopyEmailAddress();
              }}
            >
              <MenuItemIcon>
                <Copy />
              </MenuItemIcon>
              Copy address
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                event.stopPropagation();
                onManageEmailSettings();
              }}
            >
              <MenuItemIcon>
                <Mail />
              </MenuItemIcon>
              Manage email settings
            </DropdownMenuItem>
          </>
        ) : null}

        {connection && showVerify ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.stopPropagation();
              onVerify(connection);
            }}
          >
            <MenuItemIcon>
              <ShieldCheck />
            </MenuItemIcon>
            Verify connection
          </DropdownMenuItem>
        ) : null}

        {connection && showRecordActions ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.stopPropagation();
                onStartRename(item);
              }}
            >
              <MenuItemIcon>
                <Pencil />
              </MenuItemIcon>
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                event.stopPropagation();
                onConfigure(connection);
              }}
            >
              <MenuItemIcon>
                <Settings />
              </MenuItemIcon>
              Configure
            </DropdownMenuItem>
            {showReconnect ? (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.stopPropagation();
                  onReconnect(connection);
                }}
              >
                <MenuItemIcon>
                  <RefreshCw />
                </MenuItemIcon>
                Reconnect
              </DropdownMenuItem>
            ) : null}
            {showClone ? (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.stopPropagation();
                  onClone(connection);
                }}
              >
                <MenuItemIcon>
                  <Copy />
                </MenuItemIcon>
                Clone to workspace
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={(event) => {
                event.stopPropagation();
                onDelete(connection);
              }}
            >
              <MenuItemIcon>
                <Trash2 />
              </MenuItemIcon>
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConnectionLogo({ item }: { item: PanelItem }) {
  if (item.kind === "channel" && item.channel === "email") {
    return <Mail className="size-4" />;
  }

  const connection = panelItemConnection(item);
  if (!connection) return <Plug className="size-4" />;

  const resolvedType = resolveLogoType(connection.integration_type, [
    connection.config.display_name as string | undefined,
    connection.name,
  ]);

  if (hasIntegrationIcon(resolvedType)) {
    return <IntegrationIcon type={resolvedType} className="size-5" />;
  }

  return <Plug className="size-4" />;
}

interface ConnectionRowProps extends ConnectionActionHandlers {
  item: PanelItem;
  isSelected: boolean;
  isAdmin: boolean;
  otherWorkspacesCount: number;
  mentionSlug: string | null;
  onSelect: () => void;
  onNewChat: (item: PanelItem, mentionSlug: string) => void;
}

function handleActionClick(event: MouseEvent, action: () => void) {
  event.stopPropagation();
  action();
}

export function ConnectionRow({
  item,
  isSelected,
  isAdmin,
  otherWorkspacesCount,
  mentionSlug,
  onSelect,
  onNewChat,
  onStartRename,
  onConfigure,
  onReconnect,
  onVerify,
  onClone,
  onDelete,
  onCopyEmailAddress,
  onManageEmailSettings,
}: ConnectionRowProps) {
  const displayName = panelItemName(item);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group/row flex cursor-pointer items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-muted/50",
        isSelected && "border-foreground/20 bg-muted/70",
      )}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <ConnectionLogo item={item} />
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate text-sm">{displayName}</span>
        {item.kind === "channel" && item.channel === "email" && !item.email.inboxEnabled ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" className="shrink-0 cursor-default font-normal">
                Disabled
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top">
              Your plan does not enable email. Upgrade for access
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {mentionSlug ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Open in chat"
                onClick={(event) =>
                  handleActionClick(event, () => onNewChat(item, mentionSlug))
                }
              >
                <MessageSquare />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              Start a chat with @{mentionSlug}
            </TooltipContent>
          </Tooltip>
        ) : null}

        <ConnectionActionsMenu
          item={item}
          isAdmin={isAdmin}
          otherWorkspacesCount={otherWorkspacesCount}
          onStartRename={onStartRename}
          onConfigure={onConfigure}
          onReconnect={onReconnect}
          onVerify={onVerify}
          onClone={onClone}
          onDelete={onDelete}
          onCopyEmailAddress={onCopyEmailAddress}
          onManageEmailSettings={onManageEmailSettings}
        />
      </div>
    </div>
  );
}
