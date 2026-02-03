'use client';

import { useState, useEffect } from 'react';
import { useFetcher } from 'react-router';
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
import { AlertCircle, ExternalLink } from 'lucide-react';
import { SnowflakeCredentialsForm } from '@/components/snowflake-credentials-form';

interface AddConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionType: string;
  connectionTypes: IntegrationDefinition[];
  orgId: string;
  onSuccess: () => void;
}

// OAuth integration types that have worker routes
const OAUTH_INTEGRATIONS = ['slack', 'notion'] as const;

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

export function AddConnectionDialog({
  open,
  onOpenChange,
  connectionType,
  connectionTypes,
  orgId,
  onSuccess,
}: AddConnectionDialogProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [credentials, setCredentials] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  const submitting = fetcher.state !== 'idle';
  const typeDef = connectionTypes.find((t) => t.type === connectionType);

  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.success) {
        setName('');
        setConfig({});
        setCredentials({});
        setError(null);
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
        intent: 'createIntegration',
        integration_type: connectionType,
        name: name.trim() || typeDef?.displayName || connectionType,
        config: JSON.stringify(nextConfig),
        credentials: JSON.stringify(credentials),
      },
      { method: 'POST' }
    );
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

  useEffect(() => {
    if (!open || !typeDef) return;
    setConfig((prev) => applyDefaults(typeDef.configSchema, prev));
  }, [open, typeDef]);

  if (!typeDef) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add {typeDef.displayName}</DialogTitle>
          <DialogDescription>{typeDef.description}</DialogDescription>
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
                {field.description && (
                  <p className="text-xs text-muted-foreground">{field.description}</p>
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

                {/* Snowflake credentials with key generation */}
                {connectionType === 'snowflake' && (
                  <SnowflakeCredentialsForm
                    credentials={credentials}
                    onCredentialsChange={updateCredentials}
                  />
                )}

                {/* Show credential fields for non-Snowflake integrations */}
                {connectionType !== 'snowflake' && typeDef.credentialSchema.map((field) => (
                  <div key={field.name} className="grid gap-1.5">
                    <Label htmlFor={`cred-${field.name}`}>
                      {field.label}
                      {field.required && <span className="ml-1 text-red-400">*</span>}
                    </Label>
                    {field.type === 'textarea' ? (
                      <Textarea
                        id={`cred-${field.name}`}
                        value={(credentials[field.name] as string) || ''}
                        onChange={(e) => updateCredentials(field.name, e.target.value)}
                        placeholder={field.placeholder}
                        required={field.required}
                        rows={6}
                        className="font-mono text-xs"
                      />
                    ) : (
                      <Input
                        id={`cred-${field.name}`}
                        type={field.type === 'password' ? 'password' : 'text'}
                        value={(credentials[field.name] as string) || ''}
                        onChange={(e) => updateCredentials(field.name, e.target.value)}
                        placeholder={field.placeholder}
                        required={field.required}
                      />
                    )}
                    {field.description && (
                      <p className="text-xs text-muted-foreground">{field.description}</p>
                    )}
                  </div>
                ))}
              </>
            )}

            {/* OAuth flow for supported integrations */}
            {typeDef.authMethod === 'oauth2' &&
              OAUTH_INTEGRATIONS.includes(connectionType as (typeof OAUTH_INTEGRATIONS)[number]) && (
                <Alert>
                  <AlertDescription>
                    Click the button below to connect your {typeDef.displayName} account.
                    You&apos;ll be redirected to authorize access.
                  </AlertDescription>
                </Alert>
              )}

            {/* OAuth notice for unsupported OAuth integrations */}
            {typeDef.authMethod === 'oauth2' &&
              !OAUTH_INTEGRATIONS.includes(connectionType as (typeof OAUTH_INTEGRATIONS)[number]) && (
                <Alert>
                  <AlertDescription>
                    OAuth for {typeDef.displayName} is not yet implemented. Please check back
                    later or use an API key if available.
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
            {/* Show OAuth button for supported OAuth integrations */}
            {typeDef.authMethod === 'oauth2' &&
            OAUTH_INTEGRATIONS.includes(connectionType as (typeof OAUTH_INTEGRATIONS)[number]) ? (
              <Button
                type="button"
                onClick={() => {
                  // Redirect to OAuth flow
                  window.location.href = `/api/integrations/${connectionType}/oauth?redirect=/connections`;
                }}
              >
                <ExternalLink className="mr-2 size-4" />
                Connect {typeDef.displayName}
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={
                  submitting ||
                  (typeDef.authMethod === 'oauth2' &&
                    !OAUTH_INTEGRATIONS.includes(connectionType as (typeof OAUTH_INTEGRATIONS)[number]))
                }
              >
                {submitting ? 'Creating...' : 'Create Connection'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
