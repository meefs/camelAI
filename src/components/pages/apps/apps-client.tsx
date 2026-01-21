'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRevalidator } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';

import type { WorkerScriptWithCreator } from '@/types';
import { PageHeader } from '@/components/page-header';
import { AppCard } from './AppCard';
import { AppSettingsDialog } from './AppSettingsDialog';
import { AppCardSkeleton } from './AppCardSkeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LayoutGrid } from 'lucide-react';

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

  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const filter = (searchParams.get('filter') as 'this-workspace' | 'all-workspaces') || 'this-workspace';

  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [selectedApp, setSelectedApp] = useState<WorkerScriptWithCreator | null>(null);
  const [referenceTime, setReferenceTime] = useState(initialNow);
  const workspaceMap = useMemo(
    () => new Map((workspaces ?? []).map((workspace) => [workspace.id, workspace])),
    [workspaces]
  );

  // Revalidate when org or workspace changes
  useEffect(() => {
    if (revalidator.state === 'idle') {
      revalidator.revalidate();
      setReferenceTime(Date.now());
    }
  }, [currentOrg?.id, currentWorkspace?.id]);

  const loading = authLoading || revalidator.state === 'loading';
  const apps = initialApps;

  const handleOpenSettings = (app: WorkerScriptWithCreator) => {
    setSelectedApp(app);
    setSettingsDialogOpen(true);
  };

  const handleSettingsSuccess = () => {
    if (revalidator.state === 'idle') {
      revalidator.revalidate();
      setReferenceTime(Date.now());
    }
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

  const currentMembership = orgs.find((entry) => entry.org_id === currentOrg?.id);
  const isAdmin = currentMembership?.role === 'owner' || currentMembership?.role === 'admin';
  const currentWorkspaceId = currentWorkspace?.id ?? null;

  const handleFilterChange = useCallback(
    (value: 'this-workspace' | 'all-workspaces') => {
      setSearchParams({ filter: value });
    },
    [setSearchParams]
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

            
            {loading ? (
              <div className="@container">
                <div className="mt-6 grid gap-4 @[580px]:grid-cols-2 @[880px]:grid-cols-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <AppCardSkeleton key={i} />
                  ))}
                </div>
              </div>
            ) : apps.length === 0 ? (
              <div className="mt-32 flex flex-col items-center justify-center text-center">
                <div className="flex size-24 items-center justify-center rounded-full bg-muted">
                  <LayoutGrid className="size-10 text-muted-foreground" />
                </div>
                <h2 className="mt-6 text-2xl font-semibold">No apps yet</h2>
                <p className="mt-2 text-muted-foreground">
                  Deploy an app to see your published apps here.
                </p>
              </div>
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
          orgId={orgId}
          isAdmin={isAdmin}
          hostname={hostname}
          onSuccess={handleSettingsSuccess}
        />
      )}
    </>
  );
}
