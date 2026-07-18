'use client';

import { useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2, Search } from 'lucide-react';
import {
  integrationDefinitionRequiresEndpointConfirmation,
  type IntegrationAuthKind,
  type WorkspaceIntegrationDefinition,
} from '@/lib/integration-definition';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface ImportResult {
  success?: boolean;
  error?: string;
  genericFallback?: boolean;
  integrationId?: string;
  oauthUrl?: string;
  definition?: WorkspaceIntegrationDefinition;
  definitions?: WorkspaceIntegrationDefinition[];
}

interface ImportConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  onGenericFallback: () => void;
}

type SubmissionMode = 'discover' | 'create' | null;

function authChoices(definition: WorkspaceIntegrationDefinition): IntegrationAuthKind[] {
  const choices = definition.auth.flatMap((auth): IntegrationAuthKind[] => {
    if (auth.kind === 'unknown') {
      return definition.surface === 'mcp'
        ? ['unknown', 'oauth2', 'bearer', 'header', 'none']
        : ['unknown', 'bearer', 'header', 'basic', 'none'];
    }
    if (auth.kind === 'oauth2' && definition.surface !== 'mcp') return ['bearer'];
    return [auth.kind];
  });
  return Array.from(new Set(choices));
}

function preferredAuth(definition: WorkspaceIntegrationDefinition): IntegrationAuthKind {
  const supported = definition.auth.map((auth) => auth.kind);
  if (supported.includes('unknown')) return 'unknown';
  if (definition.surface === 'mcp' && supported.includes('oauth2')) return 'oauth2';
  if (supported.includes('oauth2')) return 'bearer';
  return supported[0] ?? 'unknown';
}

function sourceLabel(definition: WorkspaceIntegrationDefinition): string {
  let catalogSource = false;
  try {
    catalogSource = Boolean(definition.sourceUrl && new URL(definition.sourceUrl).hostname === 'integrations.sh');
  } catch {
    // Render malformed advisory metadata conservatively.
  }
  if (definition.source === 'declared') return catalogSource ? 'Owner-backed catalog' : 'Owner declared';
  if (definition.source === 'detected') return catalogSource ? 'Catalog detected' : 'Directly detected';
  if (definition.source === 'discovered' || catalogSource) return 'integrations.sh';
  return definition.source;
}

export function ImportConnectionDialog({
  open,
  onOpenChange,
  onSuccess,
  onGenericFallback,
}: ImportConnectionDialogProps) {
  const fetcher = useFetcher<ImportResult>();
  const mode = useRef<SubmissionMode>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [definitions, setDefinitions] = useState<WorkspaceIntegrationDefinition[]>([]);
  const [definition, setDefinition] = useState<WorkspaceIntegrationDefinition | null>(null);
  const [name, setName] = useState('');
  const [authType, setAuthType] = useState<IntegrationAuthKind>('unknown');
  const [authHeader, setAuthHeader] = useState('');
  const [operationPolicy, setOperationPolicy] = useState<'read_only' | 'all'>('read_only');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [endpointConfirmed, setEndpointConfirmed] = useState(false);
  const [showAllDefinitions, setShowAllDefinitions] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = fetcher.state !== 'idle';

  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data || !mode.current) return;
    const submittedMode = mode.current;
    mode.current = null;
    if (fetcher.data.error) {
      setError(fetcher.data.error);
      return;
    }
    if (submittedMode === 'discover' && fetcher.data.definition) {
      const nextDefinition = fetcher.data.definition;
      setDefinitions(fetcher.data.definitions?.length ? fetcher.data.definitions : [nextDefinition]);
      setDefinition(nextDefinition);
      setName(nextDefinition.displayName);
      setAuthType(preferredAuth(nextDefinition));
      setAuthHeader(nextDefinition.auth.find((auth) => auth.kind === 'header')?.header ?? '');
      setVariableValues({});
      setEndpointConfirmed(false);
      setShowAllDefinitions(false);
      setError(null);
      return;
    }
    if (submittedMode === 'create' && fetcher.data.success) {
      if (fetcher.data.oauthUrl) {
        window.location.assign(fetcher.data.oauthUrl);
        return;
      }
      reset();
      onSuccess();
    }
  }, [fetcher.data, fetcher.state, onSuccess]);

  const reset = () => {
    mode.current = null;
    setSourceUrl('');
    setDefinitions([]);
    setDefinition(null);
    setName('');
    setAuthType('unknown');
    setAuthHeader('');
    setOperationPolicy('read_only');
    setToken('');
    setUsername('');
    setPassword('');
    setVariableValues({});
    setEndpointConfirmed(false);
    setShowAllDefinitions(false);
    setError(null);
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const discover = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    mode.current = 'discover';
    fetcher.submit(
      { intent: 'discoverIntegration', source_url: sourceUrl.trim() },
      { method: 'POST', action: '/connections' },
    );
  };

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const credentials = authType === 'basic'
      ? { client_id: username, client_secret: password }
      : authType === 'none' ? {} : { api_key: token };
    mode.current = 'create';
    fetcher.submit(
      {
        intent: 'createDiscoveredIntegration',
        source_url: sourceUrl.trim(),
        surface_slug: definition?.slug ?? '',
        name: name.trim(),
        auth_type: authType,
        auth_header: authHeader.trim(),
        operation_policy: operationPolicy,
        credentials: JSON.stringify(credentials),
        surface_variables: JSON.stringify(variableValues),
        endpoint_confirmed: String(endpointConfirmed),
      },
      { method: 'POST', action: '/connections' },
    );
  };

  const availableAuth = definition ? authChoices(definition) : [];
  const readCount = definition?.operations.filter((operation) => operation.access === 'read').length ?? 0;
  const writeCount = (definition?.operations.length ?? 0) - readCount;
  const selectedAuth = definition?.auth.find((auth) => (
    auth.kind === authType ||
    auth.kind === 'unknown' ||
    (authType === 'bearer' && auth.kind === 'oauth2')
  ));
  const missingVariable = definition?.variables?.some((variable) => !variableValues[variable.name]?.trim()) ?? false;
  const requiresEndpointConfirmation = definition
    ? integrationDefinitionRequiresEndpointConfirmation(definition, sourceUrl)
    : false;
  const visibleDefinitions = showAllDefinitions ? definitions : definitions.slice(0, 3);

  return (
    <Dialog open={open} onOpenChange={(next) => next ? onOpenChange(true) : close()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{definition ? `Connect ${definition.displayName}` : 'Discover a connection'}</DialogTitle>
          <DialogDescription>
            {definition
              ? 'Review the discovered surface, choose a policy, and add credentials.'
              : 'Enter a service, API, GraphQL, or remote MCP URL. camelAI will look for owner-published metadata first.'}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Discovery could not finish</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {!definition ? (
          <form onSubmit={discover} className="space-y-4">
            <div className="grid gap-1.5">
              <Label htmlFor="integration-source-url">Service or integration URL</Label>
              <Input
                id="integration-source-url"
                type="url"
                required
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
                placeholder="https://example.com or https://api.example.com/openapi.json"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Discovery checks owner declarations, OpenAPI and MCP well-known locations, then integrations.sh for previously mapped surfaces. Private and local network addresses are blocked.
              </p>
            </div>
            <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  close();
                  onGenericFallback();
                }}
              >
                Set up generic HTTP
              </Button>
              <Button type="submit" disabled={busy || !sourceUrl.trim()}>
                {busy ? <Loader2 className="animate-spin" /> : <Search />}
                Discover connections
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={create} className="space-y-4">
            <Alert>
              <CheckCircle2 className="size-4" />
              <AlertTitle>{definition.surface === 'mcp' ? 'Remote MCP server discovered' : definition.surface === 'graphql' ? 'GraphQL endpoint discovered' : definition.surface === 'openapi' ? 'OpenAPI definition discovered' : 'HTTP API discovered'}</AlertTitle>
              <AlertDescription className="mt-1 flex flex-wrap gap-2">
                <Badge variant="secondary">{definition.surface.toUpperCase()}</Badge>
                {definition.operations.length > 0 ? <Badge variant="secondary">{definition.operations.length} operations</Badge> : null}
                {readCount > 0 ? <Badge variant="outline">{readCount} read</Badge> : null}
                {writeCount > 0 ? <Badge variant="outline">{writeCount} write</Badge> : null}
                {definition.surface !== 'mcp' ? <Badge variant="outline">Generic fetch included</Badge> : null}
                <Badge variant="outline">{sourceLabel(definition)}</Badge>
              </AlertDescription>
            </Alert>

            {definitions.length > 1 ? (
              <div className="grid gap-1.5">
                <Label>Integration surface</Label>
                <Select
                  value={definition.slug}
                  onValueChange={(slug) => {
                    const nextDefinition = definitions.find((candidate) => candidate.slug === slug);
                    if (!nextDefinition) return;
                    setDefinition(nextDefinition);
                    setName(nextDefinition.displayName);
                    setAuthType(preferredAuth(nextDefinition));
                    setAuthHeader(nextDefinition.auth.find((auth) => auth.kind === 'header')?.header ?? '');
                    setVariableValues({});
                    setEndpointConfirmed(false);
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {visibleDefinitions.map((candidate) => (
                      <SelectItem key={candidate.slug} value={candidate.slug}>
                        {candidate.displayName} ({candidate.surface.toUpperCase()})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!showAllDefinitions && definitions.length > 3 ? (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">Showing the 3 best matches of {definitions.length} surfaces.</p>
                    <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setShowAllDefinitions(true)}>
                      Show all
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <p className="text-xs font-medium text-foreground">Endpoint</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{definition.baseUrl}</p>
            </div>

            {definition.warnings?.map((warning) => (
              <Alert key={warning}>
                <AlertCircle className="size-4" />
                <AlertTitle>Review discovered endpoint</AlertTitle>
                <AlertDescription>{warning}</AlertDescription>
              </Alert>
            ))}

            {requiresEndpointConfirmation ? (
              <div className="flex items-start gap-3 rounded-md border px-3 py-2.5">
                <Checkbox
                  id="confirm-discovered-endpoint"
                  checked={endpointConfirmed}
                  onCheckedChange={(checked) => setEndpointConfirmed(checked === true)}
                />
                <Label htmlFor="confirm-discovered-endpoint" className="text-sm font-normal leading-snug">
                  I verified that this integrations.sh-discovered endpoint belongs to the service I intend to connect.
                </Label>
              </div>
            ) : null}

            <div className="grid gap-1.5">
              <Label htmlFor="imported-connection-name">Connection name</Label>
              <Input
                id="imported-connection-name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            {definition.variables?.map((variable) => (
              <div key={variable.name} className="grid gap-1.5">
                <Label htmlFor={`integration-variable-${variable.name}`}>{variable.name}</Label>
                <Input
                  id={`integration-variable-${variable.name}`}
                  required
                  value={variableValues[variable.name] ?? ''}
                  onChange={(event) => setVariableValues((current) => ({
                    ...current,
                    [variable.name]: event.target.value,
                  }))}
                  placeholder={variable.resolveFrom ?? `Enter ${variable.name}`}
                />
                {variable.description ? (
                  <p className="text-xs text-muted-foreground">{variable.description}</p>
                ) : null}
              </div>
            ))}

            <div className="grid gap-1.5">
              <Label>Authentication</Label>
              <Select value={authType} onValueChange={(value) => setAuthType(value as IntegrationAuthKind)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {availableAuth.map((kind) => (
                    <SelectItem key={kind} value={kind} disabled={kind === 'unknown'}>
                      {kind === 'unknown'
                        ? 'Choose authentication…'
                        : kind === 'none'
                        ? 'No authentication'
                        : kind === 'bearer'
                          ? 'Bearer token'
                          : kind === 'basic'
                            ? 'Basic authentication'
                            : kind === 'oauth2'
                              ? 'OAuth (automatic browser authorization)'
                              : 'Custom header'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedAuth?.description ? (
                <p className="whitespace-pre-line text-xs text-muted-foreground">{selectedAuth.description}</p>
              ) : null}
            </div>

            {authType === 'header' ? (
              <div className="grid gap-1.5">
                <Label htmlFor="imported-auth-header">Header name</Label>
                <Input id="imported-auth-header" required value={authHeader} onChange={(event) => setAuthHeader(event.target.value)} />
              </div>
            ) : null}
            {authType === 'bearer' || authType === 'header' ? (
              <div className="grid gap-1.5">
                <Label htmlFor="imported-token">{authType === 'bearer' ? 'Access token' : 'Header value'}</Label>
                <Input id="imported-token" type="password" required value={token} onChange={(event) => setToken(event.target.value)} />
              </div>
            ) : null}
            {authType === 'basic' ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="imported-username">Username</Label>
                  <Input id="imported-username" required value={username} onChange={(event) => setUsername(event.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="imported-password">Password</Label>
                  <Input id="imported-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} />
                </div>
              </div>
            ) : null}

            {definition.surface !== 'mcp' ? (
              <div className="grid gap-1.5">
                <Label>Operation policy</Label>
                <Select value={operationPolicy} onValueChange={(value) => setOperationPolicy(value as 'read_only' | 'all')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read_only">Read operations only</SelectItem>
                    <SelectItem value="all">Allow read and write operations</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Generic fetch remains available as an explicit fallback. Typed write operations follow this policy.
                </p>
              </div>
            ) : null}

            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="ghost" onClick={() => { setDefinition(null); setError(null); }}>
                <ArrowLeft /> Back
              </Button>
              <Button
                type="submit"
                disabled={busy || !name.trim() || authType === 'unknown' || missingVariable || (requiresEndpointConfirmation && !endpointConfirmed)}
              >
                {busy && <Loader2 className="animate-spin" />}
                Create connection
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
