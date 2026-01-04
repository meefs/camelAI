'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Organization } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { updateAdminOrg } from '@/lib/server-actions/admin';

interface OrgEditFormProps {
  org: Organization;
}

export function OrgEditForm({ org }: OrgEditFormProps) {
  const router = useRouter();
  const [name, setName] = useState(org.name);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      await updateAdminOrg(org.id, { name });

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
          <AlertDescription>Organization updated successfully</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="name">Organization Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter organization name"
          required
        />
      </div>

      <Button type="submit" disabled={loading}>
        {loading ? 'Saving...' : 'Save Changes'}
      </Button>
    </form>
  );
}
