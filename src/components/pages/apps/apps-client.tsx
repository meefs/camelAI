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
import { ContainerLoadingDialog } from '@/components/container-loading-dialog';
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
  const chatFetcher = useFetcher<{
    success?: boolean;
    thread?: Thread;
    error?: string;
    requestId?: string;
  }>();
  const filter = (searchParams.get('filter') as 'this-workspace' | 'all-workspaces') || 'this-workspace';

  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [selectedApp, setSelectedApp] = useState<WorkerScriptWithCreator | null>(null);
  const [referenceTime, setReferenceTime] = useState(initialNow);
  const pendingChatAppRef = useRef<string | null>(null);
  const activeChatRequestIdRef = useRef<string | null>(null);

  // Switch workspace dialog state
  const [switchDialog, setSwitchDialog] = useState<{
    open: boolean;
    app: WorkerScriptWithCreator | null;
    workspace: WorkspaceWithAccess | null;
    action: 'chat' | 'viewSource' | null;
  }>({ open: false, app: null, workspace: null, action: null });
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [containerDialog, setContainerDialog] = useState<{
    open: boolean;
    workspace: WorkspaceWithAccess | null;
    action: 'chat' | 'viewSource' | null;
  }>({ open: false, workspace: null, action: null });
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
    const responseRequestId = chatFetcher.data?.requestId;
    if (!responseRequestId) {
      if (activeChatRequestIdRef.current || pendingChatAppRef.current) {
        activeChatRequestIdRef.current = null;
        pendingChatAppRef.current = null;
        setContainerDialog({ open: false, workspace: null, action: null });
      }
      return;
    }

    if (responseRequestId !== activeChatRequestIdRef.current) {
      pendingChatAppRef.current = null;
      return;
    }

    if (chatFetcher.data?.success && chatFetcher.data.thread) {
      navigate(`/chat/${chatFetcher.data.thread.id}`);
    } else if (chatFetcher.data?.error) {
      toast.error(chatFetcher.data.error);
      setContainerDialog({ open: false, workspace: null, action: null });
    }

    activeChatRequestIdRef.current = null;
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

    const requestId = crypto.randomUUID();
    activeChatRequestIdRef.current = requestId;
    chatFetcher.submit(
      {
        intent: 'startChatForApp',
        appName: app.script_name,
        workspaceId: app.workspace_id,
        hostname: hostname ?? '',
        configPath: app.config_path ?? '',
        requestId,
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
    const targetWorkspace = switchDialog.workspace;
    const targetApp = switchDialog.app;
    const targetAction = switchDialog.action;

    setSwitchingWorkspace(true);
    try {
      await switchWorkspace(targetWorkspace.id);
      setSwitchDialog({ open: false, app: null, workspace: null, action: null });
      setContainerDialog({ open: true, workspace: targetWorkspace, action: targetAction });

      // After switch, perform the original action
      if (targetAction === 'chat') {
        // Re-trigger chat start - workspace is now correct
        const requestId = crypto.randomUUID();
        activeChatRequestIdRef.current = requestId;
        chatFetcher.submit(
          {
            intent: 'startChatForApp',
            appName: targetApp.script_name,
            workspaceId: targetApp.workspace_id,
            hostname: hostname ?? '',
            configPath: targetApp.config_path ?? '',
            requestId,
          },
          { method: 'post' }
        );
      } else if (targetAction === 'viewSource' && targetApp.config_path) {
        const filePath = encodeURIComponent(targetApp.config_path);
        navigate(`/computer/${targetApp.workspace_id}?file=${filePath}`);
      }
    } catch (error) {
      toast.error('Failed to switch workspace');
      console.error('Failed to switch workspace:', error);
    } finally {
      setSwitchingWorkspace(false);
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

      {containerDialog.workspace ? (
        <ContainerLoadingDialog
          open={containerDialog.open}
          onOpenChange={(open) => {
            if (!open) {
              setContainerDialog({ open: false, workspace: null, action: null });
            }
          }}
          workspace={containerDialog.workspace}
          title="Starting workspace..."
          description={
            containerDialog.action === 'chat'
              ? "We're spinning up the {workspace} container to start your chat. This can take up to 20 seconds."
              : containerDialog.action === 'viewSource'
                ? "We're spinning up the {workspace} container to open the file browser. This can take up to 20 seconds."
                : "We're spinning up the {workspace} container. This can take up to 20 seconds."
          }
          statusLabel="Warming container..."
        />
      ) : null}
    </>
  );
}
