"use client";

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { updateAdminApp } from '@/lib/server-actions/admin';

interface AppEditFormProps {
  app: {
    script_name: string;
    org_id: string;
    is_public: boolean;
  };
}

export function AppEditForm({ app }: AppEditFormProps) {
  const navigate = useNavigate();
  const [isPublic, setIsPublic] = useState(app.is_public);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      await updateAdminApp(app.org_id, app.script_name, { is_public: isPublic });
      setSuccess(true);
      // TODO: implement refresh;
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
          <AlertDescription>App updated successfully</AlertDescription>
        </Alert>
      )}

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

      <Button type="submit" disabled={loading || isPublic === app.is_public}>
        {loading ? 'Saving...' : 'Save Changes'}
      </Button>
    </form>
  );
}
