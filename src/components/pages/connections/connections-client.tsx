'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFetcher, useRevalidator, useSearchParams } from 'react-router';
import { useAuthData } from '@/hooks/use-auth-data';

// Note: Auth is handled by the (app) layout - no need to check here
import type { Integration } from '@/types';
import type { IntegrationDefinition } from '@/lib/integration-registry';
import { IntegrationIcon, hasIntegrationIcon } from '@/lib/integration-icons';
import { PageHeader } from '@/components/page-header';
import { AddConnectionDialog } from './AddConnectionDialog';
import { EditConnectionDialog } from './EditConnectionDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertCircle,
  CheckCircle2,
  Plug,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react';

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
}

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

export default function ConnectionsClient({
  initialConnections,
  connectionTypes,
  categories,
  orgId,
}: ConnectionsClientProps) {
  const { currentOrg, orgs } = useAuthData();
  const revalidator = useRevalidator();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<Integration | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Integration | null>(null);

  const connections = initialConnections;
  const loading = revalidator.state === 'loading';

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

  // Handle fetcher responses
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.error) {
        setError(fetcher.data.error);
      } else if (fetcher.data.success) {
        setDeleteTarget(null);
      }
    }
  }, [fetcher.state, fetcher.data]);

  const handleToggleEnabled = (connection: Integration) => {
    fetcher.submit(
      {
        intent: 'toggleIntegration',
        integrationId: connection.id,
        enabled: String(!connection.enabled),
      },
      { method: 'POST' }
    );
  };

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
    setSelectedType(type);
    setAddDialogOpen(true);
    setPickerOpen(false);
  };

  const handleEditClick = (connection: Integration) => {
    setSelectedConnection(connection);
    setEditDialogOpen(true);
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

  const getTypeDefinition = (type: string) => {
    return connectionTypes.find((item) => item.type === type);
  };

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
  }, [connectionTypes]);

  const isLoading = loading;
  const currentMembership = orgs.find((entry) => entry.org_id === currentOrg?.id);
  const isAdmin = currentMembership?.role === 'owner' || currentMembership?.role === 'admin';

  return (
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
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {connections.map((connection) => {
                  const typeDef = getTypeDefinition(connection.integration_type);
                  const hasIcon = hasIntegrationIcon(connection.integration_type);
                  return (
                    <Card key={connection.id}>
                      <CardHeader className="flex flex-row items-start justify-between gap-4">
                        <div className="flex items-start gap-3">
                          <div className="flex size-10 items-center justify-center rounded-lg border">
                            {hasIcon ? (
                              <IntegrationIcon
                                type={connection.integration_type}
                                className="size-5"
                              />
                            ) : (
                              <Settings className="size-5" />
                            )}
                          </div>
                          <div>
                            <CardTitle>{connection.name}</CardTitle>
                            <CardDescription>
                              {getConnectionDescription(connection)}
                            </CardDescription>
                          </div>
                        </div>
                        <Badge variant={connection.enabled ? 'default' : 'outline'}>
                          {connection.enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="flex items-center justify-between text-sm text-muted-foreground">
                          <span>Last updated</span>
                          <span>
                            {new Date(connection.updated_at).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 text-sm">
                            <span>Enabled</span>
                            <Switch
                              checked={connection.enabled}
                              onCheckedChange={() => handleToggleEnabled(connection)}
                              disabled={!isAdmin}
                            />
                          </div>
                          {isAdmin && (
                            <div className="flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleEditClick(connection)}
                              >
                                <Settings className="mr-2 size-3.5" />
                                Configure
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-destructive hover:text-destructive"
                                onClick={() => setDeleteTarget(connection)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
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
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {connectionTypes.map((type) => {
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
                  </TabsContent>
                  {categories.map((category) => (
                    <TabsContent key={category} value={category} className="mt-0">
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {connectionTypes
                          .filter((type) => type.category === category)
                          .map((type) => {
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
                    </TabsContent>
                  ))}
                </div>
              </ScrollArea>
            </Tabs>
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
    </>
  );
}
