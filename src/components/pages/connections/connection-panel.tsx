"use client";

import type { ReactNode } from "react";
import {
  Copy,
  ExternalLink,
  Inbox,
  Mail,
  MessageSquare,
  Plug,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IntegrationIcon, hasIntegrationIcon, resolveLogoType } from "@/lib/integration-icons";
import { generateDefaultAvatar, getContrastTextColor } from "@/lib/avatar";
import { buildTelegramDeepLink, TELEGRAM_SETUP_TTL_SECONDS } from "@/lib/telegram-channel";
import {
  TYPE_COPY,
  connectionRequiresOutboundIpAllowlist,
  getConnectionDetailRows,
  getSlackChannelMetadata,
  panelItemConnection,
  panelItemName,
  type ConnectionListItem,
  type PanelItem,
} from "@/lib/connections-shared";
import {
  SANDBOX_NETWORK_DOCS_URL,
  SANDBOX_OUTBOUND_IP,
} from "@/lib/sandbox-network";
import { ConnectionActionsMenu, type ConnectionActionHandlers } from "./connection-row";

interface RenameState {
  id: string;
  value: string;
}

interface ConnectionPanelProps extends ConnectionActionHandlers {
  item: PanelItem;
  isAdmin: boolean;
  otherWorkspacesCount: number;
  mentionSlug: string | null;
  renaming: RenameState | null;
  renameSubmitting: boolean;
  onRenameValueChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onClose: () => void;
  onNewChat: (item: PanelItem, mentionSlug: string) => void;
}

const ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

function formatAbsoluteTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "Never";
  return ABSOLUTE_TIME_FORMATTER.format(new Date(timestamp));
}

function formatValue(value: string | null | undefined): string {
  return value?.trim() || "Not available";
}

function copyText(value: string, label: string) {
  void navigator.clipboard.writeText(value);
  toast.success(`${label} copied`);
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-foreground">{children}</dd>
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function CreatedBy({
  id,
  name,
  avatar,
}: {
  id: string | null | undefined;
  name?: string | null;
  avatar?: { color: string; content: string } | null;
}) {
  const label = name || id || "Unknown";
  const displayAvatar = avatar ?? generateDefaultAvatar(label);
  return (
    <span className="flex min-w-0 items-center justify-end gap-1.5">
      <Avatar size="xs">
        <AvatarFallback
          content={displayAvatar.content}
          style={{
            backgroundColor: displayAvatar.color,
            color: getContrastTextColor(displayAvatar.color),
          }}
        >
          {displayAvatar.content}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

function ConnectionTypeTag({ isChannel }: { isChannel: boolean }) {
  const Icon = isChannel ? Inbox : Plug;
  const label = isChannel ? "Channel" : "Connection";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-2.5 py-1 text-xs font-normal text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        {TYPE_COPY[isChannel ? "channel" : "connection"]}
      </TooltipContent>
    </Tooltip>
  );
}

function PanelLogo({ item }: { item: PanelItem }) {
  if (item.kind === "channel" && item.channel === "email") {
    return <Mail className="size-5" />;
  }
  const connection = panelItemConnection(item);
  if (!connection) return <Plug className="size-5" />;
  const resolvedType = resolveLogoType(connection.integration_type, [
    connection.config.display_name as string | undefined,
    connection.name,
  ]);
  if (hasIntegrationIcon(resolvedType)) {
    return <IntegrationIcon type={resolvedType} className="size-5" />;
  }
  return <Plug className="size-5" />;
}

function UseInChatBlock({
  mentionSlug,
  onOpen,
}: {
  mentionSlug: string;
  onOpen: () => void;
}) {
  return (
    <Section title="Use in chat">
      <div className="space-y-3">
        <dl className="space-y-2">
          <DetailRow label="Mention">
            <span className="flex min-w-0 items-center justify-end gap-1.5">
              <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs">
                @{mentionSlug}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Copy mention"
                onClick={() => copyText(`@${mentionSlug}`, "Mention")}
              >
                <Copy />
              </Button>
            </span>
          </DetailRow>
        </dl>
        <Button type="button" variant="outline" onClick={onOpen}>
          <MessageSquare />
          Open in chat
        </Button>
      </div>
    </Section>
  );
}

function AllowlistCallout() {
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm">
      <p className="text-muted-foreground">
        Allowlist the sandbox outbound IP if this service restricts network access.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="rounded bg-background px-2 py-1 text-xs">
          {SANDBOX_OUTBOUND_IP}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => copyText(SANDBOX_OUTBOUND_IP, "Outbound IP")}
        >
          <Copy />
          Copy
        </Button>
        <Button type="button" variant="ghost" size="sm" asChild>
          <a href={SANDBOX_NETWORK_DOCS_URL} target="_blank" rel="noreferrer">
            <ExternalLink />
            Network docs
          </a>
        </Button>
      </div>
    </div>
  );
}

function ConnectionDetails({ connection }: { connection: ConnectionListItem }) {
  const detailRows = [
    ...getConnectionDetailRows(connection),
    ...(connection.definitionMetadata
      ? [
          { label: "Definition", value: connection.definitionMetadata.source },
          { label: "Typed operations", value: String(connection.definitionMetadata.operationCount) },
          { label: "Generic fetch", value: connection.definitionMetadata.genericFetch ? "Available" : "Unavailable" },
        ]
      : []),
  ];
  const needsAllowlist = connectionRequiresOutboundIpAllowlist(connection);
  if (detailRows.length === 0 && !needsAllowlist) return null;

  return (
    <Section title="Connection details">
      <div className="space-y-4">
        {detailRows.length > 0 ? (
          <dl className="space-y-2">
            {detailRows.map((row) => (
              <DetailRow key={`${row.label}:${row.value}`} label={row.label}>
                <span className="break-words">{row.value}</span>
              </DetailRow>
            ))}
          </dl>
        ) : null}
        {needsAllowlist ? <AllowlistCallout /> : null}
      </div>
    </Section>
  );
}

function StatusAndHousekeeping({
  connection,
  canManage,
  onConfigure,
  onVerify,
}: {
  connection: ConnectionListItem;
  canManage: boolean;
  onConfigure: (connection: ConnectionListItem, forceCredentialUpdate?: boolean) => void;
  onVerify: (connection: ConnectionListItem) => void;
}) {
  const verification = connection.verification;
  const statusLabel = verification?.status === "ready"
    ? "Ready"
    : verification?.status === "configured"
      ? "Configured"
      : verification?.status === "needs_authorization"
        ? "Needs authorization"
        : verification?.status === "misconfigured"
          ? "Needs setup"
          : verification?.status === "degraded"
            ? "Unavailable"
            : "Not verified";
  return (
    <Section
      title="Status & housekeeping"
      action={
        canManage ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Configure connection"
                onClick={() => onConfigure(connection)}
              >
                <Settings />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Configure</TooltipContent>
          </Tooltip>
        ) : null
      }
    >
      <dl className="space-y-2">
        <DetailRow label="Health">
          <span className="inline-flex items-center justify-end gap-2">
            <Badge
              variant={verification?.status === "ready" ? "default" : "secondary"}
              className="font-normal"
            >
              {statusLabel}
            </Badge>
            <Button type="button" variant="ghost" size="sm" onClick={() => onVerify(connection)}>
              <ShieldCheck />
              Verify
            </Button>
          </span>
        </DetailRow>
        <DetailRow label="Last verified">
          {formatAbsoluteTime(verification?.checkedAt)}
        </DetailRow>
        <DetailRow label="Check type">
          {connection.contract?.verification.live ? "Live provider check" : "Configuration check"}
        </DetailRow>
        <DetailRow label="Added by">
          <CreatedBy
            id={connection.created_by}
            name={connection.created_by_name}
            avatar={connection.created_by_avatar}
          />
        </DetailRow>
        <DetailRow label="Added on">
          {formatAbsoluteTime(connection.created_at)}
        </DetailRow>
        <DetailRow label="Last edited">
          {formatAbsoluteTime(connection.updated_at)}
        </DetailRow>
      </dl>
    </Section>
  );
}

function ConnectionBody({
  item,
  mentionSlug,
  canManage,
  onNewChat,
  onConfigure,
  onVerify,
}: {
  item: Extract<PanelItem, { kind: "connection" }>;
  mentionSlug: string | null;
  canManage: boolean;
  onNewChat: (item: PanelItem, mentionSlug: string) => void;
  onConfigure: (connection: ConnectionListItem, forceCredentialUpdate?: boolean) => void;
  onVerify: (connection: ConnectionListItem) => void;
}) {
  const { connection } = item;
  return (
    <>
      {mentionSlug ? (
        <UseInChatBlock
          mentionSlug={mentionSlug}
          onOpen={() => onNewChat(item, mentionSlug)}
        />
      ) : null}
      <ConnectionDetails connection={connection} />
      <StatusAndHousekeeping
        connection={connection}
        canManage={canManage}
        onConfigure={onConfigure}
        onVerify={onVerify}
      />
    </>
  );
}

function SlackDestination({ connection }: { connection: ConnectionListItem }) {
  const metadata = getSlackChannelMetadata(connection);
  return (
    <Section title="Destination & identity">
      <div className="space-y-3">
        <div>
          <p className="break-words text-lg font-semibold text-foreground">
            {formatValue(metadata.team_name)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Messages from this Slack workspace start threads here.
          </p>
        </div>
        <dl className="space-y-2">
          <DetailRow label="Bot user">{formatValue(metadata.bot_user_id)}</DetailRow>
        </dl>
      </div>
    </Section>
  );
}

function EmailDestination({ item }: { item: Extract<PanelItem, { channel: "email" }> }) {
  const { email } = item;
  return (
    <Section title="Destination & identity">
      <div className="space-y-3">
        <div>
          {email.address ? (
            <div className="flex min-w-0 items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-lg font-semibold text-foreground">
                {email.address}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Copy email address"
                onClick={() => copyText(email.address!, "Email address")}
              >
                <Copy />
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Email isn&apos;t configured for this workspace yet.
            </p>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            Access this workspace via email. Emails to this address start a thread in this workspace. Only members of this workspace can send emails to this address.
          </p>
        </div>
        {!email.inboxEnabled ? (
          <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            This workspace does not have access to email. Upgrade your plan to use this email address.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function TelegramDestination({ connection }: { connection: ConnectionListItem }) {
  const config = connection.config;
  const status = typeof config.status === "string" ? config.status : null;
  const botUsername =
    typeof config.bot_username === "string" ? config.bot_username : null;
  const setupToken =
    typeof config.setup_token === "string" ? config.setup_token : null;
  const setupExpiresAt =
    typeof config.setup_expires_at === "number" ? config.setup_expires_at : null;

  if (status === "pending" && botUsername && setupToken) {
    const deepLink = buildTelegramDeepLink(botUsername, setupToken);
    const minutesLeft = setupExpiresAt
      ? Math.max(0, Math.ceil((setupExpiresAt - Date.now()) / 60_000))
      : Math.ceil(TELEGRAM_SETUP_TTL_SECONDS / 60);
    return (
      <Section title="Destination & identity">
        <div className="space-y-3">
          <div>
            <div className="flex min-w-0 items-center gap-2">
              <a
                href={deepLink}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-lg font-semibold text-primary hover:underline"
              >
                Open Telegram setup
              </a>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Copy Telegram setup link"
                onClick={() => copyText(deepLink, "Telegram setup link")}
              >
                <Copy />
              </Button>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Setup link expires in {minutesLeft} min.
            </p>
          </div>
          <dl className="space-y-2">
            <DetailRow label="Bot">@{botUsername}</DetailRow>
            <DetailRow label="Status">Pending setup</DetailRow>
          </dl>
        </div>
      </Section>
    );
  }

  const chatTitle =
    typeof config.chat_title === "string" ? config.chat_title : "Telegram chat";
  const chatType = typeof config.chat_type === "string" ? config.chat_type : null;
  const connectedAt =
    typeof config.connected_at === "number" ? config.connected_at : null;

  return (
    <Section title="Destination & identity">
      <div className="space-y-3">
        <div>
          <p className="break-words text-lg font-semibold text-foreground">{chatTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Messages from this Telegram chat start threads here.
          </p>
        </div>
        <dl className="space-y-2">
          <DetailRow label="Chat type">{formatValue(chatType)}</DetailRow>
          <DetailRow label="Bot">{botUsername ? `@${botUsername}` : "Not available"}</DetailRow>
          <DetailRow label="Connected">{formatAbsoluteTime(connectedAt)}</DetailRow>
        </dl>
      </div>
    </Section>
  );
}

function EmailHousekeeping({
  item,
  onManageEmailSettings,
}: {
  item: Extract<PanelItem, { channel: "email" }>;
  onManageEmailSettings: () => void;
}) {
  const { email } = item;
  return (
    <Section title="Status & housekeeping">
      <dl className="space-y-2">
        <DetailRow label="Handle">{formatValue(email.handle)}</DetailRow>
        <DetailRow label="Settings">
          <Button type="button" variant="ghost" size="sm" onClick={onManageEmailSettings}>
            Manage email settings
          </Button>
        </DetailRow>
      </dl>
    </Section>
  );
}

function ChannelBody({
  item,
  mentionSlug,
  canManage,
  onNewChat,
  onConfigure,
  onManageEmailSettings,
  onVerify,
}: {
  item: Extract<PanelItem, { kind: "channel" }>;
  mentionSlug: string | null;
  canManage: boolean;
  onNewChat: (item: PanelItem, mentionSlug: string) => void;
  onConfigure: (connection: ConnectionListItem, forceCredentialUpdate?: boolean) => void;
  onManageEmailSettings: () => void;
  onVerify: (connection: ConnectionListItem) => void;
}) {
  if (item.channel === "email") {
    return (
      <>
        <EmailDestination item={item} />
        {mentionSlug ? (
          <UseInChatBlock
            mentionSlug={mentionSlug}
            onOpen={() => onNewChat(item, mentionSlug)}
          />
        ) : null}
        <EmailHousekeeping item={item} onManageEmailSettings={onManageEmailSettings} />
      </>
    );
  }

  const connection = item.connection;
  return (
    <>
      {item.channel === "slack" ? (
        <SlackDestination connection={connection} />
      ) : (
        <TelegramDestination connection={connection} />
      )}
      {mentionSlug ? (
        <UseInChatBlock
          mentionSlug={mentionSlug}
          onOpen={() => onNewChat(item, mentionSlug)}
        />
      ) : null}
      <StatusAndHousekeeping
        connection={connection}
        canManage={canManage}
        onConfigure={onConfigure}
        onVerify={onVerify}
      />
    </>
  );
}

export function ConnectionPanel({
  item,
  isAdmin,
  otherWorkspacesCount,
  mentionSlug,
  renaming,
  renameSubmitting,
  onRenameValueChange,
  onCommitRename,
  onCancelRename,
  onClose,
  onNewChat,
  onStartRename,
  onConfigure,
  onReconnect,
  onVerify,
  onClone,
  onDelete,
  onCopyEmailAddress,
  onManageEmailSettings,
}: ConnectionPanelProps) {
  const connection = panelItemConnection(item);
  const displayName = panelItemName(item);
  const isChannel = item.kind === "channel";
  const isRenaming = Boolean(connection && renaming?.id === connection.id);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between gap-3 px-6 py-5">
        <ConnectionTypeTag isChannel={isChannel} />
        <div className="flex items-center gap-1">
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
          <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
      </div>

      <ScrollArea
        className="min-h-0 flex-1"
        viewportClassName="[&>div]:!block [&>div]:!w-full"
      >
        <div className="space-y-7 px-6 py-6">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                <PanelLogo item={item} />
              </div>
              {isRenaming ? (
                <Input
                  autoFocus
                  value={renaming?.value ?? displayName}
                  disabled={renameSubmitting}
                  className="h-9 min-w-0 flex-1 text-lg font-semibold"
                  onChange={(event) => onRenameValueChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onCommitRename();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      onCancelRename();
                    }
                  }}
                  onBlur={onCommitRename}
                />
              ) : (
                <h2
                  title={displayName}
                  className="min-w-0 flex-1 truncate text-2xl font-semibold leading-tight text-foreground"
                >
                  {displayName}
                </h2>
              )}
              {item.kind === "channel" && item.channel === "email" && !item.email.inboxEnabled ? (
                <Badge variant="secondary" className="shrink-0 font-normal">
                  Disabled
                </Badge>
              ) : null}
            </div>
            {connection && !connection.has_credentials ? (
              <Badge variant="secondary">Setup incomplete</Badge>
            ) : null}
          </div>

          {item.kind === "connection" ? (
            <ConnectionBody
              item={item}
              mentionSlug={mentionSlug}
              canManage={isAdmin}
              onNewChat={onNewChat}
              onConfigure={onConfigure}
              onVerify={onVerify}
            />
          ) : (
            <ChannelBody
              item={item}
              mentionSlug={mentionSlug}
              canManage={isAdmin}
              onNewChat={onNewChat}
              onConfigure={onConfigure}
              onVerify={onVerify}
              onManageEmailSettings={onManageEmailSettings}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
