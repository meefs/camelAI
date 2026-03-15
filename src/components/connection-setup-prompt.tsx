'use client';

import { useState, useEffect, useCallback } from 'react';
import { INTEGRATION_REGISTRY, type DynamicField, type DynamicIntegrationSchema } from '@/lib/integration-registry';
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
import { AlertCircle, ExternalLink, Plug } from 'lucide-react';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { SnowflakeCredentialsForm } from '@/components/snowflake-credentials-form';

export interface ConnectionSetupPromptData {
  requestId: string;
  integrationType: string;
  suggestedName?: string;
  message?: string;
  dynamicSchema?: DynamicIntegrationSchema;
  mcpDoId?: string; // MCP DO ID for OAuth callback completion
}

export interface ConnectionSetupResponse {
  requestId: string;
  cancelled: boolean;
  integration?: {
    type: string;
    name: string;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
  };
}

interface ConnectionSetupPromptProps {
  data: ConnectionSetupPromptData;
  onSubmit: (response: ConnectionSetupResponse) => void;
  onCancel: () => void;
}

const integrationTypes = Object.values(INTEGRATION_REGISTRY);

// OAuth integration types that have worker routes for OAuth flow
const OAUTH_INTEGRATIONS = ['slack', 'notion'] as const;
type OAuthIntegrationType = (typeof OAUTH_INTEGRATIONS)[number];

export function ConnectionSetupPrompt({
  data,
  onSubmit,
  onCancel,
}: ConnectionSetupPromptProps) {
  const [name, setName] = useState(data.suggestedName || '');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [credentials, setCredentials] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const typeDef = integrationTypes.find((t) => t.type === data.integrationType);

  // Check if this is a dynamic "other" integration with custom fields
  const isDynamic = data.integrationType === 'other' && data.dynamicSchema && data.dynamicSchema.fields.length > 0;
  const dynamicSchema = data.dynamicSchema;

  // Check if this is an OAuth integration with a supported flow
  const isOAuthWithFlow = typeDef?.authMethod === 'oauth2' &&
    OAUTH_INTEGRATIONS.includes(data.integrationType as OAuthIntegrationType);

  // Handle OAuth flow redirect
  const handleOAuthConnect = useCallback(() => {
    // Build OAuth URL with MCP context for callback completion
    const params = new URLSearchParams();
    params.set('redirect', window.location.pathname);
    if (data.requestId && data.mcpDoId) {
      params.set('mcp_request_id', data.requestId);
      params.set('mcp_do_id', data.mcpDoId);
    }
    // Redirect to OAuth flow - this will complete the MCP request via callback
    window.location.href = `/api/integrations/${data.integrationType}/oauth?${params.toString()}`;
  }, [data.integrationType, data.requestId, data.mcpDoId]);

  // Set defaults from config schema on mount
  useEffect(() => {
    if (typeDef && !isDynamic) {
      const defaultConfig: Record<string, unknown> = {};
      for (const field of typeDef.configSchema) {
        if (field.default !== undefined) {
          defaultConfig[field.name] = field.default;
        }
      }
      setConfig(defaultConfig);
    }
  }, [typeDef, isDynamic]);

  const handleCancel = () => {
    onSubmit({
      requestId: data.requestId,
      cancelled: true,
    });
    onCancel();
  };

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      // OAuth flow handles submission via redirect, not form submit
      if (isOAuthWithFlow) return;

      // For dynamic mode, we don't need typeDef
      if (!isDynamic && !typeDef) return;

      setError(null);
      setIsSubmitting(true);

      // Validate name is required
      if (!name.trim()) {
        setError('Name is required');
        setIsSubmitting(false);
        return;
      }

      if (isDynamic && dynamicSchema) {
        // Validate dynamic fields
        for (const field of dynamicSchema.fields) {
          const value = credentials[field.name];
          // Check for undefined, null, or empty string, but allow 0
          if (field.required && (value == null || value === '')) {
            setError(`${field.label} is required`);
            setIsSubmitting(false);
            return;
          }
        }

        onSubmit({
          requestId: data.requestId,
          cancelled: false,
          integration: {
            type: data.integrationType,
            name: name.trim(),
            config: {}, // Config is handled server-side for dynamic integrations
            credentials,
          },
        });
      } else if (typeDef) {
        // Validate required fields for static integrations
        for (const field of typeDef.configSchema) {
          const value = config[field.name];
          // Check for undefined, null, or empty string, but allow 0
          if (field.required && (value == null || value === '')) {
            setError(`${field.label} is required`);
            setIsSubmitting(false);
            return;
          }
        }

        for (const field of typeDef.credentialSchema) {
          const value = credentials[field.name];
          // Check for undefined, null, or empty string, but allow 0
          if (field.required && (value == null || value === '')) {
            setError(`${field.label} is required`);
            setIsSubmitting(false);
            return;
          }
        }

        onSubmit({
          requestId: data.requestId,
          cancelled: false,
          integration: {
            type: data.integrationType,
            name: name.trim(),
            config,
            credentials,
          },
        });
      }
    },
    [data.requestId, data.integrationType, typeDef, isDynamic, dynamicSchema, isOAuthWithFlow, name, config, credentials, onSubmit]
  );

  const updateConfig = (field: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
  };

  const updateCredentials = (field: string, value: unknown) => {
    setCredentials((prev) => ({ ...prev, [field]: value }));
  };

  // Allow dynamic mode even without typeDef
  if (!typeDef && !isDynamic) {
    return (
      <Dialog open onOpenChange={() => {}}>
        <DialogContent
          className="sm:max-w-lg"
          showCloseButton={false}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plug className="size-5" />
              Unknown Integration
            </DialogTitle>
            <DialogDescription>
              The requested integration type "{data.integrationType}" is not recognized.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleCancel}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Get display info - use dynamic schema for dynamic mode, or typeDef for static mode
  const displayName = isDynamic && dynamicSchema ? dynamicSchema.displayName : typeDef?.displayName ?? 'Integration';
  const rawDescription = data.message || (isDynamic && dynamicSchema ? dynamicSchema.description : typeDef?.description) || '';
  // Normalize literal \n sequences (backslash + n) that LLMs sometimes emit in tool call args
  const description = rawDescription.replace(/\\n/g, '\n');
  const rawInstructions = isDynamic && dynamicSchema ? dynamicSchema.instructions : undefined;
  const instructions = rawInstructions?.replace(/\\n/g, '\n');

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-lg overflow-hidden"
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="size-5" />
            Add {displayName}
          </DialogTitle>
          <DialogDescription className="break-words whitespace-pre-line">
            {description}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="max-h-[60vh] overflow-y-auto pr-4 min-w-0">
            <div className="grid gap-4 py-2">
              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {/* Instructions for dynamic integrations (rendered as markdown) */}
              {instructions && (
                <div className="rounded-md border bg-muted/50 p-3 text-sm overflow-x-auto">
                  <MarkdownRenderer content={instructions} />
                </div>
              )}

              {/* Name field */}
              <div className="grid gap-1.5">
                <Label htmlFor="name">
                  Name
                  <span className="ml-1 text-red-400">*</span>
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={displayName}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  A unique name to identify this connection
                </p>
              </div>

              {/* Dynamic fields for "other" integrations with custom schema */}
              {isDynamic && dynamicSchema && (
                <>
                  <div className="mt-2 border-t pt-4">
                    <p className="mb-3 text-sm font-medium">Credentials</p>
                  </div>
                  {dynamicSchema.fields.map((field) => (
                    <div key={field.name} className="grid gap-1.5">
                      <Label htmlFor={`dyn-${field.name}`}>
                        {field.label}
                        {field.required && <span className="ml-1 text-red-400">*</span>}
                      </Label>
                      <Input
                        id={`dyn-${field.name}`}
                        type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'}
                        value={(credentials[field.name] as string) || ''}
                        onChange={(e) => updateCredentials(field.name, field.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
                        placeholder={field.placeholder}
                      />
                      {field.description && (
                        <p className="text-xs text-muted-foreground break-words whitespace-pre-line">{field.description.replace(/\\n/g, '\n')}</p>
                      )}
                    </div>
                  ))}
                </>
              )}

              {/* Static config fields (non-dynamic mode) */}
              {!isDynamic && typeDef && typeDef.configSchema.map((field) => (
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
                          field.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value
                        )
                      }
                      placeholder={field.placeholder}
                    />
                  )}
                </div>
              ))}

              {/* Static credential fields (non-dynamic mode, non-OAuth with flow) */}
              {!isDynamic && !isOAuthWithFlow && typeDef && typeDef.credentialSchema.length > 0 && (
                <>
                  <div className="mt-2 border-t pt-4">
                    <p className="mb-3 text-sm font-medium">Credentials</p>
                  </div>

                  {/* Snowflake credentials with key generation */}
                  {data.integrationType === 'snowflake' && (
                    <SnowflakeCredentialsForm
                      credentials={credentials}
                      onCredentialsChange={updateCredentials}
                    />
                  )}

                  {/* Show credential fields for non-Snowflake integrations */}
                  {data.integrationType !== 'snowflake' && typeDef.credentialSchema.map((field) => (
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
                      />
                    </div>
                  ))}
                </>
              )}

              {/* OAuth flow for supported integrations */}
              {isOAuthWithFlow && (
                <Alert>
                  <AlertDescription>
                    Click the button below to connect your {typeDef?.displayName} account.
                    You&apos;ll be redirected to authorize access.
                  </AlertDescription>
                </Alert>
              )}

              {/* OAuth notice for unsupported OAuth integrations */}
              {!isDynamic && typeDef?.authMethod === 'oauth2' && !isOAuthWithFlow && (
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
            <Button type="button" variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            {/* Show OAuth connect button for supported OAuth integrations */}
            {isOAuthWithFlow ? (
              <Button type="button" onClick={handleOAuthConnect}>
                <ExternalLink className="mr-2 size-4" />
                Connect {typeDef?.displayName}
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={isSubmitting || (!isDynamic && typeDef?.authMethod === 'oauth2' && !isOAuthWithFlow)}
              >
                {isSubmitting ? 'Creating...' : 'Create Connection'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
