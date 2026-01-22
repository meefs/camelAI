"use client";

import { useEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

interface AppEditFormProps {
  app: {
    script_name: string;
    org_id: string;
    is_public: boolean;
  };
}

export function AppEditForm({ app }: AppEditFormProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [isPublic, setIsPublic] = useState(app.is_public);
  const saving = fetcher.state !== 'idle';

  // Handle response
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.success) {
        toast.success('App updated');
      } else if (fetcher.data.error) {
        toast.error(fetcher.data.error);
      }
    }
  }, [fetcher.state, fetcher.data]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    fetcher.submit(
      { intent: 'updateApp', isPublic: isPublic ? 'true' : 'false' },
      { method: 'POST' }
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="is-public">Public Access</Label>
          <p className="text-sm text-muted-foreground">
            When enabled, anyone can access this app without authentication
          </p>
        </div>
        <Switch
          id="is-public"
          checked={isPublic}
          onCheckedChange={setIsPublic}
        />
      </div>

      <Button type="submit" disabled={saving || isPublic === app.is_public}>
        {saving ? 'Saving...' : 'Save Changes'}
      </Button>
    </form>
  );
}
