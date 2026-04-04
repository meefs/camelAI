'use client';

import { useEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getVisibleLlmModelOptions, THREAD_MODEL_LOCK_MESSAGE } from '@/lib/llm-provider-config';
import type { ChatHarness, LlmModel, OrganizationExperimentalSettings } from '@/types';

interface Thread {
  id: string;
  title: string;
  created_by: string;
  provider: ChatHarness;
  model: LlmModel;
  created_at: number;
  updated_at: number;
}

interface ThreadEditFormProps {
  thread: Thread;
  orgId: string;
  experimentalSettings: OrganizationExperimentalSettings;
}

export function ThreadEditForm({ thread, orgId, experimentalSettings }: ThreadEditFormProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [title, setTitle] = useState(thread.title);
  const [model, setModel] = useState<LlmModel>(thread.model);
  const saving = fetcher.state !== 'idle';
  const hasChanges = title.trim() !== thread.title || model !== thread.model;

  useEffect(() => {
    setTitle(thread.title);
    setModel(thread.model);
  }, [thread.title, thread.model]);

  // Handle response
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.success) {
        toast.success('Thread updated');
      } else if (fetcher.data.error) {
        toast.error(fetcher.data.error);
      }
    }
  }, [fetcher.state, fetcher.data]);

  const modelOptions = getVisibleLlmModelOptions(thread.provider, experimentalSettings, thread.model);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetcher.submit(
      {
        intent: 'updateThread',
        title: title.trim(),
        ...(model !== thread.model ? { model } : {}),
        orgId,
      },
      { method: 'POST' }
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="title">Thread Title</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Enter thread title"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="thread-model">Thread Model</Label>
        <Select value={model} onValueChange={(value) => setModel(value as LlmModel)} disabled>
          <SelectTrigger id="thread-model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                description={option.description}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{THREAD_MODEL_LOCK_MESSAGE}</p>
      </div>

      <Button type="submit" disabled={saving || !hasChanges}>
        {saving ? 'Saving...' : 'Save Changes'}
      </Button>
    </form>
  );
}
