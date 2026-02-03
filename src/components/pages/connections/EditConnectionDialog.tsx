'use client';

import { useState, useEffect } from 'react';
import { useFetcher } from 'react-router';
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
import { Textarea } from '@/components/ui/textarea';
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

const applyDefaults = (
  schema: IntegrationDefinition['configSchema'],
  current: Record<string, unknown>
) => {
  const next = { ...current };
  for (const field of schema) {
    if (field.default === undefined) continue;
    const value = next[field.name];
    if (value === undefined || value === null || value === '') {
      next[field.name] = field.default;
    }
  }
  return next;
};

export function EditConnectionDialog({
  open,
  onOpenChange,
  connection,
  connectionTypes,
  orgId,
  onSuccess,
}: EditConnectionDialogProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [name, setName] = useState(connection.name);
  const [config, setConfig] = useState<Record<string, unknown>>(connection.config);
  const [credentials, setCredentials] = useState<Record<string, unknown>>({});
  const [shouldUpdateCredentials, setShouldUpdateCredentials] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitting = fetcher.state !== 'idle';
  const typeDef = connectionTypes.find((t) => t.type === connection.integration_type);

  // Reset form when connection changes
  useEffect(() => {
    setName(connection.name);
    setConfig(typeDef ? applyDefaults(typeDef.configSchema, connection.config) : connection.config);
    setCredentials({});
    setShouldUpdateCredentials(false);
    setError(null);
  }, [connection, typeDef]);

  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.success) {
        onSuccess();
      } else if (fetcher.data.error) {
        setError(fetcher.data.error);
      }
    }
  }, [fetcher.state, fetcher.data, onSuccess]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const nextConfig = typeDef ? applyDefaults(typeDef.configSchema, config) : config;

    fetcher.submit(
      {
        intent: 'updateIntegration',
        integrationId: connection.id,
        name: name.trim(),
        config: JSON.stringify(nextConfig),
        ...(shouldUpdateCredentials ? { credentials: JSON.stringify(credentials) } : {}),
      },
      { method: 'POST' }
    );
  };

  const handleClose = () => {
    setName(connection.name);
    setConfig(connection.config);
    setCredentials({});
    setShouldUpdateCredentials(false);
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
          <div className="max-h-[60vh] overflow-y-auto pr-4">
            <div className="grid gap-4 py-2">
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
                {field.description && (
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                )}
              </div>
            ))}

            {/* Credentials section */}
            {typeDef.credentialSchema.length > 0 && (
              <>
                <div className="mt-2 border-t pt-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-medium">Credentials</p>
                    {connection.has_credentials && !shouldUpdateCredentials && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShouldUpdateCredentials(true)}
                      >
                        <Key className="mr-2 size-3" />
                        Update Credentials
                      </Button>
                    )}
                  </div>

                  {connection.has_credentials && !shouldUpdateCredentials ? (
                    <Alert>
                      <AlertDescription>
                        Credentials are stored securely. Click &quot;Update Credentials&quot; to replace
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
                        {field.type === 'textarea' ? (
                          <Textarea
                            id={`edit-cred-${field.name}`}
                            value={(credentials[field.name] as string) || ''}
                            onChange={(e) =>
                              handleCredentialChange(field.name, e.target.value)
                            }
                            placeholder={field.placeholder}
                            required={shouldUpdateCredentials && field.required}
                            rows={6}
                            className="font-mono text-xs"
                          />
                        ) : (
                          <Input
                            id={`edit-cred-${field.name}`}
                            type={field.type === 'password' ? 'password' : 'text'}
                            value={(credentials[field.name] as string) || ''}
                            onChange={(e) =>
                              handleCredentialChange(field.name, e.target.value)
                            }
                            placeholder={field.placeholder}
                            required={shouldUpdateCredentials && field.required}
                          />
                        )}
                        {field.description && (
                          <p className="text-xs text-muted-foreground">{field.description}</p>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
            </div>
          </div>

          <DialogFooter className="mt-4">
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
