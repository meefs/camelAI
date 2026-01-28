'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFetcher, useSearchParams, useRevalidator, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import type { Thread, WorkspaceWithAccess } from '@/types';

import type { WorkerScriptWithCreator } from '@/types';
import { PageHeader } from '@/components/page-header';
import { AppCard } from './AppCard';
import { AppSettingsDialog } from './AppSettingsDialog';
import { AppCardSkeleton } from './AppCardSkeleton';
import { SwitchWorkspaceDialog } from '@/components/history/switch-workspace-dialog';
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
    switchWorkspace,
  } = useAuth();

  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const chatFetcher = useFetcher<{ success?: boolean; thread?: Thread; error?: string }>();
  const filter = (searchParams.get('filter') as 'this-workspace' | 'all-workspaces') || 'this-workspace';

  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [selectedApp, setSelectedApp] = useState<WorkerScriptWithCreator | null>(null);
  const [referenceTime, setReferenceTime] = useState(initialNow);
  const pendingChatAppRef = useRef<string | null>(null);

  // Switch workspace dialog state
  const [switchDialog, setSwitchDialog] = useState<{
    open: boolean;
    app: WorkerScriptWithCreator | null;
    workspace: WorkspaceWithAccess | null;
    action: 'chat' | 'viewSource' | null;
  }>({ open: false, app: null, workspace: null, action: null });
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
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

  // Handle chat creation result
  useEffect(() => {
    if (chatFetcher.state !== 'idle') return;

    if (chatFetcher.data?.success && chatFetcher.data.thread) {
      navigate(`/chat/${chatFetcher.data.thread.id}`);
    } else if (chatFetcher.data?.error) {
      toast.error(chatFetcher.data.error);
    }

    pendingChatAppRef.current = null;
  }, [chatFetcher.state, chatFetcher.data, navigate]);

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

  const handleStartChat = useCallback((app: WorkerScriptWithCreator) => {
    if (!currentWorkspace?.id) {
      toast.error('No workspace selected');
      return;
    }

    // Check if app is in a different workspace - open switch dialog
    if (app.workspace_id !== currentWorkspace.id) {
      const targetWorkspace = workspaceMap.get(app.workspace_id);
      if (targetWorkspace) {
        setSwitchDialog({ open: true, app, workspace: targetWorkspace, action: 'chat' });
      } else {
        toast.error('Could not find target workspace');
      }
      return;
    }

    // Prevent double-clicks while fetcher is busy
    if (chatFetcher.state !== 'idle') return;
    if (pendingChatAppRef.current === app.script_name) return;
    pendingChatAppRef.current = app.script_name;

    chatFetcher.submit(
      {
        intent: 'startChatForApp',
        appName: app.script_name,
        workspaceId: app.workspace_id,
        hostname: hostname ?? '',
        configPath: app.config_path ?? '',
      },
      { method: 'post' }
    );
  }, [currentWorkspace?.id, chatFetcher, hostname, workspaceMap]);

  const handleViewSource = useCallback((app: WorkerScriptWithCreator) => {
    if (!app.config_path) {
      toast.error('Source file location not available for this app');
      return;
    }

    // Check if app is in a different workspace - open switch dialog
    if (currentWorkspace?.id && app.workspace_id !== currentWorkspace.id) {
      const targetWorkspace = workspaceMap.get(app.workspace_id);
      if (targetWorkspace) {
        setSwitchDialog({ open: true, app, workspace: targetWorkspace, action: 'viewSource' });
      } else {
        toast.error('Could not find target workspace');
      }
      return;
    }

    // Navigate to computer tab with the file path
    const filePath = encodeURIComponent(app.config_path);
    navigate(`/computer/${app.workspace_id}?file=${filePath}`);
  }, [navigate, currentWorkspace?.id, workspaceMap]);

  const currentMembership = orgs.find((entry) => entry.org_id === currentOrg?.id);
  const isAdmin = currentMembership?.role === 'owner' || currentMembership?.role === 'admin';
  const currentWorkspaceId = currentWorkspace?.id ?? null;

  const handleFilterChange = useCallback(
    (value: 'this-workspace' | 'all-workspaces') => {
      setSearchParams({ filter: value });
    },
    [setSearchParams]
  );

  // Handle workspace switch confirmation
  const handleConfirmSwitch = useCallback(async () => {
    if (!switchDialog.workspace || !switchDialog.app) return;

    setSwitchingWorkspace(true);
    try {
      await switchWorkspace(switchDialog.workspace.id);

      // After switch, perform the original action
      if (switchDialog.action === 'chat') {
        // Re-trigger chat start - workspace is now correct
        chatFetcher.submit(
          {
            intent: 'startChatForApp',
            appName: switchDialog.app.script_name,
            workspaceId: switchDialog.app.workspace_id,
            hostname: hostname ?? '',
            configPath: switchDialog.app.config_path ?? '',
          },
          { method: 'post' }
        );
      } else if (switchDialog.action === 'viewSource' && switchDialog.app.config_path) {
        const filePath = encodeURIComponent(switchDialog.app.config_path);
        navigate(`/computer/${switchDialog.app.workspace_id}?file=${filePath}`);
      }
    } catch (error) {
      toast.error('Failed to switch workspace');
      console.error('Failed to switch workspace:', error);
    } finally {
      setSwitchingWorkspace(false);
      setSwitchDialog({ open: false, app: null, workspace: null, action: null });
    }
  }, [switchDialog, switchWorkspace, chatFetcher, hostname, navigate]);

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

      {switchDialog.workspace && (
        <SwitchWorkspaceDialog
          open={switchDialog.open}
          onOpenChange={(open) => {
            if (!open) {
              setSwitchDialog({ open: false, app: null, workspace: null, action: null });
            }
          }}
          workspace={switchDialog.workspace}
          onConfirm={handleConfirmSwitch}
          loading={switchingWorkspace}
          description={
            switchDialog.action === 'chat'
              ? 'This app belongs to a different workspace. Switch to {workspace} to start a chat about this app.'
              : 'This app belongs to a different workspace. Switch to {workspace} to view the source file.'
          }
        />
      )}
    </>
  );
}
