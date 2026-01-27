'use client';

import { useState, useEffect, useCallback } from 'react';
import { INTEGRATION_REGISTRY, type IntegrationDefinition } from '@/lib/integration-registry';
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
import { AlertCircle, Plug, Settings, X } from 'lucide-react';
import { IntegrationIcon, hasIntegrationIcon } from '@/lib/integration-icons';

export interface ConnectionSetupPromptData {
  requestId: string;
  integrationType?: string;
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

const categoryLabels: Record<string, string> = {
  databases: 'Databases',
  saas: 'SaaS',
  ai_services: 'AI Services',
  cloud_providers: 'Cloud Providers',
  communication: 'Communication',
};

export function ConnectionSetupPrompt({
  data,
  onSubmit,
  onCancel,
}: ConnectionSetupPromptProps) {
  const [step, setStep] = useState<'select' | 'configure'>(
    data.integrationType ? 'configure' : 'select'
  );
  const [selectedType, setSelectedType] = useState<string | null>(
    data.integrationType || null
  );
  const [name, setName] = useState(data.suggestedName || '');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [credentials, setCredentials] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const typeDef = selectedType
    ? integrationTypes.find((t) => t.type === selectedType)
    : null;

  // Reset form when type changes
  useEffect(() => {
    if (typeDef) {
      // Set defaults from config schema
      const defaultConfig: Record<string, unknown> = {};
      for (const field of typeDef.configSchema) {
        if (field.default !== undefined) {
          defaultConfig[field.name] = field.default;
        }
      }
      setConfig(defaultConfig);
      setCredentials({});
    }
  }, [typeDef]);

  const handleSelectType = (type: string) => {
    setSelectedType(type);
    setStep('configure');
  };

  const handleBack = () => {
    if (!data.integrationType) {
      setStep('select');
      setSelectedType(null);
    }
  };

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
      if (!typeDef || !selectedType) return;

      setError(null);
      setIsSubmitting(true);

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
          type: selectedType,
          name: name.trim() || typeDef.displayName,
          config,
          credentials,
        },
      });
    },
    [data.requestId, selectedType, typeDef, name, config, credentials, onSubmit]
  );

  const updateConfig = (field: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
  };

  const updateCredentials = (field: string, value: unknown) => {
    setCredentials((prev) => ({ ...prev, [field]: value }));
  };

  // Group integrations by category
  const byCategory: Record<string, IntegrationDefinition[]> = {};
  for (const t of integrationTypes) {
    if (!byCategory[t.category]) {
      byCategory[t.category] = [];
    }
    byCategory[t.category].push(t);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="size-5" />
            {step === 'select' ? 'Set Up Connection' : `Add ${typeDef?.displayName}`}
          </DialogTitle>
          <DialogDescription>
            {data.message ||
              (step === 'select'
                ? 'Claude needs a connection to an external service. Choose the type of connection to set up.'
                : typeDef?.description)}
          </DialogDescription>
        </DialogHeader>

        {step === 'select' ? (
          <ScrollArea className="max-h-[60vh] pr-4">
            <div className="space-y-4">
              {Object.entries(byCategory).map(([category, types]) => (
                <div key={category}>
                  <h4 className="mb-2 text-sm font-medium text-muted-foreground">
                    {categoryLabels[category] || category}
                  </h4>
                  <div className="grid gap-2">
                    {types.map((type) => {
                      const hasIcon = hasIntegrationIcon(type.type);
                      return (
                        <button
                          key={type.type}
                          onClick={() => handleSelectType(type.type)}
                          className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent"
                        >
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                            {hasIcon ? (
                              <IntegrationIcon type={type.type} className="size-5" />
                            ) : (
                              <Settings className="size-5" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">
                              {type.displayName}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {type.description}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : typeDef ? (
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
              {!data.integrationType && (
                <Button type="button" variant="outline" onClick={handleBack}>
                  Back
                </Button>
              )}
              <Button type="button" variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Creating...' : 'Create Connection'}
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {step === 'select' && (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
