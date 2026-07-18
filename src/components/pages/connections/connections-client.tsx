"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useFetcher,
  useNavigate,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { Copy, Plus, Search, Settings, X } from "lucide-react";
import { toast } from "sonner";
import { useAuthData } from "@/hooks/use-auth-data";
import type { IntegrationDefinition } from "@/lib/integration-registry";
import { IntegrationIcon, hasIntegrationIcon } from "@/lib/integration-icons";
import { getIntegrationAuthLabel } from "@/lib/integration-auth-label";
import {
  buildSlugMap,
  filterMentionables,
  slugForMentionable,
  type MentionableProject,
} from "@/lib/mentions";
import { writeDraft } from "@/hooks/use-draft-persistence";
import {
  buildConnectionGroups,
  filterAndSortConnectionGroups,
  panelItemConnection,
  type ConnectionListItem,
  type ConnectionSort,
  type EmailChannel,
  type PanelItem,
} from "@/lib/connections-shared";
import { isCurrentWorkspacePendingAction } from "@/lib/connections-pending";
import { PageHeader } from "@/components/page-header";
import { AddConnectionDialog } from "./AddConnectionDialog";
import { ImportConnectionDialog } from "./ImportConnectionDialog";
import { EditConnectionDialog } from "./EditConnectionDialog";
import { ConnectionGroupList } from "./connection-group-list";
import { ConnectionPanel } from "./connection-panel";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AtMentionConnection, AtMentionEntity } from "@/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const categoryLabels: Record<string, string> = {
  databases: "Databases",
  saas: "SaaS",
  ai_services: "AI Services",
  cloud_providers: "Cloud Providers",
  communication: "Communication",
};

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_denied: "You denied access to the service. Please try again if you want to connect.",
  oauth_invalid: "Invalid OAuth response. Please try again.",
  oauth_state_invalid: "OAuth session expired. Please try again.",
  oauth_config: "OAuth is not configured for this service.",
  oauth_token_failed: "Failed to get access token from the service.",
  oauth_failed: "OAuth connection failed. Please try again.",
  no_workspace: "No workspace selected. Please select a workspace first.",
  unauthorized: "Please log in to connect services.",
  access_denied: "You do not have access to manage this workspace's connections.",
  admin_required: "Only organization admins can manage connections.",
};

const REMOTE_MCP_OAUTH_REASON_MESSAGES: Record<string, string> = {
  discovery_failed:
    "Remote MCP OAuth discovery failed: the server did not advertise an OAuth authorization server.",
  metadata_failed:
    "Remote MCP OAuth discovery failed: authorization server metadata could not be loaded.",
  registration_unsupported:
    "Remote MCP OAuth is not available: the authorization server does not support dynamic client registration.",
  registration_failed:
    "Remote MCP OAuth client registration failed. Check worker logs for the upstream response.",
};

const OAUTH_SUCCESS_MESSAGES: Record<string, string> = {
  slack_connected: "Successfully connected to Slack!",
  notion_connected: "Successfully connected to Notion!",
  salesforce_connected: "Successfully connected to Salesforce!",
  google_analytics_connected: "Successfully connected to Google Analytics 4!",
  remote_mcp_connected: "Successfully connected to the remote MCP server!",
};

const OAUTH_INTEGRATIONS = ["slack", "notion", "salesforce", "google_analytics"];

interface ConnectionsClientProps {
  initialConnections: ConnectionListItem[];
  initialMentionProjects: MentionableProject[];
  connectionTypes: IntegrationDefinition[];
  categories: string[];
  workspaceId: string;
  otherWorkspaces?: Array<{ id: string; name: string }>;
  workspaceEmailAddress: string | null;
  emailMentionSlug?: string | null;
  emailInboxEnabled: boolean;
  emailHandle: string | null;
  workspaceCreatedBy: string | null;
  workspaceCreatedByName?: string | null;
  workspaceCreatedByAvatar?: { color: string; content: string } | null;
  workspaceCreatedAt: number | null;
}

interface RenameState {
  id: string;
  value: string;
  original: ConnectionListItem;
}

interface PendingAction {
  intent: "clone" | "delete" | "rename";
  workspaceId: string;
  previous?: ConnectionListItem[];
  targetId?: string;
}

function oauthErrorMessage(error: string, reason: string | null): string {
  if (error === "oauth_config" && reason && REMOTE_MCP_OAUTH_REASON_MESSAGES[reason]) {
    return REMOTE_MCP_OAUTH_REASON_MESSAGES[reason];
  }
  return OAUTH_ERROR_MESSAGES[error] || `Connection failed: ${error}`;
}

function connectionAuthLabel(type: IntegrationDefinition): string {
  return getIntegrationAuthLabel(type) ?? "Setup";
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, [contenteditable='true']"));
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const updateMatches = () => setMatches(mediaQuery.matches);
    updateMatches();
    mediaQuery.addEventListener("change", updateMatches);
    return () => mediaQuery.removeEventListener("change", updateMatches);
  }, [query]);

  return matches;
}

export default function ConnectionsClient({
  initialConnections,
  initialMentionProjects,
  connectionTypes,
  categories,
  workspaceId,
  otherWorkspaces = [],
  workspaceEmailAddress,
  emailMentionSlug,
  emailInboxEnabled,
  emailHandle,
  workspaceCreatedBy,
  workspaceCreatedByName,
  workspaceCreatedByAvatar,
  workspaceCreatedAt,
}: ConnectionsClientProps) {
  const navigate = useNavigate();
  const { currentOrg, currentWorkspace, orgs } = useAuthData();
  const revalidator = useRevalidator();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [connections, setConnections] = useState(initialConnections);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customConnectionModalOpen, setCustomConnectionModalOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<ConnectionListItem | null>(null);
  const [forceCredentialUpdate, setForceCredentialUpdate] = useState(false);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionListItem | null>(null);
  const [copyTarget, setCopyTarget] = useState<ConnectionListItem | null>(null);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<ConnectionSort>("updated");
  const [pickerSearch, setPickerSearch] = useState("");
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [mounted, setMounted] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const pendingAction = useRef<PendingAction | null>(null);
  const urlSelectedId = searchParams.get("selected");
  const [activeSelectedId, setActiveSelectedId] = useState(urlSelectedId);
  const isLoading = revalidator.state === "loading" && connections.length === 0;

  const currentMembership = orgs.find((entry) => entry.org_id === currentOrg?.id);
  const isAdmin = currentMembership?.role === "owner" || currentMembership?.role === "admin";

  const emailChannel = useMemo<EmailChannel>(
    () => ({
      address: workspaceEmailAddress,
      handle: emailHandle,
      mentionSlug: emailMentionSlug ?? null,
      inboxEnabled: emailInboxEnabled,
      workspaceCreatedBy,
      workspaceCreatedByName,
      workspaceCreatedByAvatar,
      workspaceCreatedAt,
    }),
    [
      emailHandle,
      emailMentionSlug,
      emailInboxEnabled,
      workspaceCreatedAt,
      workspaceCreatedBy,
      workspaceCreatedByAvatar,
      workspaceCreatedByName,
      workspaceEmailAddress,
    ],
  );

  const allGroups = useMemo(
    () => buildConnectionGroups(connections, emailChannel),
    [connections, emailChannel],
  );
  const filteredGroups = useMemo(
    () => filterAndSortConnectionGroups(allGroups, search, sortBy),
    [allGroups, search, sortBy],
  );
  const allItems = useMemo(
    () => [...allGroups.channels, ...allGroups.connections],
    [allGroups],
  );
  const selectedItem =
    allItems.find((item) => item.id === activeSelectedId) ?? null;

  const mentionableConnections = useMemo(
    () => filterMentionables(
      connections.map((connection): AtMentionConnection => ({
        ...connection,
        kind: "connection",
      })),
    ),
    [connections],
  );
  const mentionSlugItems = useMemo<AtMentionEntity[]>(
    () => [
      ...mentionableConnections,
      ...filterMentionables(initialMentionProjects),
    ],
    [mentionableConnections, initialMentionProjects],
  );
  const mentionSlugMap = useMemo(
    () => buildSlugMap(mentionSlugItems),
    [mentionSlugItems],
  );
  const filteredConnectionTypes = useMemo(() => {
    const query = pickerSearch.trim().toLowerCase();
    if (!query) return connectionTypes;
    return connectionTypes.filter(
      (type) =>
        type.displayName.toLowerCase().includes(query) ||
        type.type.toLowerCase().includes(query),
    );
  }, [connectionTypes, pickerSearch]);

  const renameSubmitting =
    fetcher.state !== "idle" && pendingAction.current?.intent === "rename";
  const showMobileSheet = mounted && Boolean(selectedItem) && !isDesktop;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setConnections(initialConnections);
  }, [initialConnections]);

  useEffect(() => {
    setActiveSelectedId(urlSelectedId);
  }, [urlSelectedId]);

  const updateUiSearchParams = useCallback(
    (
      mutate: (next: URLSearchParams) => void,
      options?: { replace?: boolean },
    ) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          mutate(next);
          return next;
        },
        {
          replace: options?.replace,
          preventScrollReset: true,
          defaultShouldRevalidate: false,
        },
      );
    },
    [setSearchParams],
  );

  const setSelectedParam = useCallback(
    (id: string) => updateUiSearchParams((next) => next.set("selected", id)),
    [updateUiSearchParams],
  );

  const clearSelectedParam = useCallback(
    (options?: { replace?: boolean }) =>
      updateUiSearchParams((next) => next.delete("selected"), options),
    [updateUiSearchParams],
  );

  useLayoutEffect(() => {
    if (activeSelectedId && !selectedItem) {
      setActiveSelectedId(null);
      clearSelectedParam({ replace: true });
    }
  }, [activeSelectedId, selectedItem, clearSelectedParam]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && !isTypingTarget(event.target)) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Escape" && selectedItem && !renaming) {
        setActiveSelectedId(null);
        clearSelectedParam();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearSelectedParam, renaming, selectedItem]);

  useEffect(() => {
    const errorParam = searchParams.get("error");
    const reasonParam = searchParams.get("reason");
    const successParam = searchParams.get("success");

    if (errorParam) {
      toast.error(oauthErrorMessage(errorParam, reasonParam));
      updateUiSearchParams(
        (next) => {
          next.delete("error");
          next.delete("reason");
        },
        { replace: true },
      );
      return;
    }

    if (successParam) {
      toast.success(OAUTH_SUCCESS_MESSAGES[successParam] || "Connection successful!");
      updateUiSearchParams((next) => next.delete("success"), {
        replace: true,
      });
    }
  }, [searchParams, updateUiSearchParams]);

  const startReauth = useCallback(
    (connection: ConnectionListItem) => {
      window.location.href = `/api/integrations/${encodeURIComponent(connection.integration_type)}/oauth?${new URLSearchParams({
        workspace_id: currentWorkspace?.id ?? "",
        integration_id: connection.id,
        redirect: "/connections",
      }).toString()}`;
    },
    [currentWorkspace?.id],
  );

  useLayoutEffect(() => {
    const connectionId = searchParams.get("connection");
    const shouldReauth = searchParams.get("reauth") === "1";
    if (!connectionId || !shouldReauth) return;

    const connection = connections.find((item) => item.id === connectionId);
    if (!connection) return;

    if (
      connection.auth_method === "oauth2" ||
      (connection.integration_type === "remote_mcp" &&
        connection.config.auth_type === "oauth")
    ) {
      startReauth(connection);
      return;
    }

    setSelectedConnection(connection);
    setForceCredentialUpdate(true);
    setEditDialogOpen(true);

    updateUiSearchParams(
      (next) => {
        next.delete("connection");
        next.delete("reauth");
      },
      { replace: true },
    );
  }, [connections, searchParams, startReauth, updateUiSearchParams]);

  useLayoutEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const pending = pendingAction.current;
    if (!pending) return;
    pendingAction.current = null;

    if (!isCurrentWorkspacePendingAction(pending.workspaceId, workspaceId)) {
      if (revalidator.state === "idle") {
        revalidator.revalidate();
      }
      return;
    }

    if (fetcher.data.error) {
      if (pending.previous) setConnections(pending.previous);
      toast.error(fetcher.data.error);
      return;
    }

    if (fetcher.data.success) {
      if (pending.intent === "clone") toast.success("Connection cloned to workspace");
      if (pending.intent === "rename") toast.success("Connection renamed");
      if (pending.intent === "delete") toast.success("Connection deleted");
      setDeleteTarget(null);
      setCopyTarget(null);
      if (revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }
  }, [fetcher.state, fetcher.data, revalidator, workspaceId]);

  const getMentionSlug = useCallback(
    (connection: ConnectionListItem) =>
      slugForMentionable(
        { ...connection, kind: "connection" as const },
        mentionSlugMap,
      ),
    [mentionSlugMap],
  );
  const getItemMentionSlug = useCallback(
    (item: PanelItem) => {
      const connection = panelItemConnection(item);
      if (connection) return getMentionSlug(connection);
      if (item.kind === "channel" && item.channel === "email") {
        return item.email.mentionSlug?.trim() || null;
      }
      return null;
    },
    [getMentionSlug],
  );

  const handleSelect = useCallback(
    (item: PanelItem) => {
      setActiveSelectedId(item.id);
      setSelectedParam(item.id);
    },
    [setSelectedParam],
  );

  const handleClosePanel = useCallback(() => {
    setActiveSelectedId(null);
    clearSelectedParam();
    setRenaming(null);
  }, [clearSelectedParam]);

  const handleDelete = () => {
    if (!deleteTarget) return;
    const previous = connections;
    pendingAction.current = {
      intent: "delete",
      workspaceId,
      previous,
      targetId: deleteTarget.id,
    };
    setConnections((current) =>
      current.filter((connection) => connection.id !== deleteTarget.id),
    );
    if (activeSelectedId === deleteTarget.id) {
      handleClosePanel();
    }
    fetcher.submit(
      {
        intent: "deleteIntegration",
        integrationId: deleteTarget.id,
      },
      { method: "post", action: "/connections" },
    );
    setDeleteTarget(null);
  };

  const handleAddClick = (type: string) => {
    if (OAUTH_INTEGRATIONS.includes(type)) {
      window.location.href = `/api/integrations/${encodeURIComponent(type)}/oauth?redirect=/connections`;
      return;
    }

    if (type === "other") {
      setPickerOpen(false);
      setCustomConnectionModalOpen(true);
      return;
    }

    setSelectedType(type);
    setAddDialogOpen(true);
    setPickerOpen(false);
  };

  const handleCopyToWorkspace = (
    connection: ConnectionListItem,
    targetWorkspaceId: string,
  ) => {
    pendingAction.current = { intent: "clone", workspaceId };
    fetcher.submit(
      {
        intent: "duplicateIntegration",
        integrationId: connection.id,
        targetWorkspaceId,
      },
      { method: "post", action: "/connections" },
    );
    setCopyTarget(null);
  };

  const handleConfigure = (
    connection: ConnectionListItem,
    forceCredentials = false,
  ) => {
    setForceCredentialUpdate(forceCredentials);
    setSelectedConnection(connection);
    setEditDialogOpen(true);
  };

  const handleNewChat = (_item: PanelItem, mentionSlug: string) => {
    writeDraft(workspaceId, null, `@${mentionSlug} `, []);
    navigate("/chat");
  };

  const handleStartRename = (item: PanelItem) => {
    const connection = panelItemConnection(item);
    if (!connection || !isAdmin) return;
    setActiveSelectedId(item.id);
    setSelectedParam(item.id);
    setRenaming({
      id: connection.id,
      value: connection.name,
      original: connection,
    });
  };

  const handleCommitRename = () => {
    if (!renaming) return;
    if (
      pendingAction.current?.intent === "rename" &&
      pendingAction.current.targetId === renaming.id
    ) {
      return;
    }
    const name = renaming.value.trim();
    if (!name || name === renaming.original.name) {
      setRenaming(null);
      return;
    }

    const previous = connections;
    pendingAction.current = {
      intent: "rename",
      workspaceId,
      previous,
      targetId: renaming.id,
    };
    setConnections((current) =>
      current.map((connection) =>
        connection.id === renaming.id
          ? { ...connection, name, updated_at: Date.now() }
          : connection,
      ),
    );
    fetcher.submit(
      {
        intent: "updateIntegration",
        integrationId: renaming.id,
        name,
      },
      { method: "post", action: "/connections" },
    );
    setRenaming(null);
  };

  const handleAddSuccess = () => {
    setAddDialogOpen(false);
    setSelectedType(null);
    if (revalidator.state === "idle") {
      revalidator.revalidate();
    }
  };

  const handleEditSuccess = () => {
    setEditDialogOpen(false);
    setSelectedConnection(null);
    setForceCredentialUpdate(false);
    if (revalidator.state === "idle") {
      revalidator.revalidate();
    }
  };

  const handleAddDialogOpenChange = (open: boolean) => {
    setAddDialogOpen(open);
    if (!open) {
      setSelectedType(null);
    }
  };

  const handleEditDialogOpenChange = (open: boolean) => {
    setEditDialogOpen(open);
    if (!open) {
      setSelectedConnection(null);
      setForceCredentialUpdate(false);
    }
  };

  const handleCopyEmailAddress = () => {
    if (!workspaceEmailAddress) {
      toast.error("Email address is not configured");
      return;
    }
    void navigator.clipboard.writeText(workspaceEmailAddress);
    toast.success("Email address copied");
  };

  const handleManageEmailSettings = () => {
    navigate("/settings/workspace/general");
  };

  const actions = {
    onStartRename: handleStartRename,
    onConfigure: handleConfigure,
    onReconnect: startReauth,
    onClone: setCopyTarget,
    onDelete: setDeleteTarget,
    onCopyEmailAddress: handleCopyEmailAddress,
    onManageEmailSettings: handleManageEmailSettings,
  };

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0">
        <section className="flex min-w-0 flex-1 flex-col">
          <PageHeader breadcrumbs={[{ label: "Connections" }]} />
          <div className="@container min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h1 className="text-2xl font-semibold">Connections</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Connect external services so your apps can read and write data.
                    </p>
                  </div>
                  {isAdmin ? (
                    <Button onClick={() => setPickerOpen(true)} disabled={isLoading}>
                      <Plus />
                      Add connection
                    </Button>
                  ) : null}
                </div>

                <div className="mt-6 flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[220px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      ref={searchRef}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search connections..."
                      className="h-9 pl-9 pr-8"
                    />
                    {search ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-1.5 top-1/2 -translate-y-1/2"
                        aria-label="Clear search"
                        onClick={() => setSearch("")}
                      >
                        <X />
                      </Button>
                    ) : null}
                  </div>

                  <Select
                    value={sortBy}
                    onValueChange={(value) => setSortBy(value as ConnectionSort)}
                  >
                    <SelectTrigger className="w-full sm:w-[170px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="updated">Recently updated</SelectItem>
                      <SelectItem value="name">Name (A-Z)</SelectItem>
                      <SelectItem value="created">Newest first</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {isLoading ? (
                  <div className="mt-6 flex items-center justify-center py-16 text-sm text-muted-foreground">
                    Loading connections...
                  </div>
                ) : (
                  <ConnectionGroupList
                    channelItems={filteredGroups.channels}
                    connectionItems={filteredGroups.connections}
                    totalConnectionCount={connections.length}
                    selectedId={activeSelectedId}
                    isAdmin={isAdmin}
                    otherWorkspacesCount={otherWorkspaces.length}
                    searchQuery={search.trim()}
                    getMentionSlug={getItemMentionSlug}
                    onSelect={handleSelect}
                    onNewChat={handleNewChat}
                    onAddConnection={() => setPickerOpen(true)}
                    {...actions}
                  />
                )}
              </div>
            </ScrollArea>
          </div>
        </section>

        <aside
          className={cn(
            "hidden shrink-0 overflow-hidden border-l bg-background transition-[width] duration-200 ease-out lg:flex lg:flex-col",
            selectedItem ? "w-[36rem]" : "w-0",
          )}
          aria-hidden={!selectedItem}
        >
          {selectedItem ? (
            <ConnectionPanel
              item={selectedItem}
              isAdmin={isAdmin}
              otherWorkspacesCount={otherWorkspaces.length}
              mentionSlug={
                getItemMentionSlug(selectedItem)
              }
              renaming={
                renaming
                  ? { id: renaming.id, value: renaming.value }
                  : null
              }
              renameSubmitting={renameSubmitting}
              onRenameValueChange={(value) =>
                setRenaming((current) => (current ? { ...current, value } : current))
              }
              onCommitRename={handleCommitRename}
              onCancelRename={() => setRenaming(null)}
              onClose={handleClosePanel}
              onNewChat={handleNewChat}
              {...actions}
            />
          ) : null}
        </aside>
      </div>

      <Sheet
        open={showMobileSheet}
        onOpenChange={(open) => {
          if (!open) handleClosePanel();
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-[90vw] max-w-none p-0 sm:max-w-none lg:hidden"
        >
          <SheetTitle className="sr-only">Connection details</SheetTitle>
          <SheetDescription className="sr-only">
            View and manage the selected connection.
          </SheetDescription>
          {selectedItem ? (
            <ConnectionPanel
              item={selectedItem}
              isAdmin={isAdmin}
              otherWorkspacesCount={otherWorkspaces.length}
              mentionSlug={
                getItemMentionSlug(selectedItem)
              }
              renaming={
                renaming
                  ? { id: renaming.id, value: renaming.value }
                  : null
              }
              renameSubmitting={renameSubmitting}
              onRenameValueChange={(value) =>
                setRenaming((current) => (current ? { ...current, value } : current))
              }
              onCommitRename={handleCommitRename}
              onCancelRename={() => setRenaming(null)}
              onClose={handleClosePanel}
              onNewChat={handleNewChat}
              {...actions}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (!open) setPickerSearch("");
        }}
      >
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Add a connection</DialogTitle>
            <DialogDescription>
              Choose a service to connect. You&apos;ll configure credentials next.
            </DialogDescription>
          </DialogHeader>
          {connectionTypes.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">
              No connection types are available right now.
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={pickerSearch}
                  onChange={(event) => setPickerSearch(event.target.value)}
                  placeholder="Search connections..."
                  className="pl-9 pr-8"
                />
                {pickerSearch ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2"
                    aria-label="Clear search"
                    onClick={() => setPickerSearch("")}
                  >
                    <X />
                  </Button>
                ) : null}
              </div>
              <Tabs defaultValue="all" className="w-full min-w-0">
                <div className="mb-4 w-full min-w-0 overflow-x-auto overflow-y-hidden">
                  <TabsList className="w-max justify-start">
                    <TabsTrigger value="all" className="flex-none">
                      All
                    </TabsTrigger>
                    {categories.map((category) => (
                      <TabsTrigger key={category} value={category} className="flex-none">
                        {categoryLabels[category] || category}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
                <ScrollArea className="max-h-[60vh] overflow-x-hidden pr-4">
                  <div className="min-w-0 p-1">
                    <TabsContent value="all" className="mt-0">
                      <ConnectionTypeGrid
                        connectionTypes={filteredConnectionTypes}
                        onAddClick={handleAddClick}
                      />
                    </TabsContent>
                    {categories.map((category) => (
                      <TabsContent key={category} value={category} className="mt-0">
                        <ConnectionTypeGrid
                          connectionTypes={filteredConnectionTypes.filter(
                            (type) => type.category === category,
                          )}
                          onAddClick={handleAddClick}
                        />
                      </TabsContent>
                    ))}
                  </div>
                </ScrollArea>
              </Tabs>
            </>
          )}
        </DialogContent>
      </Dialog>

      {selectedType ? (
        <AddConnectionDialog
          open={addDialogOpen}
          onOpenChange={handleAddDialogOpenChange}
          connectionType={selectedType}
          connectionTypes={connectionTypes}
          onSuccess={handleAddSuccess}
        />
      ) : null}

      {selectedConnection ? (
        <EditConnectionDialog
          open={editDialogOpen}
          onOpenChange={handleEditDialogOpenChange}
          connection={selectedConnection}
          connectionTypes={connectionTypes}
          forceCredentialUpdate={forceCredentialUpdate}
          onSuccess={handleEditSuccess}
        />
      ) : null}

      <ImportConnectionDialog
        open={customConnectionModalOpen}
        onOpenChange={setCustomConnectionModalOpen}
        onSuccess={() => {
          setCustomConnectionModalOpen(false);
          if (revalidator.state === "idle") revalidator.revalidate();
        }}
        onGenericFallback={() => {
          setSelectedType("other");
          setAddDialogOpen(true);
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete connection?"
        description={
          deleteTarget
            ? `Are you sure you want to delete "${deleteTarget.name}"? This action cannot be undone.`
            : "Are you sure you want to delete this connection?"
        }
        confirmLabel="Delete connection"
        variant="destructive"
        onConfirm={handleDelete}
      />

      <Dialog
        open={Boolean(copyTarget)}
        onOpenChange={(open) => {
          if (!open) setCopyTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clone connection</DialogTitle>
            <DialogDescription>
              Clone &ldquo;{copyTarget?.name}&rdquo; to another workspace in this organization.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {otherWorkspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                className="flex w-full items-center justify-between rounded-md border p-3 text-sm transition-colors hover:bg-accent"
                onClick={() => {
                  if (copyTarget) {
                    handleCopyToWorkspace(copyTarget, workspace.id);
                  }
                }}
              >
                <span className="font-medium">{workspace.name}</span>
                <Copy className="size-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

function ConnectionTypeGrid({
  connectionTypes,
  onAddClick,
}: {
  connectionTypes: IntegrationDefinition[];
  onAddClick: (type: string) => void;
}) {
  if (connectionTypes.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        No integrations found
      </div>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {connectionTypes.map((type) => {
        const hasIcon = hasIntegrationIcon(type.type);
        return (
          <button
            key={type.type}
            type="button"
            onClick={() => onAddClick(type.type)}
            className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent"
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
              {hasIcon ? (
                <IntegrationIcon type={type.type} className="size-5" />
              ) : (
                <Settings className="size-5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{type.displayName}</div>
              <div className="text-xs text-muted-foreground">
                {connectionAuthLabel(type)}
              </div>
            </div>
            <Plus className="size-4 shrink-0 text-muted-foreground" />
          </button>
        );
      })}
    </div>
  );
}
