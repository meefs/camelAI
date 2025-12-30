'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import type { Integration } from '@/types';
import type { IntegrationDefinition } from '@/lib/integration-registry';
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
  Building2,
  Check,
  Cloud,
  Database,
  MessageSquare,
  Plug,
  Plus,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';

const categoryIcons: Record<string, ReactNode> = {
  databases: <Database className="size-4" />,
  saas: <Building2 className="size-4" />,
  ai_services: <Sparkles className="size-4" />,
  cloud_providers: <Cloud className="size-4" />,
  communication: <MessageSquare className="size-4" />,
};

const categoryLabels: Record<string, string> = {
  databases: 'Databases',
  saas: 'SaaS',
  ai_services: 'AI Services',
  cloud_providers: 'Cloud Providers',
  communication: 'Communication',
};

export default function ConnectionsPage() {
  const router = useRouter();
  const { user, currentOrg, loading: authLoading } = useAuth();

  const [connections, setConnections] = useState<Integration[]>([]);
  const [connectionTypes, setConnectionTypes] = useState<IntegrationDefinition[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<Integration | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);

  const fetchConnections = useCallback(async () => {
    if (!currentOrg?.id) return;

    try {
      const res = await fetch(`/api/orgs/${currentOrg.id}/integrations`);
      if (!res.ok) throw new Error('Failed to fetch connections');
      const data = (await res.json()) as Integration[];
      setConnections(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connections');
    }
  }, [currentOrg?.id]);

  const fetchConnectionTypes = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/types');
      if (!res.ok) throw new Error('Failed to fetch connection types');
      const data = (await res.json()) as {
        integrations: IntegrationDefinition[];
        categories: string[];
      };
      setConnectionTypes(data.integrations);
      setCategories(data.categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connection types');
    }
  }, []);

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login');
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    if (currentOrg?.id) {
      setLoading(true);
      Promise.all([fetchConnections(), fetchConnectionTypes()]).finally(() =>
        setLoading(false)
      );
    }
  }, [currentOrg?.id, fetchConnections, fetchConnectionTypes]);

  const handleToggleEnabled = async (connection: Integration) => {
    if (!currentOrg?.id) return;

    try {
      const res = await fetch(
        `/api/orgs/${currentOrg.id}/integrations/${connection.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !connection.enabled }),
        }
      );
      if (!res.ok) throw new Error('Failed to update connection');
      await fetchConnections();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update connection');
    }
  };

  const handleDelete = async (connection: Integration) => {
    if (!currentOrg?.id) return;
    if (!confirm(`Are you sure you want to delete "${connection.name}"?`)) return;

    try {
      const res = await fetch(
        `/api/orgs/${currentOrg.id}/integrations/${connection.id}`,
        { method: 'DELETE' }
      );
      if (!res.ok) throw new Error('Failed to delete connection');
      await fetchConnections();
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
    fetchConnections();
  };

  const handleEditSuccess = () => {
    setEditDialogOpen(false);
    setSelectedConnection(null);
    fetchConnections();
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

  if (authLoading || loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading connections...</div>
      </div>
    );
  }

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
              <Button onClick={() => setPickerOpen(true)}>
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

            {connections.length === 0 ? (
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
              <div className="mt-6">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-medium text-muted-foreground">Active connections</h2>
                    <p className="text-xs text-muted-foreground">
                      {connections.length} total
                    </p>
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {connections.map((connection) => {
                    const typeDef = getTypeDefinition(connection.integration_type);
                    return (
                      <Card key={connection.id}>
                        <CardHeader className="pb-3">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex items-center gap-3">
                              <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                                {categoryIcons[connection.category] || (
                                  <Settings className="size-5" />
                                )}
                              </div>
                              <div>
                                <CardTitle className="text-base">
                                  {connection.name}
                                </CardTitle>
                                <CardDescription className="text-xs">
                                  {typeDef?.displayName || connection.integration_type}
                                </CardDescription>
                              </div>
                            </div>
                            <Switch
                              checked={connection.enabled}
                              onCheckedChange={() => handleToggleEnabled(connection)}
                            />
                          </div>
                        </CardHeader>
                        <CardContent className="pt-0">
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <Badge
                                variant={connection.enabled ? 'default' : 'secondary'}
                                className="text-xs"
                              >
                                {connection.enabled ? (
                                  <>
                                    <Check className="mr-1 size-3" />
                                    Connected
                                  </>
                                ) : (
                                  'Disabled'
                                )}
                              </Badge>
                              <Badge variant="outline" className="text-xs">
                                {categoryLabels[connection.category] || connection.category}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleEditClick(connection)}
                                aria-label={`Edit ${connection.name}`}
                              >
                                <Settings className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleDelete(connection)}
                                className="text-destructive"
                                aria-label={`Delete ${connection.name}`}
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
              Choose a service to connect. You'll configure credentials next.
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[60vh] pr-4">
            {connectionTypes.length === 0 ? (
              <div className="py-6 text-sm text-muted-foreground">
                No connection types are available right now.
              </div>
            ) : categories.length > 0 ? (
              <Tabs defaultValue={categories[0]} className="w-full">
                <TabsList className="mb-4 w-full justify-start gap-1 overflow-x-auto">
                  {categories.map((category) => (
                    <TabsTrigger
                      key={category}
                      value={category}
                      className="data-[state=active]:bg-background"
                    >
                      <span className="mr-2">{categoryIcons[category]}</span>
                      {categoryLabels[category] || category}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {categories.map((category) => (
                  <TabsContent key={category} value={category}>
                    <div className="grid gap-4 md:grid-cols-2">
                      {connectionTypes
                        .filter((type) => type.category === category)
                        .map((type) => {
                          const isConfigured = connections.some(
                            (connection) => connection.integration_type === type.type
                          );

                          return (
                            <Card key={type.type} className="transition-shadow hover:shadow-sm">
                              <CardHeader className="pb-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex items-center gap-3">
                                    <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                                      {categoryIcons[type.category] || (
                                        <Settings className="size-5" />
                                      )}
                                    </div>
                                    <div>
                                      <CardTitle className="text-base">
                                        {type.displayName}
                                      </CardTitle>
                                      <CardDescription className="text-xs">
                                        {type.authMethod === 'oauth2' ? 'OAuth 2.0' : 'API Key'}
                                      </CardDescription>
                                    </div>
                                  </div>
                                  {isConfigured && (
                                    <Badge variant="secondary" className="text-[10px]">
                                      Connected
                                    </Badge>
                                  )}
                                </div>
                              </CardHeader>
                              <CardContent>
                                <p className="mb-4 text-sm text-muted-foreground">
                                  {type.description}
                                </p>
                                <Button
                                  variant={isConfigured ? 'outline' : 'default'}
                                  size="sm"
                                  className="w-full"
                                  onClick={() => handleAddClick(type.type)}
                                >
                                  <Plus className="mr-2 size-4" />
                                  {isConfigured ? 'Add Another' : 'Configure'}
                                </Button>
                              </CardContent>
                            </Card>
                          );
                        })}
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {connectionTypes.map((type) => {
                  const isConfigured = connections.some(
                    (connection) => connection.integration_type === type.type
                  );

                  return (
                    <Card key={type.type} className="transition-shadow hover:shadow-sm">
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                              {categoryIcons[type.category] || <Settings className="size-5" />}
                            </div>
                            <div>
                              <CardTitle className="text-base">{type.displayName}</CardTitle>
                              <CardDescription className="text-xs">
                                {type.authMethod === 'oauth2' ? 'OAuth 2.0' : 'API Key'}
                              </CardDescription>
                            </div>
                          </div>
                          {isConfigured && (
                            <Badge variant="secondary" className="text-[10px]">
                              Connected
                            </Badge>
                          )}
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="mb-4 text-sm text-muted-foreground">
                          {type.description}
                        </p>
                        <Button
                          variant={isConfigured ? 'outline' : 'default'}
                          size="sm"
                          className="w-full"
                          onClick={() => handleAddClick(type.type)}
                        >
                          <Plus className="mr-2 size-4" />
                          {isConfigured ? 'Add Another' : 'Configure'}
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {selectedType && (
        <AddConnectionDialog
          open={addDialogOpen}
          onOpenChange={handleAddDialogOpenChange}
          connectionType={selectedType}
          connectionTypes={connectionTypes}
          orgId={currentOrg?.id || ''}
          onSuccess={handleAddSuccess}
        />
      )}

      {selectedConnection && (
        <EditConnectionDialog
          open={editDialogOpen}
          onOpenChange={handleEditDialogOpenChange}
          connection={selectedConnection}
          connectionTypes={connectionTypes}
          orgId={currentOrg?.id || ''}
          onSuccess={handleEditSuccess}
        />
      )}
    </>
  );
}
