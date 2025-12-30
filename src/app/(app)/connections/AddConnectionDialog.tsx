'use client';

import { useState } from 'react';
import type { IntegrationDefinition } from '@/lib/integration-registry';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';

interface AddConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionType: string;
  connectionTypes: IntegrationDefinition[];
  orgId: string;
  onSuccess: () => void;
}

export function AddConnectionDialog({
  open,
  onOpenChange,
  connectionType,
  connectionTypes,
  orgId,
  onSuccess,
}: AddConnectionDialogProps) {
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [credentials, setCredentials] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeDef = connectionTypes.find((t) => t.type === connectionType);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch(`/api/orgs/${orgId}/integrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: connectionType,
          name: name.trim() || typeDef?.displayName || connectionType,
          config,
          credentials,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || 'Failed to create connection');
      }

      // Reset form
      setName('');
      setConfig({});
      setCredentials({});
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create connection');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setName('');
    setConfig({});
    setCredentials({});
    setError(null);
    onOpenChange(false);
  };

  const updateConfig = (field: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
  };

  const updateCredentials = (field: string, value: unknown) => {
    setCredentials((prev) => ({ ...prev, [field]: value }));
  };

  if (!typeDef) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add {typeDef.displayName}</DialogTitle>
          <DialogDescription>{typeDef.description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* Name field */}
            <div className="grid gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={typeDef.displayName}
              />
              <p className="text-xs text-muted-foreground">
                A friendly name to identify this connection
              </p>
            </div>

            {/* Config fields */}
            {typeDef.configSchema.map((field) => (
              <div key={field.name} className="grid gap-1.5">
                <Label htmlFor={field.name}>
                  {field.label}
                  {field.required && <span className="ml-1 text-red-400">*</span>}
                </Label>
                {field.type === 'select' && field.options ? (
                  <Select
                    value={(config[field.name] as string) || (field.default as string) || ''}
                    onValueChange={(value) => updateConfig(field.name, value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
                    </SelectTrigger>
                    <SelectContent>
                      {field.options.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={field.name}
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={(config[field.name] as string) ?? (field.default as string) ?? ''}
                    onChange={(e) =>
                      updateConfig(
                        field.name,
                        field.type === 'number' ? Number(e.target.value) : e.target.value
                      )
                    }
                    placeholder={field.placeholder}
                    required={field.required}
                  />
                )}
              </div>
            ))}

            {/* Credential fields */}
            {typeDef.credentialSchema.length > 0 && (
              <>
                <div className="mt-2 border-t pt-4">
                  <p className="mb-3 text-sm font-medium">
                    Credentials
                  </p>
                </div>
                {typeDef.credentialSchema.map((field) => (
                  <div key={field.name} className="grid gap-1.5">
                    <Label htmlFor={`cred-${field.name}`}>
                      {field.label}
                      {field.required && <span className="ml-1 text-red-400">*</span>}
                    </Label>
                    <Input
                      id={`cred-${field.name}`}
                      type={field.type === 'password' ? 'password' : 'text'}
                      value={(credentials[field.name] as string) || ''}
                      onChange={(e) => updateCredentials(field.name, e.target.value)}
                      placeholder={field.placeholder}
                      required={field.required}
                    />
                  </div>
                ))}
              </>
            )}

            {/* OAuth notice */}
            {typeDef.authMethod === 'oauth2' && (
              <Alert>
                <AlertDescription>
                  This connection uses OAuth 2.0. After saving, you'll be redirected to
                  authorize access.
                </AlertDescription>
              </Alert>
            )}
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
              {submitting ? 'Creating...' : 'Create Connection'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
