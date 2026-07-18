export type IntegrationDefinitionSource = 'builtin' | 'detected' | 'discovered' | 'declared' | 'imported' | 'manual';
export type IntegrationDefinitionSurface = 'curated' | 'openapi' | 'graphql' | 'mcp' | 'http';
export type IntegrationAuthKind = 'unknown' | 'none' | 'bearer' | 'basic' | 'header' | 'oauth2';
export type IntegrationOperationAccess = 'read' | 'write';

export interface IntegrationVariableDefinition {
  name: string;
  in: 'url';
  description?: string;
  resolveFrom?: string;
}

export interface IntegrationAuthTemplate {
  kind: IntegrationAuthKind;
  header?: string;
  description?: string;
  scopes?: string[];
}

export interface IntegrationOperationDefinition {
  id: string;
  name: string;
  description?: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  path: string;
  access: IntegrationOperationAccess;
  inputSchema?: Record<string, unknown>;
}

export interface WorkspaceIntegrationDefinition {
  schemaVersion: 1;
  slug: string;
  displayName: string;
  description?: string;
  surface: IntegrationDefinitionSurface;
  source: IntegrationDefinitionSource;
  sourceUrl?: string;
  baseUrl: string;
  auth: IntegrationAuthTemplate[];
  variables?: IntegrationVariableDefinition[];
  warnings?: string[];
  operations: IntegrationOperationDefinition[];
  provenance: {
    kind: 'builtin' | 'detected' | 'discovered' | 'declared' | 'manual';
    importedAt?: number;
    documentTitle?: string;
    documentVersion?: string;
  };
}

function hostnameFamily(hostname: string): string {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  return labels.slice(-2).join('.');
}

export function integrationDefinitionRequiresEndpointConfirmation(
  definition: WorkspaceIntegrationDefinition,
  submittedUrl?: string,
): boolean {
  try {
    if (!definition.sourceUrl || new URL(definition.sourceUrl).hostname !== 'integrations.sh') return false;
    if (!submittedUrl) return Boolean(definition.warnings?.length);
    return hostnameFamily(new URL(definition.baseUrl).hostname) !== hostnameFamily(new URL(submittedUrl).hostname);
  } catch {
    return Boolean(definition.warnings?.length);
  }
}

function replaceVariableToken(url: string, name: string, value: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rawPattern = new RegExp(`(?:\\{${escapedName}\\}|<${escapedName}>)`, 'gi');
  const encodedPattern = new RegExp(`(?:%7B${escapedName}%7D|%3C${escapedName}%3E)`, 'gi');
  const authorityEnd = url.indexOf('/', url.indexOf('://') + 3);
  const authority = authorityEnd === -1 ? url : url.slice(0, authorityEnd);
  const tokenAppearsInAuthority = rawPattern.test(authority) || encodedPattern.test(authority);
  rawPattern.lastIndex = 0;
  encodedPattern.lastIndex = 0;
  if (tokenAppearsInAuthority && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`${name} must be a hostname-safe value`);
  }
  const replacement = tokenAppearsInAuthority ? value : encodeURIComponent(value);
  return url.replace(rawPattern, replacement).replace(encodedPattern, replacement);
}

export function resolveIntegrationDefinitionVariables(
  definition: WorkspaceIntegrationDefinition,
  values: Record<string, unknown>,
): WorkspaceIntegrationDefinition {
  let baseUrl = definition.baseUrl;
  for (const variable of definition.variables ?? []) {
    const rawValue = values[variable.name];
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!value) throw new Error(`${variable.name} is required`);
    baseUrl = replaceVariableToken(baseUrl, variable.name, value);
  }
  if (/%(?:7B|3C)[^%]+%(?:7D|3E)|[<{][^>}]+[>}]/i.test(baseUrl)) {
    throw new Error('All endpoint variables must be resolved before creating the connection');
  }
  return { ...definition, baseUrl };
}

export interface WorkspaceIntegrationDefinitionRecord {
  id: string;
  workspace_id: string;
  slug: string;
  payload: string;
  source: IntegrationDefinitionSource;
  source_url: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

export function parseWorkspaceIntegrationDefinition(
  value: string | null | undefined,
): WorkspaceIntegrationDefinition | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceIntegrationDefinition>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.slug !== 'string' ||
      typeof parsed.displayName !== 'string' ||
      typeof parsed.baseUrl !== 'string' ||
      !Array.isArray(parsed.auth) ||
      !Array.isArray(parsed.operations) ||
      !parsed.provenance
    ) {
      return null;
    }
    const operations = parsed.operations.filter((operation) => (
      operation &&
      typeof operation.id === 'string' &&
      typeof operation.name === 'string' &&
      typeof operation.path === 'string' &&
      typeof operation.method === 'string' &&
      HTTP_METHODS.has(operation.method) &&
      (operation.access === 'read' || operation.access === 'write')
    ));
    return { ...parsed, operations } as WorkspaceIntegrationDefinition;
  } catch {
    return null;
  }
}

export function integrationOperationMethodName(value: string, fallback = 'operation'): string {
  const parts = value
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return fallback;
  const [first, ...rest] = parts;
  const name = [
    first!.charAt(0).toLowerCase() + first!.slice(1),
    ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)),
  ].join('');
  return /^[A-Za-z_$]/.test(name) ? name : `${fallback}${name}`;
}
