'use client';

import { useState, useEffect } from 'react';
import { useFetcher } from 'react-router';
import type { Integration } from '@/types';
import {
  type IntegrationDefinition,
  shouldShowConfigField,
  shouldShowCredentialField,
  isCredentialFieldRequired,
  requiresCredentialEntryOnEdit,
  shouldClearHiddenCredentials,
  filterVisibleCredentials,
} from '@/lib/integration-registry';
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
import { AlertCircle, ExternalLink, Key } from 'lucide-react';

interface EditConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: Integration;
  connectionTypes: IntegrationDefinition[];
  orgId: string;
  forceCredentialUpdate?: boolean;
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
  forceCredentialUpdate = false,
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
    setShouldUpdateCredentials(forceCredentialUpdate);
    setError(null);
  }, [connection, typeDef, forceCredentialUpdate]);

  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.success) {
        onSuccess();
      } else if (fetcher.data.error) {
        setError(fetcher.data.error);
      }
    }
  }, [fetcher.state, fetcher.data, onSuccess]);

  if (!typeDef) return null;

  const visibleCredentialFields = typeDef.credentialSchema.filter((field) =>
    shouldShowCredentialField(connection.integration_type, field.name, config)
  );
  const isRemoteMcpOAuth = connection.integration_type === 'remote_mcp' && config.auth_type === 'oauth';

  // Force credential entry (and submission) when the selected auth mode needs a
  // secret the stored credentials cannot satisfy, so a config-only auth-mode
  // change can't persist a connection that fails on its first request.
  const credentialEntryRequired = requiresCredentialEntryOnEdit(
    typeDef,
    config,
    connection.config,
    Boolean(connection.has_credentials)
  );
  const credentialEntryActive = shouldUpdateCredentials || credentialEntryRequired;
  const clearsHiddenCredentials = shouldClearHiddenCredentials(
    typeDef,
    config,
    connection.config,
    Boolean(connection.has_credentials)
  );
  const submitCredentials = credentialEntryActive || clearsHiddenCredentials;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const nextConfig = applyDefaults(typeDef.configSchema, config);

    fetcher.submit(
      {
        intent: 'updateIntegration',
        integrationId: connection.id,
        name: name.trim(),
        config: JSON.stringify(nextConfig),
        ...(submitCredentials
          ? {
              credentials: JSON.stringify(
                filterVisibleCredentials(connection.integration_type, config, credentials)
              ),
            }
          : {}),
      },
      { method: 'POST', action: '/connections' }
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
            {typeDef.configSchema.filter((field) => shouldShowConfigField(connection.integration_type, field.name, config)).map((field) => (
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
            {visibleCredentialFields.length > 0 && (
              <>
                <div className="mt-2 border-t pt-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-medium">Credentials</p>
                    {connection.has_credentials && !credentialEntryActive && (
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

                  {connection.has_credentials && credentialEntryRequired && (
                    <Alert className="mb-3">
                      <AlertDescription>
                        This authentication method needs different credentials. Enter them below to
                        save your changes.
                      </AlertDescription>
                    </Alert>
                  )}

                  {connection.has_credentials && !credentialEntryActive ? (
                    <Alert>
                      <AlertDescription>
                        Credentials are stored securely. Click &quot;Update Credentials&quot; to replace
                        them.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    visibleCredentialFields.map((field) => {
                      const required = isCredentialFieldRequired(
                        connection.integration_type,
                        field.name,
                        config,
                        field.required
                      );
                      return (
                        <div key={field.name} className="mb-3 grid gap-1.5">
                          <Label htmlFor={`edit-cred-${field.name}`}>
                            {field.label}
                            {required && (
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
                              required={credentialEntryActive && required}
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
                              required={credentialEntryActive && required}
                            />
                          )}
                          {field.description && (
                            <p className="text-xs text-muted-foreground">{field.description}</p>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}
            {isRemoteMcpOAuth && (
              <Alert>
                <AlertDescription>
                  OAuth credentials are managed by the remote MCP authorization flow.
                </AlertDescription>
              </Alert>
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
            {isRemoteMcpOAuth && (
              <Button
                type="button"
                onClick={() => {
                  window.location.href = `/api/integrations/remote_mcp/oauth?${new URLSearchParams({
                    integration_id: connection.id,
                    redirect: '/connections',
                  }).toString()}`;
                }}
              >
                <ExternalLink className="mr-2 size-4" />
                {connection.has_credentials ? 'Reauthorize OAuth' : 'Connect OAuth'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
