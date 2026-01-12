'use client';

import { useState, useEffect } from 'react';
import type { WorkerScript } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, ExternalLink } from 'lucide-react';
import { setAppPublic } from '@/lib/server-actions/apps';

interface EditAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: WorkerScript;
  orgId: string;
  onSuccess: () => void;
}

export function EditAppDialog({
  open,
  onOpenChange,
  app,
  orgId,
  onSuccess,
}: EditAppDialogProps) {
  const [isPublic, setIsPublic] = useState(app.is_public);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when app changes
  useEffect(() => {
    setIsPublic(app.is_public);
    setError(null);
  }, [app]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Only submit if value changed
    if (isPublic === app.is_public) {
      onSuccess();
      return;
    }

    setSubmitting(true);

    try {
      await setAppPublic(orgId, app.script_name, isPublic);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update app');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setIsPublic(app.is_public);
    setError(null);
    onOpenChange(false);
  };

  const getAppUrl = (scriptName: string) => {
    return `https://${scriptName}.chiridion.ai`;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>App Settings</DialogTitle>
          <DialogDescription>
            Configure settings for {app.script_name}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* App Info */}
            <div className="grid gap-1.5">
              <Label className="text-muted-foreground">URL</Label>
              <a
                href={getAppUrl(app.script_name)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-primary hover:underline"
              >
                {getAppUrl(app.script_name)}
                <ExternalLink className="size-3" />
              </a>
            </div>

            <div className="grid gap-1.5">
              <Label className="text-muted-foreground">Deployed</Label>
              <p className="text-sm">
                {new Date(app.created_at).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label className="text-muted-foreground">Last Updated</Label>
              <p className="text-sm">
                {new Date(app.updated_at).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
            </div>

            {/* Access Settings */}
            <div className="mt-2 border-t pt-4">
              <p className="mb-3 text-sm font-medium">Access</p>
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <Label htmlFor="public-access">Public Access</Label>
                  <p className="text-sm text-muted-foreground">
                    {isPublic
                      ? 'Anyone can access this app without authentication'
                      : 'Only organization members can access this app'}
                  </p>
                </div>
                <Switch
                  id="public-access"
                  checked={isPublic}
                  onCheckedChange={setIsPublic}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
