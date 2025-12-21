'use client';

import { useState } from 'react';
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
import { AlertCircle } from 'lucide-react';

interface AddIntegrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integrationType: string;
  integrationTypes: IntegrationDefinition[];
  orgId: string;
  onSuccess: () => void;
}

export function AddIntegrationDialog({
  open,
  onOpenChange,
  integrationType,
  integrationTypes,
  orgId,
  onSuccess,
}: AddIntegrationDialogProps) {
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [credentials, setCredentials] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeDef = integrationTypes.find((t) => t.type === integrationType);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch(`/api/orgs/${orgId}/integrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: integrationType,
          name: name.trim() || typeDef?.displayName || integrationType,
          config,
          credentials,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || 'Failed to create integration');
      }

      // Reset form
      setName('');
      setConfig({});
      setCredentials({});
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create integration');
    } finally {
      setSubmitting(false);
    }
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

  if (!typeDef) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add {typeDef.displayName}</DialogTitle>
          <DialogDescription className="text-zinc-400">
            {typeDef.description}
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
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={typeDef.displayName}
                className="border-zinc-700 bg-zinc-800"
              />
              <p className="text-xs text-zinc-500">
                A friendly name to identify this integration
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
                    className="border-zinc-700 bg-zinc-800"
                  />
                )}
              </div>
            ))}

            {/* Credential fields */}
            {typeDef.credentialSchema.length > 0 && (
              <>
                <div className="mt-2 border-t border-zinc-800 pt-4">
                  <p className="mb-3 text-sm font-medium text-zinc-300">
                    Credentials
                  </p>
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
                      required={field.required}
                      className="border-zinc-700 bg-zinc-800"
                    />
                  </div>
                ))}
              </>
            )}

            {/* OAuth notice */}
            {typeDef.authMethod === 'oauth2' && (
              <Alert className="border-zinc-700 bg-zinc-800">
                <AlertDescription className="text-zinc-400">
                  This integration uses OAuth 2.0. After saving, you&apos;ll be
                  redirected to authorize access.
                </AlertDescription>
              </Alert>
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
              {submitting ? 'Creating...' : 'Create Integration'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
