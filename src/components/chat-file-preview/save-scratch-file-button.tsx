'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useChatPreviewContext } from '@/components/chat-preview/preview-context';
import type { PreviewTarget } from '@/types';

interface SaveScratchFileButtonProps {
  threadId: string;
  /** The scratch file as the agent sees it (/workspace/...). */
  path: string;
  workspaceId?: string;
}

/**
 * "Save to workspace" for a runtime thread's scratch file: the thread's files
 * route copies it into the workspace's outputs/, then the saved copy can be
 * opened in the preview panel.
 */
export function SaveScratchFileButton({ threadId, path, workspaceId }: SaveScratchFileButtonProps) {
  const [saving, setSaving] = useState(false);
  const previewContext = useChatPreviewContext();

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/files/save`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, ...(workspaceId ? { workspaceId } : {}) }),
      });
      const data = (await response.json().catch(() => null)) as
        | { saved?: { path: string }; previewTarget?: PreviewTarget; error?: string }
        | null;
      if (!response.ok || !data?.saved) {
        toast.error(data?.error ?? 'Could not save the file to the workspace.');
        return;
      }
      const target = data.previewTarget;
      toast.success(
        `Saved to ${data.saved.path}`,
        target && previewContext
          ? { action: { label: 'Open', onClick: () => previewContext.openPreviewTarget(target) } }
          : undefined,
      );
    } catch {
      toast.error('Could not save the file to the workspace.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs text-muted-foreground"
      disabled={saving}
      onClick={() => void save()}
    >
      {saving ? 'Saving…' : 'Save to workspace'}
    </Button>
  );
}
