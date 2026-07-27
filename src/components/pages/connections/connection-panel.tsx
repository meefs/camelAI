"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFetcher } from "react-router";
import {
  Copy,
  ExternalLink,
  Hash,
  Inbox,
  Lock,
  Mail,
  MessageSquare,
  Plug,
  Settings,
  ShieldCheck,
  ShieldAlert,
  TriangleAlert,
  RefreshCw,
  Unplug,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IntegrationIcon, hasIntegrationIcon, resolveLogoType } from "@/lib/integration-icons";
import { generateDefaultAvatar, getContrastTextColor } from "@/lib/avatar";
import { HYDRATION_SAFE_LOCALE } from "@/lib/hydration-safe-datetime";
import { buildTelegramDeepLink, TELEGRAM_SETUP_TTL_SECONDS } from "@/lib/telegram-channel";
import {
  DISCORD_BOT_MENTION,
  TYPE_COPY,
  DISCORD_STATUS_LABELS,
  connectionRequiresOutboundIpAllowlist,
  getConnectionDetailRows,
  getDiscordChannelBlockReason,
  getDiscordChannelMetadata,
  getSlackChannelMetadata,
  panelItemConnection,
  panelItemName,
  type ConnectionListItem,
  type PanelItem,
} from "@/lib/connections-shared";
import { cn } from "@/lib/utils";
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

const ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat(HYDRATION_SAFE_LOCALE, {
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
  title = "Use in chat",
}: {
  mentionSlug: string;
  onOpen: () => void;
  title?: string;
}) {
  return (
    <Section title={title}>
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

function DiscordUsage({ connection }: { connection: ConnectionListItem }) {
  const metadata = getDiscordChannelMetadata(connection);
  const channelName = formatValue(metadata.parent_channel_name);
  const mentionOnly = metadata.message_content_mode === "mention_only";

  return (
    <Section title="Use in Discord">
      <div className="space-y-3">
        <dl className="space-y-2">
          <DetailRow label="Mention">
            <span className="flex min-w-0 items-center justify-end gap-1.5">
              <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs">
                {DISCORD_BOT_MENTION}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Copy Discord mention"
                onClick={() => copyText(DISCORD_BOT_MENTION, "Mention")}
              >
                <Copy />
              </Button>
            </span>
          </DetailRow>
        </dl>
        <p className="text-sm text-muted-foreground">
          {mentionOnly ? (
            <>
              Mention {DISCORD_BOT_MENTION} in #{channelName} to start a thread.
              Mention-only mode is on, so every follow-up must also mention{" "}
              {DISCORD_BOT_MENTION}.
            </>
          ) : (
            <>
              Mention {DISCORD_BOT_MENTION} in #{channelName} to start a thread.
              Camel replies in a thread and follows it — no mention needed on
              follow-ups.
            </>
          )}
        </p>
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
            ? connection.integration_type === "discord_channel" &&
                connection.config.message_content_mode === "mention_only"
              ? "Mention-only"
              : "Unavailable"
            : "Not verified";
  return (
    <Section
      title="Status & housekeeping"
      action={
        canManage && connection.integration_type !== "discord_channel" ? (
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

interface DiscordSetupChannel {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  missingPermissions: string[];
  canActivate: boolean;
  exposure: "restricted" | "visible_to_everyone";
}

interface DiscordSetupActionData {
  success?: boolean;
  error?: string;
  warning?: string;
  returnTo?: string;
  discordSetup?: {
    integrationId: string;
    guild: { id: string; name: string };
    channels: DiscordSetupChannel[];
  };
}

function DiscordDestination({
  connection,
  canManage,
}: {
  connection: ConnectionListItem;
  canManage: boolean;
}) {
  const fetcher = useFetcher<DiscordSetupActionData>();
  const metadata = getDiscordChannelMetadata(connection);
  const active = metadata.status === "active";
  const [selecting, setSelecting] = useState(false);
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState(
    metadata.parent_channel_id || "",
  );
  const [acknowledged, setAcknowledged] = useState(
    typeof connection.config.security_acknowledged_at === "number",
  );
  const setup = fetcher.data?.discordSetup?.integrationId === connection.id
    ? fetcher.data.discordSetup
    : null;
  const channels = setup?.channels || [];
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const showSelector = canManage && (!active || selecting);
  const busy = fetcher.state !== "idle";
  const activating =
    busy && fetcher.formData?.get("intent") === "discordActivateChannel";
  const autoLoadAttempted = useRef<string | null>(null);
  const guildName = formatValue(metadata.guild_name);
  const parentChannelName = formatValue(metadata.parent_channel_name);
  const reinstallHref = `/api/integrations/discord/oauth?${new URLSearchParams({
    integration_id: connection.id,
    redirect: "/connections",
  }).toString()}`;
  const statusLabel = metadata.status
    ? DISCORD_STATUS_LABELS[metadata.status] ?? metadata.status
    : "Not available";
  const setupSubtitle =
    metadata.error_code === "guild_removed"
      ? "Camel is no longer in this server. Reinstall the bot to reconnect."
      : metadata.status === "disconnected"
        ? "Camel is installed but not connected to a channel. Pick a channel to reconnect."
        : metadata.status === "setup_error"
          ? "Setup didn't finish. Pick a channel to try again."
          : "Camel joined this server. Pick a channel to finish setup.";
  const blockedChannelCount = channels.filter(
    (channel) => getDiscordChannelBlockReason(channel) !== null,
  ).length;
  const channelGroups = useMemo(() => {
    const uncategorized: DiscordSetupChannel[] = [];
    const categorized = new Map<
      string,
      { heading: string; channels: DiscordSetupChannel[] }
    >();

    for (const channel of channels) {
      if (!channel.categoryId && !channel.categoryName) {
        uncategorized.push(channel);
        continue;
      }
      const key = channel.categoryId ?? channel.categoryName ?? "";
      const existing = categorized.get(key);
      if (existing) {
        existing.channels.push(channel);
      } else {
        categorized.set(key, {
          heading: channel.categoryName ?? "Other",
          channels: [channel],
        });
      }
    }

    return [
      ...(uncategorized.length
        ? [{ key: "uncategorized", heading: undefined, channels: uncategorized }]
        : []),
      ...Array.from(categorized, ([key, group]) => ({ key, ...group })),
    ];
  }, [channels]);

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.success &&
      !fetcher.data.error &&
      !fetcher.data.discordSetup
    ) {
      if (
        fetcher.data.returnTo?.startsWith("/") &&
        !fetcher.data.returnTo.startsWith("//")
      ) {
        window.location.assign(fetcher.data.returnTo);
        return;
      }
      setSelecting(false);
      setAcknowledged(false);
    }
  }, [fetcher.data, fetcher.state]);

  useEffect(() => {
    autoLoadAttempted.current = null;
    setSelecting(false);
    setSelectedChannelId(metadata.parent_channel_id || "");
    setAcknowledged(
      typeof connection.config.security_acknowledged_at === "number",
    );
  }, [
    connection.id,
    connection.config.security_acknowledged_at,
    metadata.parent_channel_id,
  ]);

  const loadChannels = useCallback(() => {
    autoLoadAttempted.current = connection.id;
    fetcher.submit(
      { intent: "discordListChannels", integrationId: connection.id },
      { method: "post", action: "/connections" },
    );
  }, [connection.id, fetcher]);

  useEffect(() => {
    if (
      !showSelector ||
      setup ||
      fetcher.data?.error ||
      fetcher.state !== "idle" ||
      autoLoadAttempted.current === connection.id
    ) {
      return;
    }
    loadChannels();
  }, [
    connection.id,
    fetcher.data?.error,
    fetcher.state,
    loadChannels,
    setup,
    showSelector,
  ]);

  const disconnect = () => {
    fetcher.submit(
      { intent: "discordDisconnect", integrationId: connection.id },
      { method: "post", action: "/connections" },
    );
  };

  const heading = (
    <div>
      <p className="break-words text-lg font-semibold text-foreground">
        {guildName}
      </p>
      {active ? (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            #{parentChannelName}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Messages from this Discord channel start threads here.
          </p>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">{setupSubtitle}</p>
      )}
    </div>
  );

  const lifecycleAlert = !active && metadata.error_code ? (
    <Alert>
      <TriangleAlert />
      {metadata.error_code === "guild_removed" ? (
        <>
          <AlertTitle>Camel was removed from this server</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Someone removed the Camel bot from {guildName}. Reinstall the bot,
              then pick a channel to reconnect.
            </p>
            <Button variant="outline" size="sm" asChild>
              <a href={reinstallHref}>Reinstall Camel bot</a>
            </Button>
          </AlertDescription>
        </>
      ) : metadata.error_code === "parent_channel_deleted" ? (
        <>
          <AlertTitle>The connected channel was deleted</AlertTitle>
          <AlertDescription>
            #{metadata.parent_channel_name ?? "The channel"} no longer exists in
            Discord. Pick a new channel to reconnect.
          </AlertDescription>
        </>
      ) : null}
    </Alert>
  ) : null;

  const securityAlert = (
    <Alert variant="destructive">
      <ShieldAlert />
      <AlertTitle>Discord members can instruct this workspace</AlertTitle>
      <AlertDescription>
        Anyone who can post in the selected channel can use this workspace&apos;s
        files, connected services, credits, and deploy permissions. Use a private
        or appropriately restricted channel.
      </AlertDescription>
    </Alert>
  );

  const channelPicker = showSelector ? (
    <div className="rounded-md border bg-muted/20 p-3">
      <fetcher.Form method="post" action="/connections" className="space-y-3">
        <input type="hidden" name="intent" value="discordActivateChannel" />
        <input type="hidden" name="integrationId" value={connection.id} />
        <input type="hidden" name="parentChannelId" value={selectedChannelId} />
        <input
          type="hidden"
          name="securityAcknowledged"
          value={acknowledged ? "true" : "false"}
        />

        <div className="flex items-center justify-between gap-2">
          <Label
            htmlFor={
              channels.length > 7
                ? `discord-channel-filter-${connection.id}`
                : undefined
            }
          >
            Channel
          </Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={loadChannels}
                aria-label="Reload channel list"
              >
                <RefreshCw className={busy ? "animate-spin" : undefined} />
                Reload
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-72">
              Fetch the channel list from Discord again — use this after creating a
              channel or changing permissions there.
            </TooltipContent>
          </Tooltip>
        </div>

        {fetcher.data?.error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription className="space-y-3">
              <p>{fetcher.data.error}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={loadChannels}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : setup ? (
          channels.length ? (
            <Command className="rounded-md border bg-background">
              {channels.length > 7 ? (
                <CommandInput
                  id={`discord-channel-filter-${connection.id}`}
                  placeholder="Filter channels…"
                />
              ) : null}
              <CommandList className="max-h-64">
                <CommandEmpty>No channels match.</CommandEmpty>
                {channelGroups.map((group) => (
                  <CommandGroup key={group.key} heading={group.heading}>
                    {group.channels.map((channel) => {
                      const selected = channel.id === selectedChannelId;
                      const blockReason = getDiscordChannelBlockReason(channel);
                      const ExposureIcon =
                        channel.exposure === "restricted" ? Lock : Hash;
                      return (
                        <CommandItem
                          key={channel.id}
                          value={`${channel.name} ${channel.id}`}
                          keywords={[channel.categoryName ?? ""]}
                          disabled={Boolean(blockReason)}
                          onSelect={() => setSelectedChannelId(channel.id)}
                          className="data-[disabled=true]:opacity-100 [&>svg:last-child]:hidden"
                        >
                          <span
                            data-checked={selected}
                            className={cn(
                              "size-3.5 shrink-0 rounded-full border",
                              selected && "border-4 border-primary",
                            )}
                          />
                          <ExposureIcon className="size-3.5 text-muted-foreground" />
                          <div className="flex min-w-0 flex-1 flex-col">
                            <div className="flex min-w-0 items-center gap-2">
                              <span
                                className={cn(
                                  "min-w-0 flex-1 truncate",
                                  blockReason && "text-muted-foreground",
                                )}
                              >
                                {channel.name}
                              </span>
                              {channel.exposure === "visible_to_everyone" ? (
                                <Badge
                                  variant="outline"
                                  className="shrink-0 border-amber-500/50 font-normal text-amber-700 dark:text-amber-300"
                                >
                                  @everyone can post
                                </Badge>
                              ) : null}
                            </div>
                            {blockReason ? (
                              <span className="text-xs text-muted-foreground">
                                {blockReason.kind === "no_access"
                                  ? "Camel can't see this channel"
                                  : `Camel is missing: ${blockReason.label}`}
                              </span>
                            ) : null}
                          </div>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No standard text channels found in this server.
            </p>
          )
        ) : (
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        )}

        {fetcher.data?.warning ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {fetcher.data.warning}
          </p>
        ) : null}

        {setup && blockedChannelCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            Grayed-out channels need access granted in Discord: open the
            channel&apos;s settings → Permissions → add the Camel bot (or its role),
            then reload the list. Only standard text channels can be connected.
          </p>
        ) : null}

        {setup ? (
          <>
            {selectedChannel?.exposure === "visible_to_everyone" ? (
              <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                This channel is visible and writable by @everyone. Restrict Discord
                roles before connecting if that is not intentional.
              </p>
            ) : null}
            <div className="flex items-start gap-2">
              <Checkbox
                id={`discord-security-${connection.id}`}
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <Label
                htmlFor={`discord-security-${connection.id}`}
                className="text-xs font-normal leading-5"
              >
                I understand that people who can post here can instruct Camel with
                this workspace&apos;s authority.
              </Label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={
                  busy || !selectedChannel?.canActivate || !acknowledged
                }
              >
                {activating
                  ? "Connecting…"
                  : active
                    ? "Change channel"
                    : "Connect channel"}
              </Button>
              {active ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setSelecting(false)}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </fetcher.Form>
    </div>
  ) : null;

  const detailRows = (
    <dl className="space-y-2">
      <DetailRow label="Status">
        <Badge variant={active ? "default" : "secondary"} className="font-normal">
          {statusLabel}
        </Badge>
      </DetailRow>
      <DetailRow label="Content mode">
        {metadata.message_content_mode === "mention_only"
          ? "Mention every message"
          : "Mention once"}
      </DetailRow>
    </dl>
  );

  return (
    <Section title="Destination & identity">
      <div className="space-y-4">
        {heading}

        {!active ? lifecycleAlert : null}

        {!active && !canManage ? (
          <p className="text-sm text-muted-foreground">
            An organization admin needs to finish this setup.
          </p>
        ) : null}

        {showSelector ? securityAlert : null}
        {showSelector ? channelPicker : null}

        {active && !selecting ? (
          <>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              Anyone who can post in #{parentChannelName} can instruct Camel with
              this workspace&apos;s authority.
            </p>

            {metadata.message_content_mode === "mention_only" ? (
              <Alert>
                <AlertTitle>Mention-only mode</AlertTitle>
                <AlertDescription>
                  Every message, including follow-ups in Camel-created threads, must
                  mention @Camel.
                </AlertDescription>
              </Alert>
            ) : null}

            {canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setSelecting(true);
                    loadChannels();
                  }}
                >
                  <RefreshCw />
                  Change channel
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="outline" asChild>
                      <a href={reinstallHref}>
                        <Wrench />
                        Reinstall bot
                      </a>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-72">
                    Runs the Discord authorization again to restore Camel&apos;s bot
                    role and permissions in {guildName}. Use it if Camel was removed
                    from the server, stopped responding, or channels won&apos;t load.
                    You&apos;ll pick the channel again afterward.
                  </TooltipContent>
                </Tooltip>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDisconnectConfirmOpen(true)}
                >
                  <Unplug />
                  Disconnect
                </Button>
              </div>
            ) : null}
          </>
        ) : null}

        {detailRows}
      </div>

      <ConfirmDialog
        open={disconnectConfirmOpen}
        onOpenChange={setDisconnectConfirmOpen}
        title="Disconnect Discord channel?"
        description={`Camel will stop responding in #${parentChannelName}. The bot stays in ${guildName}, and you can connect a channel again anytime.`}
        confirmLabel="Disconnect"
        variant="destructive"
        onConfirm={disconnect}
      />
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
            title="Use in camelAI chat"
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
      ) : item.channel === "discord_channel" ? (
        <DiscordDestination connection={connection} canManage={canManage} />
      ) : (
        <TelegramDestination connection={connection} />
      )}
      {item.channel === "discord_channel" &&
      getDiscordChannelMetadata(connection).status === "active" ? (
        <DiscordUsage connection={connection} />
      ) : null}
      {mentionSlug ? (
        <UseInChatBlock
          mentionSlug={mentionSlug}
          onOpen={() => onNewChat(item, mentionSlug)}
          title="Use in camelAI chat"
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
