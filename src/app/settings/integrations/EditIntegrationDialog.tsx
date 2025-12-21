'use client';

import { useState, useEffect } from 'react';
import type { Integration } from '@/types';
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
import { AlertCircle, Key } from 'lucide-react';

interface EditIntegrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integration: Integration;
  integrationTypes: IntegrationDefinition[];
  orgId: string;
  onSuccess: () => void;
}

export function EditIntegrationDialog({
  open,
  onOpenChange,
  integration,
  integrationTypes,
  orgId,
  onSuccess,
}: EditIntegrationDialogProps) {
  const [name, setName] = useState(integration.name);
  const [config, setConfig] = useState<Record<string, unknown>>(integration.config);
  const [credentials, setCredentials] = useState<Record<string, unknown>>({});
  const [updateCredentials, setUpdateCredentials] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeDef = integrationTypes.find((t) => t.type === integration.integration_type);

  // Reset form when integration changes
  useEffect(() => {
    setName(integration.name);
    setConfig(integration.config);
    setCredentials({});
    setUpdateCredentials(false);
    setError(null);
  }, [integration]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        config,
      };

      if (updateCredentials) {
        body.credentials = credentials;
      }

      const res = await fetch(`/api/orgs/${orgId}/integrations/${integration.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || 'Failed to update integration');
      }

      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update integration');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setName(integration.name);
    setConfig(integration.config);
    setCredentials({});
    setUpdateCredentials(false);
    setError(null);
    onOpenChange(false);
  };

  const handleConfigChange = (field: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
  };

  const handleCredentialChange = (field: string, value: unknown) => {
    setCredentials((prev) => ({ ...prev, [field]: value }));
  };

  if (!typeDef) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {integration.name}</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Update configuration for this {typeDef.displayName} integration
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

            {/* Name field */}
            <div className="grid gap-1.5">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={typeDef.displayName}
                required
                className="border-zinc-700 bg-zinc-800"
              />
            </div>

            {/* Config fields */}
            {typeDef.configSchema.map((field) => (
              <div key={field.name} className="grid gap-1.5">
                <Label htmlFor={`edit-${field.name}`}>
                  {field.label}
                  {field.required && <span className="ml-1 text-red-400">*</span>}
                </Label>
                {field.type === 'select' && field.options ? (
                  <Select
                    value={(config[field.name] as string) || (field.default as string) || ''}
                    onValueChange={(value) => handleConfigChange(field.name, value)}
                  >
                    <SelectTrigger className="border-zinc-700 bg-zinc-800">
                      <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
                    </SelectTrigger>
                    <SelectContent className="border-zinc-700 bg-zinc-800">
                      {field.options.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={`edit-${field.name}`}
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={(config[field.name] as string) ?? (field.default as string) ?? ''}
                    onChange={(e) =>
                      handleConfigChange(
                        field.name,
                        field.type === 'number' ? Number(e.target.value) : e.target.value
                      )
                    }
                    placeholder={field.placeholder}
                    required={field.required}
                    className="border-zinc-700 bg-zinc-800"
                  />
                )}
              </div>
            ))}

            {/* Credentials section */}
            {typeDef.credentialSchema.length > 0 && (
              <>
                <div className="mt-2 border-t border-zinc-800 pt-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-medium text-zinc-300">Credentials</p>
                    {integration.has_credentials && !updateCredentials && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setUpdateCredentials(true)}
                      >
                        <Key className="mr-2 size-3" />
                        Update Credentials
                      </Button>
                    )}
                  </div>

                  {integration.has_credentials && !updateCredentials ? (
                    <Alert className="border-zinc-700 bg-zinc-800">
                      <AlertDescription className="text-zinc-400">
                        Credentials are stored securely. Click &quot;Update Credentials&quot; to
                        replace them.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    typeDef.credentialSchema.map((field) => (
                      <div key={field.name} className="mb-3 grid gap-1.5">
                        <Label htmlFor={`edit-cred-${field.name}`}>
                          {field.label}
                          {field.required && (
                            <span className="ml-1 text-red-400">*</span>
                          )}
                        </Label>
                        <Input
                          id={`edit-cred-${field.name}`}
                          type={field.type === 'password' ? 'password' : 'text'}
                          value={(credentials[field.name] as string) || ''}
                          onChange={(e) =>
                            handleCredentialChange(field.name, e.target.value)
                          }
                          placeholder={field.placeholder}
                          required={updateCredentials && field.required}
                          className="border-zinc-700 bg-zinc-800"
                        />
                      </div>
                    ))
                  )}
                </div>
              </>
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
              {submitting ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
