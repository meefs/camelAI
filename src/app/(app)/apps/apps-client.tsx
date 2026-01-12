'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';

import type { WorkerScript } from '@/types';
import { PageHeader } from '@/components/page-header';
import { EditAppDialog } from './EditAppDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertCircle,
  Boxes,
  ExternalLink,
  Settings,
  Trash2,
} from 'lucide-react';
import { getOrgApps, setAppPublic, deleteApp } from '@/lib/server-actions/apps';

interface AppsClientProps {
  initialApps: WorkerScript[];
  orgId: string;
}

export default function AppsClient({
  initialApps,
  orgId,
}: AppsClientProps) {
  const { currentOrg, orgs, loading: authLoading } = useAuth();

  const [apps, setApps] = useState<WorkerScript[]>(initialApps);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedApp, setSelectedApp] = useState<WorkerScript | null>(null);
  const [activeOrgId, setActiveOrgId] = useState(orgId);
  const [deleteTarget, setDeleteTarget] = useState<WorkerScript | null>(null);

  const refreshApps = useCallback(
    async (targetOrgId = activeOrgId) => {
      if (!targetOrgId) return;
      try {
        setLoading(true);
        setError(null);
        const data = await getOrgApps(targetOrgId);
        setApps(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load apps');
      } finally {
        setLoading(false);
      }
    },
    [activeOrgId]
  );

  useEffect(() => {
    if (currentOrg?.id && currentOrg.id !== activeOrgId) {
      setActiveOrgId(currentOrg.id);
      refreshApps(currentOrg.id);
    }
  }, [currentOrg?.id, activeOrgId, refreshApps]);

  const handleTogglePublic = async (app: WorkerScript) => {
    if (!activeOrgId) return;

    try {
      setError(null);
      await setAppPublic(activeOrgId, app.script_name, !app.is_public);
      await refreshApps(activeOrgId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update app');
    }
  };

  const handleDelete = async () => {
    if (!activeOrgId || !deleteTarget) return;

    try {
      setError(null);
      await deleteApp(activeOrgId, deleteTarget.script_name);
      setDeleteTarget(null);
      await refreshApps(activeOrgId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete app');
    }
  };

  const handleEditClick = (app: WorkerScript) => {
    setSelectedApp(app);
    setEditDialogOpen(true);
  };

  const handleEditSuccess = () => {
    setEditDialogOpen(false);
    setSelectedApp(null);
    refreshApps(activeOrgId);
  };

  const handleEditDialogOpenChange = (open: boolean) => {
    setEditDialogOpen(open);
    if (!open) {
      setSelectedApp(null);
    }
  };

  const getAppUrl = (scriptName: string) => {
    // TODO: Make this configurable based on environment
    return `https://${scriptName}.chiridion.ai`;
  };

  const isLoading = authLoading || loading;
  const currentMembership = orgs.find((entry) => entry.org_id === currentOrg?.id);
  const isAdmin = currentMembership?.role === 'owner' || currentMembership?.role === 'admin';

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

            {error && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {isLoading ? (
              <div className="mt-6 flex items-center justify-center py-16 text-sm text-muted-foreground">
                Loading apps...
              </div>
            ) : apps.length === 0 ? (
              <Card className="mt-6 border-dashed">
                <CardHeader className="flex flex-row items-start gap-4">
                  <div className="flex size-12 items-center justify-center rounded-lg bg-muted">
                    <Boxes className="size-5" />
                  </div>
                  <div>
                    <CardTitle>No apps deployed yet</CardTitle>
                    <CardDescription>
                      Deploy an app from a chat conversation to see it here.
                    </CardDescription>
                  </div>
                </CardHeader>
              </Card>
            ) : (
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {apps.map((app) => (
                  <Card key={app.script_name}>
                    <CardHeader className="flex flex-row items-start justify-between gap-4">
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 items-center justify-center rounded-lg border">
                          <Boxes className="size-5" />
                        </div>
                        <div>
                          <CardTitle className="flex items-center gap-2">
                            {app.script_name}
                            <a
                              href={getAppUrl(app.script_name)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <ExternalLink className="size-4" />
                            </a>
                          </CardTitle>
                          <CardDescription>
                            Deployed {new Date(app.created_at).toLocaleDateString()}
                          </CardDescription>
                        </div>
                      </div>
                      <Badge variant={app.is_public ? 'default' : 'secondary'}>
                        {app.is_public ? 'Public' : 'Private'}
                      </Badge>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex items-center justify-between text-sm text-muted-foreground">
                        <span>Last updated</span>
                        <span>
                          {new Date(app.updated_at).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm">
                          <span>Public access</span>
                          <Switch
                            checked={app.is_public}
                            onCheckedChange={() => handleTogglePublic(app)}
                            disabled={!isAdmin}
                          />
                        </div>
                        {isAdmin && (
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleEditClick(app)}
                            >
                              <Settings className="mr-2 size-3.5" />
                              Settings
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:text-destructive"
                              onClick={() => setDeleteTarget(app)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {selectedApp && (
        <EditAppDialog
          open={editDialogOpen}
          onOpenChange={handleEditDialogOpenChange}
          app={selectedApp}
          orgId={activeOrgId}
          onSuccess={handleEditSuccess}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete app?"
        description={
          deleteTarget
            ? `Are you sure you want to delete "${deleteTarget.script_name}"? This will remove the deployed worker. This action cannot be undone.`
            : 'Are you sure you want to delete this app?'
        }
        confirmLabel="Delete app"
        variant="destructive"
        onConfirm={() => {
          void handleDelete();
        }}
      />
    </>
  );
}
