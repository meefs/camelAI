'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { updateAdminThread } from '@/lib/server-actions/admin';

interface Thread {
  id: string;
  title: string;
  project_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface ThreadEditFormProps {
  thread: Thread;
}

export function ThreadEditForm({ thread }: ThreadEditFormProps) {
  const router = useRouter();
  const [title, setTitle] = useState(thread.title);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      await updateAdminThread(thread.id, { title });

      setSuccess(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert>
          <AlertDescription>Thread updated successfully</AlertDescription>
        </Alert>
      )}

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

      <Button type="submit" disabled={loading}>
        {loading ? 'Saving...' : 'Save Changes'}
      </Button>
    </form>
  );
}
