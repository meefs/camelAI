'use client';

import { useState, useEffect, useCallback } from 'react';
import { INTEGRATION_REGISTRY } from '@/lib/integration-registry';
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

export interface ConnectionSetupPromptData {
  requestId: string;
  integrationType: string;
  suggestedName?: string;
  message?: string;
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

  // Set defaults from config schema on mount
  useEffect(() => {
    if (typeDef) {
      const defaultConfig: Record<string, unknown> = {};
      for (const field of typeDef.configSchema) {
        if (field.default !== undefined) {
          defaultConfig[field.name] = field.default;
        }
      }
      setConfig(defaultConfig);
    }
  }, [typeDef]);

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
      if (!typeDef) return;

      setError(null);
      setIsSubmitting(true);

      // Validate name is required
      if (!name.trim()) {
        setError('Name is required');
        setIsSubmitting(false);
        return;
      }

      // Validate required fields
      for (const field of typeDef.configSchema) {
        if (field.required && !config[field.name]) {
          setError(`${field.label} is required`);
          setIsSubmitting(false);
          return;
        }
      }

      for (const field of typeDef.credentialSchema) {
        if (field.required && !credentials[field.name]) {
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
    },
    [data.requestId, data.integrationType, typeDef, name, config, credentials, onSubmit]
  );

  const updateConfig = (field: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
  };

  const updateCredentials = (field: string, value: unknown) => {
    setCredentials((prev) => ({ ...prev, [field]: value }));
  };

  if (!typeDef) {
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

  return (
    <Dialog open onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="size-5" />
            Add {typeDef.displayName}
          </DialogTitle>
          <DialogDescription>
            {data.message || typeDef.description}
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
                  placeholder={typeDef.displayName}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  A unique name to identify this connection
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
                    />
                  )}
                </div>
              ))}

              {/* Credential fields */}
              {typeDef.credentialSchema.length > 0 && (
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

              {/* OAuth notice */}
              {typeDef.authMethod === 'oauth2' && (
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
