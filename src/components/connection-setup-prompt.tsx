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
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertCircle, Plug } from 'lucide-react';
import { MarkdownRenderer } from '@/components/markdown-renderer';

export interface ConnectionSetupPromptData {
  requestId: string;
  integrationType: string;
  suggestedName?: string;
  message?: string;
  dynamicSchema?: DynamicIntegrationSchema;
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
    [data.requestId, data.integrationType, typeDef, isDynamic, dynamicSchema, name, config, credentials, onSubmit]
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
      <Dialog open onOpenChange={(open) => !open && handleCancel()}>
        <DialogContent className="sm:max-w-lg">
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
  const description = data.message || (isDynamic && dynamicSchema ? dynamicSchema.description : typeDef?.description) || '';
  const instructions = isDynamic && dynamicSchema ? dynamicSchema.instructions : undefined;

  return (
    <Dialog open onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="size-5" />
            Add {displayName}
          </DialogTitle>
          <DialogDescription>
            {description}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <ScrollArea className="max-h-[50vh] pr-4">
            <div className="grid gap-4 py-2">
              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {/* Instructions for dynamic integrations (rendered as markdown) */}
              {instructions && (
                <div className="rounded-md border bg-muted/50 p-3 text-sm">
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
                        <p className="text-xs text-muted-foreground">{field.description}</p>
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

              {/* Static credential fields (non-dynamic mode) */}
              {!isDynamic && typeDef && typeDef.credentialSchema.length > 0 && (
                <>
                  <div className="mt-2 border-t pt-4">
                    <p className="mb-3 text-sm font-medium">Credentials</p>
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
                      />
                    </div>
                  ))}
                </>
              )}

              {/* OAuth notice (non-dynamic mode only) */}
              {!isDynamic && typeDef?.authMethod === 'oauth2' && (
                <Alert>
                  <AlertDescription>
                    This connection uses OAuth 2.0. After saving, you may need to
                    authorize access separately.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </ScrollArea>

          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating...' : 'Create Connection'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
