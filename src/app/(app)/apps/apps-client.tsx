'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';

import type { WorkerScriptWithCreator } from '@/types';
import { PageHeader } from '@/components/page-header';
import { AppCard } from './AppCard';
import { AppSettingsDialog } from './AppSettingsDialog';
import { AppCardSkeleton } from './AppCardSkeleton';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertCircle, LayoutGrid } from 'lucide-react';
import { getOrgApps, getOrgAppsAllWorkspaces } from '@/lib/server-actions/apps';

interface AppsClientProps {
  initialApps: WorkerScriptWithCreator[];
  orgId: string;
  hostname?: string;
  initialNow: number;
}

export default function AppsClient({
  initialApps,
  orgId,
  hostname,
  initialNow,
}: AppsClientProps) {
  const {
    currentOrg,
    currentWorkspace,
    orgs,
    workspaces,
    loading: authLoading,
  } = useAuth();

  const [apps, setApps] = useState<WorkerScriptWithCreator[]>(initialApps);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'this-workspace' | 'all-workspaces'>('this-workspace');
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [selectedApp, setSelectedApp] = useState<WorkerScriptWithCreator | null>(null);
  const [activeOrgId, setActiveOrgId] = useState(orgId);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    currentWorkspace?.id ?? null
  );
  const [referenceTime, setReferenceTime] = useState(initialNow);
  const workspaceMap = useMemo(
    () => new Map((workspaces ?? []).map((workspace) => [workspace.id, workspace])),
    [workspaces]
  );

  const refreshApps = useCallback(
    async (
      nextFilter: 'this-workspace' | 'all-workspaces' = filter,
      targetOrgId = activeOrgId
    ) => {
      if (!targetOrgId) return;
      try {
        setLoading(true);
        setError(null);
        const data =
          nextFilter === 'all-workspaces'
            ? await getOrgAppsAllWorkspaces(targetOrgId)
            : await getOrgApps(targetOrgId);
        setApps(data);
        setReferenceTime(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load apps');
      } finally {
        setLoading(false);
      }
    },
    [activeOrgId, filter]
  );

  useEffect(() => {
    if (currentOrg?.id && currentOrg.id !== activeOrgId) {
      setActiveOrgId(currentOrg.id);
      refreshApps(filter, currentOrg.id);
    }
  }, [currentOrg?.id, activeOrgId, filter, refreshApps]);

  useEffect(() => {
    const workspaceId = currentWorkspace?.id ?? null;
    if (workspaceId === activeWorkspaceId) return;
    setActiveWorkspaceId(workspaceId);
    if (filter === 'this-workspace' && workspaceId) {
      refreshApps('this-workspace');
    }
  }, [activeWorkspaceId, currentWorkspace?.id, filter, refreshApps]);

  const handleOpenSettings = (app: WorkerScriptWithCreator) => {
    setSelectedApp(app);
    setSettingsDialogOpen(true);
  };

  const handleSettingsSuccess = () => {
    void refreshApps(filter, activeOrgId);
  };

  const handleSettingsDialogOpenChange = (open: boolean) => {
    setSettingsDialogOpen(open);
    if (!open) {
      setSelectedApp(null);
    }
  };

  const handleStartChat = (app: WorkerScriptWithCreator) => {
    // FIXME: Check if app.workspace_id !== currentWorkspace?.id and prompt workspace switch.
    if (currentWorkspace?.id && app.workspace_id !== currentWorkspace.id) {
      console.log('Start chat with app:', app.script_name, 'workspace:', app.workspace_id);
    }
    // FIXME: Wire to workspace chat once app context handoff is supported.
    toast(`Chat for ${app.script_name} is coming soon.`);
  };

  const handleViewSource = (app: WorkerScriptWithCreator) => {
    // FIXME: Deep link to the Computer tab once source_path is available.
    toast(`Source view for ${app.script_name} is coming soon.`);
  };

  const isLoading = authLoading || loading;
  const currentMembership = orgs.find((entry) => entry.org_id === currentOrg?.id);
  const isAdmin = currentMembership?.role === 'owner' || currentMembership?.role === 'admin';
  const currentWorkspaceId = currentWorkspace?.id ?? null;

  const handleFilterChange = useCallback(
    (value: 'this-workspace' | 'all-workspaces') => {
      setFilter(value);
      refreshApps(value);
    },
    [refreshApps]
  );

  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Apps' }]} />

      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 md:px-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold">Apps</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Manage your deployed applications and their access settings.
                </p>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <Tabs
                value={filter}
                onValueChange={(value) =>
                  handleFilterChange(value as 'this-workspace' | 'all-workspaces')
                }
              >
                <TabsList variant="line">
                  <TabsTrigger value="this-workspace">This workspace</TabsTrigger>
                  <TabsTrigger value="all-workspaces">All workspaces</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {error && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {isLoading ? (
              <div className="@container">
                <div className="mt-6 grid gap-4 @[580px]:grid-cols-2 @[880px]:grid-cols-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <AppCardSkeleton key={i} />
                  ))}
                </div>
              </div>
            ) : apps.length === 0 ? (
              <Card className="mt-6 border-dashed p-0">
                <div className="aspect-video w-full bg-muted/60 flex items-center justify-center">
                  <LayoutGrid className="size-6 text-muted-foreground" />
                </div>
                <CardHeader className="space-y-2 pb-4">
                  <CardTitle>No apps deployed yet</CardTitle>
                  <CardDescription>
                    Deploy an app from a chat conversation to see it here.
                  </CardDescription>
                </CardHeader>
              </Card>
            ) : (
              <div className="@container">
                <div className="mt-6 grid gap-4 @[580px]:grid-cols-2 @[880px]:grid-cols-3">
                  {apps.map((app) => (
                    <AppCard
                      key={app.script_name}
                      app={app}
                      creator={app.creator}
                      workspace={workspaceMap.get(app.workspace_id) ?? null}
                      showWorkspaceBadge={Boolean(
                        filter === 'all-workspaces' &&
                          currentWorkspaceId &&
                          app.workspace_id !== currentWorkspaceId
                      )}
                      isAdmin={isAdmin}
                      hostname={hostname}
                      now={referenceTime}
                      onOpenSettings={handleOpenSettings}
                      onStartChat={handleStartChat}
                      onViewSource={handleViewSource}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {selectedApp && (
        <AppSettingsDialog
          open={settingsDialogOpen}
          onOpenChange={handleSettingsDialogOpenChange}
          app={selectedApp}
          orgId={activeOrgId}
          isAdmin={isAdmin}
          hostname={hostname}
          onSuccess={handleSettingsSuccess}
        />
      )}
    </>
  );
}
