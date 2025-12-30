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

interface EditConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: Integration;
  connectionTypes: IntegrationDefinition[];
  orgId: string;
  onSuccess: () => void;
}

export function EditConnectionDialog({
  open,
  onOpenChange,
  connection,
  connectionTypes,
  orgId,
  onSuccess,
}: EditConnectionDialogProps) {
  const [name, setName] = useState(connection.name);
  const [config, setConfig] = useState<Record<string, unknown>>(connection.config);
  const [credentials, setCredentials] = useState<Record<string, unknown>>({});
  const [updateCredentials, setUpdateCredentials] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeDef = connectionTypes.find((t) => t.type === connection.integration_type);

  // Reset form when connection changes
  useEffect(() => {
    setName(connection.name);
    setConfig(connection.config);
    setCredentials({});
    setUpdateCredentials(false);
    setError(null);
  }, [connection]);

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

      const res = await fetch(`/api/orgs/${orgId}/integrations/${connection.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || 'Failed to update connection');
      }

      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update connection');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setName(connection.name);
    setConfig(connection.config);
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {connection.name}</DialogTitle>
          <DialogDescription>
            Update configuration for this {typeDef.displayName} connection
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
                  />
                )}
              </div>
            ))}

            {/* Credentials section */}
            {typeDef.credentialSchema.length > 0 && (
              <>
                <div className="mt-2 border-t pt-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-medium">Credentials</p>
                    {connection.has_credentials && !updateCredentials && (
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

                  {connection.has_credentials && !updateCredentials ? (
                    <Alert>
                      <AlertDescription>
                        Credentials are stored securely. Click "Update Credentials" to replace
                        them.
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
