'use client';

import { useState, useLayoutEffect } from 'react';
import { useFetcher } from 'react-router';
import {
  hasManagedOAuthFlow,
  type IntegrationDefinition,
  shouldShowConfigField,
  shouldShowCredentialField,
  isCredentialFieldRequired,
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
import { AlertCircle, ExternalLink } from 'lucide-react';
import { SnowflakeCredentialsForm } from '@/components/snowflake-credentials-form';
import { SandboxIpNotice } from '@/components/connections/sandbox-ip-notice';

interface AddConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionType: string;
  connectionTypes: IntegrationDefinition[];
  onSuccess: () => void;
}

interface AddConnectionFormState {
  name: string;
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
  error: string | null;
}

function getEmptyConnectionFormState(): AddConnectionFormState {
  return {
    name: '',
    config: {},
    credentials: {},
    error: null,
  };
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

export function AddConnectionDialog({
  open,
  onOpenChange,
  connectionType,
  connectionTypes,
  onSuccess,
}: AddConnectionDialogProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string; oauthUrl?: string }>();
  const [form, setForm] = useState(getEmptyConnectionFormState);
  const { name, config, credentials, error } = form;

  const submitting = fetcher.state !== 'idle';
  const typeDef = connectionTypes.find((t) => t.type === connectionType);
  const hasOAuthFlow = hasManagedOAuthFlow(typeDef);

  useLayoutEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.oauthUrl) {
        window.location.href = fetcher.data.oauthUrl;
      } else if (fetcher.data.success) {
        setForm(getEmptyConnectionFormState());
        onSuccess();
      } else if (fetcher.data.error) {
        setForm((prev) => ({ ...prev, error: fetcher.data?.error ?? null }));
      }
    }
  }, [fetcher.state, fetcher.data, onSuccess]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setForm((prev) => ({ ...prev, error: null }));

    const nextConfig = typeDef ? applyDefaults(typeDef.configSchema, config) : config;

    fetcher.submit(
      {
        intent: 'createIntegration',
        integration_type: connectionType,
        name: name.trim() || typeDef?.displayName || connectionType,
        config: JSON.stringify(nextConfig),
        credentials: JSON.stringify(filterVisibleCredentials(connectionType, nextConfig, credentials)),
      },
      { method: 'POST', action: '/connections' }
    );
  };

  const handleClose = () => {
    setForm(getEmptyConnectionFormState());
    onOpenChange(false);
  };

  const updateConfig = (field: string, value: unknown) => {
    setForm((prev) => ({
      ...prev,
      config: { ...prev.config, [field]: value },
    }));
  };

  const updateCredentials = (field: string, value: unknown) => {
    setForm((prev) => ({
      ...prev,
      credentials: { ...prev.credentials, [field]: value },
    }));
  };

  useLayoutEffect(() => {
    if (!open || !typeDef) return;
    setForm((prev) => ({
      ...prev,
      config: applyDefaults(typeDef.configSchema, prev.config),
    }));
  }, [open, typeDef]);

  if (!typeDef) return null;
  const visibleCredentialFields = typeDef.credentialSchema.filter((field) =>
    shouldShowCredentialField(connectionType, field.name, config)
  );

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

            {connectionType === 'other' ? (
              <Alert>
                <AlertCircle className="size-4" />
                <AlertDescription>
                  Generic HTTP is the escape hatch: the agent can call any HTTP(S) URL and camelAI applies these stored credentials. Prefer API discovery when available and only use credentials you trust for this purpose.
                </AlertDescription>
              </Alert>
            ) : null}

            {/* Name field */}
            <div className="grid gap-1.5">
              <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                  placeholder={typeDef.displayName}
              />
              <p className="text-xs text-muted-foreground">
                A friendly name to identify this connection
              </p>
            </div>

            {/* Config fields */}
            {typeDef.configSchema.flatMap((field) => {
              if (!shouldShowConfigField(connectionType, field.name, config)) {
                return [];
              }
              return [(
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
              )];
            })}

            {typeDef.requiresOutboundIpAllowlist && <SandboxIpNotice />}

            {/* Credential fields */}
            {visibleCredentialFields.length > 0 && (
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
                {connectionType !== 'snowflake' && visibleCredentialFields.map((field) => {
                  const required = isCredentialFieldRequired(connectionType, field.name, config, field.required);
                  return (
                    <div key={field.name} className="grid gap-1.5">
                      <Label htmlFor={`cred-${field.name}`}>
                        {field.label}
                        {required && <span className="ml-1 text-red-400">*</span>}
                      </Label>
                      {field.type === 'textarea' ? (
                        <Textarea
                          id={`cred-${field.name}`}
                          value={(credentials[field.name] as string) || ''}
                          onChange={(e) => updateCredentials(field.name, e.target.value)}
                          placeholder={field.placeholder}
                          required={required}
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
                          required={required}
                        />
                      )}
                      {field.description && (
                        <p className="text-xs text-muted-foreground">{field.description}</p>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            {/* OAuth flow for supported integrations */}
            {hasOAuthFlow && (
              <Alert>
                <AlertDescription>
                  Click the button below to connect your {typeDef.displayName} account.
                  You&apos;ll be redirected to authorize access.
                </AlertDescription>
              </Alert>
            )}

            {/* OAuth notice for unsupported OAuth integrations */}
            {typeDef.authMethod === 'oauth2' && !hasOAuthFlow && (
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
            {hasOAuthFlow ? (
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
                  (typeDef.authMethod === 'oauth2' && !hasOAuthFlow)
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
