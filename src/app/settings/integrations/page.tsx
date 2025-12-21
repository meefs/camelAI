'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import type { Integration } from '@/types';
import type { IntegrationDefinition } from '@/lib/integration-registry';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  AlertCircle,
  ArrowLeft,
  Database,
  Cloud,
  MessageSquare,
  Sparkles,
  Building2,
  Plus,
  Settings,
  Trash2,
  Check,
} from 'lucide-react';
import { AddIntegrationDialog } from './AddIntegrationDialog';
import { EditIntegrationDialog } from './EditIntegrationDialog';

const categoryIcons: Record<string, React.ReactNode> = {
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

export default function IntegrationsPage() {
  const router = useRouter();
  const { user, currentOrg, loading: authLoading } = useAuth();

  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [integrationTypes, setIntegrationTypes] = useState<IntegrationDefinition[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedIntegration, setSelectedIntegration] = useState<Integration | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);

  const fetchIntegrations = useCallback(async () => {
    if (!currentOrg?.id) return;

    try {
      const res = await fetch(`/api/orgs/${currentOrg.id}/integrations`);
      if (!res.ok) throw new Error('Failed to fetch integrations');
      const data = (await res.json()) as Integration[];
      setIntegrations(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load integrations');
    }
  }, [currentOrg?.id]);

  const fetchIntegrationTypes = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/types');
      if (!res.ok) throw new Error('Failed to fetch integration types');
      const data = (await res.json()) as {
        integrations: IntegrationDefinition[];
        categories: string[];
      };
      setIntegrationTypes(data.integrations);
      setCategories(data.categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load integration types');
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
      Promise.all([fetchIntegrations(), fetchIntegrationTypes()]).finally(() =>
        setLoading(false)
      );
    }
  }, [currentOrg?.id, fetchIntegrations, fetchIntegrationTypes]);

  const handleToggleEnabled = async (integration: Integration) => {
    if (!currentOrg?.id) return;

    try {
      const res = await fetch(
        `/api/orgs/${currentOrg.id}/integrations/${integration.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !integration.enabled }),
        }
      );
      if (!res.ok) throw new Error('Failed to update integration');
      await fetchIntegrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update integration');
    }
  };

  const handleDelete = async (integration: Integration) => {
    if (!currentOrg?.id) return;
    if (!confirm(`Are you sure you want to delete "${integration.name}"?`)) return;

    try {
      const res = await fetch(
        `/api/orgs/${currentOrg.id}/integrations/${integration.id}`,
        { method: 'DELETE' }
      );
      if (!res.ok) throw new Error('Failed to delete integration');
      await fetchIntegrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete integration');
    }
  };

  const handleAddClick = (type: string) => {
    setSelectedType(type);
    setAddDialogOpen(true);
  };

  const handleEditClick = (integration: Integration) => {
    setSelectedIntegration(integration);
    setEditDialogOpen(true);
  };

  const handleAddSuccess = () => {
    setAddDialogOpen(false);
    setSelectedType(null);
    fetchIntegrations();
  };

  const handleEditSuccess = () => {
    setEditDialogOpen(false);
    setSelectedIntegration(null);
    fetchIntegrations();
  };

  const getTypeDefinition = (type: string) => {
    return integrationTypes.find((t) => t.type === type);
  };

  if (authLoading || loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-zinc-950 text-white">
        <div className="text-zinc-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-svh bg-zinc-950 text-white">
      <div className="mx-auto max-w-5xl px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push('/')}
            className="mb-4 text-zinc-400 hover:text-white"
          >
            <ArrowLeft className="mr-2 size-4" />
            Back to Chat
          </Button>
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="mt-1 text-zinc-400">
            Connect external services to your workspace
          </p>
        </div>

        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertCircle className="size-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Active Integrations */}
        {integrations.length > 0 && (
          <div className="mb-8">
            <h2 className="mb-4 text-lg font-medium">Active Integrations</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {integrations.map((integration) => {
                const typeDef = getTypeDefinition(integration.integration_type);
                return (
                  <Card
                    key={integration.id}
                    className="border-zinc-800 bg-zinc-900"
                  >
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className="flex size-10 items-center justify-center rounded-lg bg-zinc-800">
                            {categoryIcons[integration.category] || (
                              <Settings className="size-5" />
                            )}
                          </div>
                          <div>
                            <CardTitle className="text-base">
                              {integration.name}
                            </CardTitle>
                            <CardDescription className="text-xs">
                              {typeDef?.displayName || integration.integration_type}
                            </CardDescription>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={integration.enabled}
                            onCheckedChange={() => handleToggleEnabled(integration)}
                          />
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={integration.enabled ? 'default' : 'secondary'}
                            className="text-xs"
                          >
                            {integration.enabled ? (
                              <>
                                <Check className="mr-1 size-3" />
                                Connected
                              </>
                            ) : (
                              'Disabled'
                            )}
                          </Badge>
                          <Badge variant="outline" className="text-xs">
                            {categoryLabels[integration.category] || integration.category}
                          </Badge>
                        </div>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEditClick(integration)}
                          >
                            <Settings className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(integration)}
                            className="text-red-400 hover:text-red-300"
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

        <Separator className="my-8 bg-zinc-800" />

        {/* Available Integrations */}
        <div>
          <h2 className="mb-4 text-lg font-medium">Available Integrations</h2>
          <Tabs defaultValue={categories[0]} className="w-full">
            <TabsList className="mb-4 bg-zinc-900">
              {categories.map((category) => (
                <TabsTrigger
                  key={category}
                  value={category}
                  className="data-[state=active]:bg-zinc-800"
                >
                  <span className="mr-2">{categoryIcons[category]}</span>
                  {categoryLabels[category] || category}
                </TabsTrigger>
              ))}
            </TabsList>
            {categories.map((category) => (
              <TabsContent key={category} value={category}>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {integrationTypes
                    .filter((t) => t.category === category)
                    .map((type) => {
                      const isConfigured = integrations.some(
                        (i) => i.integration_type === type.type
                      );
                      return (
                        <Card
                          key={type.type}
                          className="border-zinc-800 bg-zinc-900 transition-colors hover:border-zinc-700"
                        >
                          <CardHeader className="pb-3">
                            <div className="flex items-center gap-3">
                              <div className="flex size-10 items-center justify-center rounded-lg bg-zinc-800">
                                {categoryIcons[type.category] || (
                                  <Settings className="size-5" />
                                )}
                              </div>
                              <div>
                                <CardTitle className="text-base">
                                  {type.displayName}
                                </CardTitle>
                                <CardDescription className="text-xs">
                                  {type.authMethod === 'oauth2'
                                    ? 'OAuth 2.0'
                                    : 'API Key'}
                                </CardDescription>
                              </div>
                            </div>
                          </CardHeader>
                          <CardContent>
                            <p className="mb-4 text-sm text-zinc-400">
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
        </div>
      </div>

      {/* Dialogs */}
      {selectedType && (
        <AddIntegrationDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          integrationType={selectedType}
          integrationTypes={integrationTypes}
          orgId={currentOrg?.id || ''}
          onSuccess={handleAddSuccess}
        />
      )}

      {selectedIntegration && (
        <EditIntegrationDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          integration={selectedIntegration}
          integrationTypes={integrationTypes}
          orgId={currentOrg?.id || ''}
          onSuccess={handleEditSuccess}
        />
      )}
    </div>
  );
}
