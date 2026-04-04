'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFetcher, useNavigate, useRevalidator, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { useAuthData } from '@/hooks/use-auth-data';

// Note: Auth is handled by the (app) layout - no need to check here
import type { Integration } from '@/types';
import type { IntegrationDefinition } from '@/lib/integration-registry';
import { IntegrationIcon, hasIntegrationIcon, resolveLogoType } from '@/lib/integration-icons';
import { writeDraft } from '@/hooks/use-draft-persistence';
import { PageHeader } from '@/components/page-header';
import { AddConnectionDialog } from './AddConnectionDialog';
import { EditConnectionDialog } from './EditConnectionDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  MessageSquare,
  MoreVertical,
  Plug,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const categoryLabels: Record<string, string> = {
  databases: 'Databases',
  saas: 'SaaS',
  ai_services: 'AI Services',
  cloud_providers: 'Cloud Providers',
  communication: 'Communication',
};

interface ConnectionsClientProps {
  initialConnections: Integration[];
  connectionTypes: IntegrationDefinition[];
  categories: string[];
  orgId: string;
  otherWorkspaces?: Array<{ id: string; name: string }>;
}

type ConnectionSort = 'updated' | 'name' | 'created';

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_denied: 'You denied access to the service. Please try again if you want to connect.',
  oauth_invalid: 'Invalid OAuth response. Please try again.',
  oauth_state_invalid: 'OAuth session expired. Please try again.',
  oauth_config: 'OAuth is not configured for this service.',
  oauth_token_failed: 'Failed to get access token from the service.',
  oauth_failed: 'OAuth connection failed. Please try again.',
  no_workspace: 'No workspace selected. Please select a workspace first.',
  unauthorized: 'Please log in to connect services.',
};

const OAUTH_SUCCESS_MESSAGES: Record<string, string> = {
  slack_connected: 'Successfully connected to Slack!',
  notion_connected: 'Successfully connected to Notion!',
};

const PENDING_NEW_THREAD_MESSAGE_KEY = 'pendingMessage:newThread';
const CUSTOM_CONNECTION_SYSTEM_MESSAGE =
  '<camelai system message>The user wants to add a custom connection. They have already searched through all available integration templates and selected "Other" — meaning none of the built-in integrations match what they need. Start by asking what tool or service they would like to connect to.</camelai system message>';

export default function ConnectionsClient({
  initialConnections,
  connectionTypes,
  categories,
  orgId,
  otherWorkspaces = [],
}: ConnectionsClientProps) {
  const navigate = useNavigate();
  const { currentOrg, currentWorkspace, orgs } = useAuthData();
  const revalidator = useRevalidator();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const createThreadFetcher = useFetcher<{
    thread?: { id: string };
    error?: string;
  }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customConnectionModalOpen, setCustomConnectionModalOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<Integration | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Integration | null>(null);
  const [copyTarget, setCopyTarget] = useState<Integration | null>(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sortBy, setSortBy] = useState<ConnectionSort>('updated');
  const [pickerSearch, setPickerSearch] = useState('');
  const [pendingAction, setPendingAction] = useState<'clone' | 'delete' | null>(null);

  const connections = initialConnections;
  const loading = revalidator.state === 'loading';
  const typeDefinitionsByType = useMemo(
    () => new Map(connectionTypes.map((type) => [type.type, type])),
    [connectionTypes]
  );

  const filteredConnectionTypes = useMemo(() => {
    const query = pickerSearch.trim().toLowerCase();
    if (!query) return connectionTypes;
    return connectionTypes.filter(
      (t) =>
        t.displayName.toLowerCase().includes(query) ||
        t.type.toLowerCase().includes(query)
    );
  }, [connectionTypes, pickerSearch]);

  const activeCategories = useMemo(() => {
    const active = new Set<string>(connections.map((connection) => connection.category));
    return categories.filter((category) => active.has(category));
  }, [connections, categories]);

  const filteredConnections = useMemo(() => {
    const query = search.trim().toLowerCase();

    let result = connections.filter((connection) => {
      if (!query) return true;

      const typeDef = typeDefinitionsByType.get(connection.integration_type);
      return (
        connection.name.toLowerCase().includes(query) ||
        connection.integration_type.toLowerCase().includes(query) ||
        (typeDef?.displayName.toLowerCase().includes(query) ?? false)
      );
    });

    if (categoryFilter !== 'all') {
      result = result.filter((connection) => connection.category === categoryFilter);
    }

    return [...result].sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'created':
          return b.created_at - a.created_at;
        case 'updated':
        default:
          return b.updated_at - a.updated_at;
      }
    });
  }, [connections, search, categoryFilter, sortBy, typeDefinitionsByType]);

  const hasActiveFilters = search.trim().length > 0 || categoryFilter !== 'all';

  // Handle OAuth success/error from URL params
  useEffect(() => {
    const errorParam = searchParams.get('error');
    const successParam = searchParams.get('success');

    if (errorParam) {
      setError(OAUTH_ERROR_MESSAGES[errorParam] || `Connection failed: ${errorParam}`);
      // Clear the param from URL
      searchParams.delete('error');
      setSearchParams(searchParams, { replace: true });
    }

    if (successParam) {
      setSuccess(OAUTH_SUCCESS_MESSAGES[successParam] || 'Connection successful!');
      // Clear the param from URL
      searchParams.delete('success');
      setSearchParams(searchParams, { replace: true });
      // Clear success message after 5 seconds
      const timeout = setTimeout(() => setSuccess(null), 5000);
      return () => clearTimeout(timeout);
    }
  }, [searchParams, setSearchParams]);

  // Revalidate when org changes
  useEffect(() => {
    if (revalidator.state === 'idle') {
      revalidator.revalidate();
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    if (categoryFilter === 'all') return;
    if (activeCategories.length <= 1 || !activeCategories.includes(categoryFilter)) {
      setCategoryFilter('all');
    }
  }, [activeCategories, categoryFilter]);

  // Handle fetcher responses
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.error) {
        if (pendingAction === 'clone') {
          toast.error(fetcher.data.error);
        } else {
          setError(fetcher.data.error);
        }
      } else if (fetcher.data.success) {
        if (pendingAction === 'clone') {
          toast.success('Connection cloned to workspace');
        }
        setDeleteTarget(null);
        setCopyTarget(null);
      }
      setPendingAction(null);
    }
  }, [fetcher.state, fetcher.data]);

  // Handle new thread creation for custom "other" connections
  useEffect(() => {
    if (createThreadFetcher.state !== 'idle' || !createThreadFetcher.data) return;

    if (createThreadFetcher.data.thread) {
      const threadId = createThreadFetcher.data.thread.id;
      sessionStorage.setItem(
        PENDING_NEW_THREAD_MESSAGE_KEY,
        JSON.stringify({ message: CUSTOM_CONNECTION_SYSTEM_MESSAGE, threadId })
      );
      navigate(`/chat/${threadId}?newThread=1`);
      return;
    }

    if (createThreadFetcher.data.error) {
      toast.error(createThreadFetcher.data.error);
    }
  }, [createThreadFetcher.state, createThreadFetcher.data, navigate]);

  const handleDelete = () => {
    if (!deleteTarget) return;

    fetcher.submit(
      {
        intent: 'deleteIntegration',
        integrationId: deleteTarget.id,
      },
      { method: 'POST' }
    );
  };

  // OAuth integration types that redirect immediately (no dialog)
  const OAUTH_INTEGRATIONS = ['slack', 'notion'];

  const handleAddClick = (type: string) => {
    // For OAuth integrations, redirect immediately to OAuth flow
    if (OAUTH_INTEGRATIONS.includes(type)) {
      window.location.href = `/api/integrations/${type}/oauth?redirect=/connections`;
      return;
    }

    // For custom integrations, confirm chat handoff before seeding a new thread
    if (type === 'other') {
      setPickerOpen(false);
      setCustomConnectionModalOpen(true);
      return;
    }

    setSelectedType(type);
    setAddDialogOpen(true);
    setPickerOpen(false);
  };

  const handleContinueToCustomConnectionChat = () => {
    if (createThreadFetcher.state !== 'idle') return;

    createThreadFetcher.submit(
      {
        intent: 'createThread',
        firstMessage: 'Set up a custom connection',
      },
      { method: 'post', action: '/chat' }
    );
  };

  const handleCopyToWorkspace = (connection: Integration, targetWorkspaceId: string) => {
    setPendingAction('clone');
    fetcher.submit(
      {
        intent: 'duplicateIntegration',
        integrationId: connection.id,
        targetWorkspaceId,
      },
      { method: 'POST' }
    );
    setCopyTarget(null);
  };

  const handleEditClick = (connection: Integration) => {
    setSelectedConnection(connection);
    setEditDialogOpen(true);
  };

  const handleNewChat = (connection: Integration) => {
    if (!currentWorkspace) return;
    const text = `Use my ${connection.name || connection.integration_type} connection to create `;
    writeDraft(currentWorkspace.id, null, text, []);
    navigate('/chat');
  };

  const handleAddSuccess = () => {
    setAddDialogOpen(false);
    setSelectedType(null);
    if (revalidator.state === 'idle') {
      revalidator.revalidate();
    }
  };

  const handleEditSuccess = () => {
    setEditDialogOpen(false);
    setSelectedConnection(null);
    if (revalidator.state === 'idle') {
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
    }
  };

  const clearAllFilters = () => {
    setSearch('');
    setCategoryFilter('all');
  };

  const getTypeDefinition = useCallback((type: string) => {
    return typeDefinitionsByType.get(type);
  }, [typeDefinitionsByType]);

  const getConnectionDescription = useCallback((connection: Integration) => {
    // For "other" type, show the custom description if provided
    if (connection.integration_type === 'other') {
      const config = connection.config as Record<string, unknown> | undefined;
      if (config?.description && typeof config.description === 'string') {
        return config.description;
      }
      return 'Custom Integration';
    }
    const typeDef = getTypeDefinition(connection.integration_type);
    return typeDef?.displayName || connection.integration_type;
  }, [getTypeDefinition]);

  const isLoading = loading;
  const currentMembership = orgs.find((entry) => entry.org_id === currentOrg?.id);
  const isAdmin = currentMembership?.role === 'owner' || currentMembership?.role === 'admin';

  return (
    <TooltipProvider>
    <>
      <PageHeader breadcrumbs={[{ label: 'Connections' }]} />

      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 md:px-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold">Connections</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Connect external services so your apps can read and write data.
                </p>
              </div>
              {isAdmin && (
                <Button onClick={() => setPickerOpen(true)} disabled={isLoading}>
                  <Plus className="mr-2 size-4" />
                  Add Connection
                </Button>
              )}
            </div>

            {error && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {success && (
              <Alert className="mt-4 border-green-500/50 bg-green-500/10 text-green-600 dark:text-green-400">
                <CheckCircle2 className="size-4" />
                <AlertDescription>{success}</AlertDescription>
              </Alert>
            )}

            {isLoading ? (
              <div className="mt-6 flex items-center justify-center py-16 text-sm text-muted-foreground">
                Loading connections...
              </div>
            ) : connections.length === 0 ? (
              <Card className="mt-6 border-dashed">
                <CardHeader className="flex flex-row items-start gap-4">
                  <div className="flex size-12 items-center justify-center rounded-lg bg-muted">
                    <Plug className="size-5" />
                  </div>
                  <div>
                    <CardTitle>No connections yet</CardTitle>
                    <CardDescription>
                      Add a connection to give your apps access to external services.
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  {isAdmin ? (
                    <Button onClick={() => setPickerOpen(true)}>
                      <Plus className="mr-2 size-4" />
                      Add your first connection
                    </Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Only admins can add connections.
                    </p>
                  )}
                </CardContent>
              </Card>
            ) : (
              <>
                <div className="mt-6 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[220px] flex-1">
                      <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search connections..."
                        className="pl-9 pr-8"
                      />
                      {search && (
                        <button
                          type="button"
                          onClick={() => setSearch('')}
                          className="absolute inset-y-0 right-0 inline-flex items-center px-3 text-muted-foreground hover:text-foreground"
                          aria-label="Clear search"
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
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

                  {activeCategories.length > 1 && (
                    <Tabs value={categoryFilter} onValueChange={setCategoryFilter} className="w-full">
                      <div className="overflow-x-auto overflow-y-hidden">
                        <TabsList className="w-max justify-start">
                          <TabsTrigger value="all">All</TabsTrigger>
                          {activeCategories.map((category) => (
                            <TabsTrigger key={category} value={category}>
                              {categoryLabels[category] || category}
                            </TabsTrigger>
                          ))}
                        </TabsList>
                      </div>
                    </Tabs>
                  )}

                  {hasActiveFilters && (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                      <span>
                        Showing {filteredConnections.length} of {connections.length} connections
                      </span>
                      <Button variant="ghost" size="sm" onClick={clearAllFilters}>
                        <X className="mr-1 size-3" />
                        Clear filters
                      </Button>
                    </div>
                  )}
                </div>

                {filteredConnections.length === 0 ? (
                  <Card className="mt-6 border-dashed">
                    <CardHeader>
                      <CardTitle>No connections match your filters</CardTitle>
                      <CardDescription>
                        Try a different search or category, or clear the current filters.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button variant="outline" onClick={clearAllFilters}>
                        <X className="mr-2 size-4" />
                        Clear all filters
                      </Button>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="mt-6 grid gap-4 md:grid-cols-2">
                    {filteredConnections.map((connection) => {
                      const resolvedType = resolveLogoType(connection.integration_type, [
                        (connection.config as Record<string, unknown>)?.display_name as string,
                        connection.name,
                      ]);
                      const hasIcon = hasIntegrationIcon(resolvedType);

                      return (
                        <Card key={connection.id}>
                          <CardHeader className="flex flex-row items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="flex size-10 items-center justify-center rounded-lg border">
                                    {hasIcon ? (
                                      <IntegrationIcon
                                        type={resolvedType}
                                        className="size-5"
                                      />
                                    ) : (
                                      <Settings className="size-5" />
                                    )}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent>{getConnectionDescription(connection)}</TooltipContent>
                              </Tooltip>
                              <CardTitle>{connection.name}</CardTitle>
                            </div>
                            <div className="flex items-center gap-1">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button variant="ghost" size="icon" aria-label="New chat" onClick={() => handleNewChat(connection)}>
                                    <MessageSquare className="size-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>New chat</TooltipContent>
                              </Tooltip>
                              {isAdmin && (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      className="h-7 w-7 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
                                    >
                                      <MoreVertical className="h-4 w-4" />
                                      <span className="sr-only">Connection options</span>
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-48">
                                    <DropdownMenuItem onClick={() => handleEditClick(connection)}>
                                      <Settings className="h-4 w-4 mr-2" />
                                      Configure
                                    </DropdownMenuItem>
                                    {otherWorkspaces.length > 0 && (
                                      <DropdownMenuItem onClick={() => setCopyTarget(connection)}>
                                        <Copy className="h-4 w-4 mr-2" />
                                        Clone to workspace
                                      </DropdownMenuItem>
                                    )}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onClick={() => setDeleteTarget(connection)}
                                    >
                                      <Trash2 className="h-4 w-4 mr-2" />
                                      Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                            </div>
                          </CardHeader>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </div>

      <Dialog open={pickerOpen} onOpenChange={(open) => { setPickerOpen(open); if (!open) setPickerSearch(''); }}>
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
                  onChange={(e) => setPickerSearch(e.target.value)}
                  placeholder="Search connections..."
                  className="pl-9 pr-8"
                />
                {pickerSearch && (
                  <button
                    type="button"
                    onClick={() => setPickerSearch('')}
                    className="absolute inset-y-0 right-0 inline-flex items-center px-3 text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
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
                <ScrollArea className="max-h-[60vh] pr-4 overflow-x-hidden">
                  <div className="min-w-0 p-1">
                    <TabsContent value="all" className="mt-0">
                      {filteredConnectionTypes.length === 0 ? (
                        <div className="py-6 text-center text-sm text-muted-foreground">
                          No integrations found
                        </div>
                      ) : (
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {filteredConnectionTypes.map((type) => {
                            const hasIcon = hasIntegrationIcon(type.type);
                            return (
                              <button
                                key={type.type}
                                onClick={() => handleAddClick(type.type)}
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
                                  <div className="truncate text-sm font-medium">
                                    {type.displayName}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {type.authMethod === 'oauth2' ? 'OAuth' : 'API Key'}
                                  </div>
                                </div>
                                <Plus className="size-4 shrink-0 text-muted-foreground" />
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </TabsContent>
                    {categories.map((category) => {
                      const categoryTypes = filteredConnectionTypes.filter((type) => type.category === category);
                      return (
                        <TabsContent key={category} value={category} className="mt-0">
                          {categoryTypes.length === 0 ? (
                            <div className="py-6 text-center text-sm text-muted-foreground">
                              No integrations found
                            </div>
                          ) : (
                            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                              {categoryTypes.map((type) => {
                                const hasIcon = hasIntegrationIcon(type.type);
                                return (
                                  <button
                                    key={type.type}
                                    onClick={() => handleAddClick(type.type)}
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
                                      <div className="truncate text-sm font-medium">
                                        {type.displayName}
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        {type.authMethod === 'oauth2' ? 'OAuth' : 'API Key'}
                                      </div>
                                    </div>
                                    <Plus className="size-4 shrink-0 text-muted-foreground" />
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </TabsContent>
                      );
                    })}
                  </div>
                </ScrollArea>
              </Tabs>
            </>
          )}
        </DialogContent>
      </Dialog>

      {selectedType && (
        <AddConnectionDialog
          open={addDialogOpen}
          onOpenChange={handleAddDialogOpenChange}
          connectionType={selectedType}
          connectionTypes={connectionTypes}
          orgId={orgId}
          onSuccess={handleAddSuccess}
        />
      )}

      {selectedConnection && (
        <EditConnectionDialog
          open={editDialogOpen}
          onOpenChange={handleEditDialogOpenChange}
          connection={selectedConnection}
          connectionTypes={connectionTypes}
          orgId={orgId}
          onSuccess={handleEditSuccess}
        />
      )}
      <ConfirmDialog
        open={customConnectionModalOpen}
        onOpenChange={setCustomConnectionModalOpen}
        title="Continue in chat?"
        description="Custom connections are set up with the agent in chat. We'll open a new chat and help you connect your service."
        confirmLabel="Continue"
        onConfirm={() => {
          handleContinueToCustomConnectionChat();
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
        onConfirm={() => {
          void handleDelete();
        }}
      />

      <Dialog open={Boolean(copyTarget)} onOpenChange={(open) => { if (!open) setCopyTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clone connection</DialogTitle>
            <DialogDescription>
              Clone &ldquo;{copyTarget?.name}&rdquo; to another workspace in this organization.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {otherWorkspaces.map((ws) => (
              <button
                key={ws.id}
                type="button"
                className="w-full flex items-center justify-between rounded-md border p-3 text-sm hover:bg-accent transition-colors"
                onClick={() => {
                  if (copyTarget) {
                    handleCopyToWorkspace(copyTarget, ws.id);
                  }
                }}
              >
                <span className="font-medium">{ws.name}</span>
                <Copy className="size-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
    </TooltipProvider>
  );
}
