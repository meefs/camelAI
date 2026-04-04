'use client';

import { useEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LLM_MODEL_OPTIONS } from '@/lib/llm-provider-config';
import type { LlmModel } from '@/types';

interface Thread {
  id: string;
  title: string;
  created_by: string;
  model: LlmModel;
  created_at: number;
  updated_at: number;
}

interface ThreadEditFormProps {
  thread: Thread;
  orgId: string;
}

export function ThreadEditForm({ thread, orgId }: ThreadEditFormProps) {
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
        <Label htmlFor="thread-model">Claude Model</Label>
        <Select value={model} onValueChange={(value) => setModel(value as LlmModel)}>
          <SelectTrigger id="thread-model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LLM_MODEL_OPTIONS.map((option) => (
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
      </div>

      <Button type="submit" disabled={saving || !hasChanges}>
        {saving ? 'Saving...' : 'Save Changes'}
      </Button>
    </form>
  );
}
