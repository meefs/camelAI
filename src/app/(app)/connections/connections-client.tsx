'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertCircle,
  Plug,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react';
import { deleteIntegration, getOrgIntegrations, updateIntegration } from '@/lib/server-actions/org';

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

export default function ConnectionsClient({
  initialConnections,
  connectionTypes,
  categories,
  orgId,
}: ConnectionsClientProps) {
  const { currentOrg, loading: authLoading } = useAuth();

  const [connections, setConnections] = useState<Integration[]>(initialConnections);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<Integration | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [activeOrgId, setActiveOrgId] = useState(orgId);

  const refreshConnections = useCallback(
    async (targetOrgId = activeOrgId) => {
      if (!targetOrgId) return;
      try {
        setLoading(true);
        const data = await getOrgIntegrations(targetOrgId);
        setConnections(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load connections');
      } finally {
        setLoading(false);
      }
    },
    [activeOrgId]
  );

  useEffect(() => {
    if (currentOrg?.id && currentOrg.id !== activeOrgId) {
      setActiveOrgId(currentOrg.id);
      refreshConnections(currentOrg.id);
    }
  }, [currentOrg?.id, activeOrgId, refreshConnections]);

  const handleToggleEnabled = async (connection: Integration) => {
    if (!activeOrgId) return;

    try {
      await updateIntegration(activeOrgId, connection.id, {
        enabled: !connection.enabled,
      });
      await refreshConnections(activeOrgId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update connection');
    }
  };

  const handleDelete = async (connection: Integration) => {
    if (!activeOrgId) return;
    if (!confirm(`Are you sure you want to delete "${connection.name}"?`)) return;

    try {
      await deleteIntegration(activeOrgId, connection.id);
      await refreshConnections(activeOrgId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete connection');
    }
  };

  const handleAddClick = (type: string) => {
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
    refreshConnections(activeOrgId);
  };

  const handleEditSuccess = () => {
    setEditDialogOpen(false);
    setSelectedConnection(null);
    refreshConnections(activeOrgId);
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

  const isLoading = authLoading || loading;

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
              <Button onClick={() => setPickerOpen(true)} disabled={isLoading}>
                <Plus className="mr-2 size-4" />
                Add Connection
              </Button>
            </div>

            {error && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
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
                  <Button onClick={() => setPickerOpen(true)}>
                    <Plus className="mr-2 size-4" />
                    Add your first connection
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <Tabs defaultValue={categories[0]} className="mt-6">
                <TabsList>
                  {categories.map((category) => (
                    <TabsTrigger key={category} value={category}>
                      {categoryLabels[category] || category}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {categories.map((category) => {
                  const filteredConnections = connections.filter(
                    (connection) =>
                      getTypeDefinition(connection.integration_type)?.category === category
                  );

                  return (
                    <TabsContent key={category} value={category} className="mt-4 space-y-4">
                      {filteredConnections.length === 0 ? (
                        <Card className="border-dashed">
                          <CardHeader>
                            <CardTitle>No connections</CardTitle>
                            <CardDescription>
                              Add a {categoryLabels[category] || category} connection to get started.
                            </CardDescription>
                          </CardHeader>
                          <CardContent>
                            <Button onClick={() => setPickerOpen(true)}>
                              <Plus className="mr-2 size-4" />
                              Add connection
                            </Button>
                          </CardContent>
                        </Card>
                      ) : (
                        <div className="grid gap-4 md:grid-cols-2">
                          {filteredConnections.map((connection) => {
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
                                        {typeDef?.displayName || connection.integration_type}
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
                                      />
                                    </div>
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
                                        onClick={() => handleDelete(connection)}
                                      >
                                        <Trash2 className="size-4" />
                                      </Button>
                                    </div>
                                  </div>
                                </CardContent>
                              </Card>
                            );
                          })}
                        </div>
                      )}
                    </TabsContent>
                  );
                })}
              </Tabs>
            )}
          </div>
        </ScrollArea>
      </div>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Choose a connection</DialogTitle>
            <DialogDescription>
              Pick a service to connect with Chiridion.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {connectionTypes.map((type) => {
              const hasIcon = hasIntegrationIcon(type.type);
              return (
                <button
                  key={type.type}
                  type="button"
                  className="flex items-center gap-3 rounded-lg border border-border p-3 text-left transition hover:border-primary/50"
                  onClick={() => handleAddClick(type.type)}
                >
                  <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                    {hasIcon ? (
                      <IntegrationIcon type={type.type} className="size-5" />
                    ) : (
                      <Settings className="size-5" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{type.displayName}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {type.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {selectedType && (
        <AddConnectionDialog
          open={addDialogOpen}
          onOpenChange={handleAddDialogOpenChange}
          connectionType={selectedType}
          connectionTypes={connectionTypes}
          orgId={activeOrgId}
          onSuccess={handleAddSuccess}
        />
      )}

      {selectedConnection && (
        <EditConnectionDialog
          open={editDialogOpen}
          onOpenChange={handleEditDialogOpenChange}
          connection={selectedConnection}
          connectionTypes={connectionTypes}
          orgId={activeOrgId}
          onSuccess={handleEditSuccess}
        />
      )}
    </>
  );
}
