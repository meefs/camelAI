import {
  integrationOperationMethodName,
  type IntegrationAuthTemplate,
  type IntegrationOperationDefinition,
  type IntegrationVariableDefinition,
  type WorkspaceIntegrationDefinition,
} from '@/lib/integration-definition';
import { validateRemoteMcpUrl } from '@/lib/remote-mcp';
import { parse as parseYaml } from 'yaml';

const MAX_SPEC_BYTES = 2_000_000;
const MAX_OPERATIONS = 150;
const MAX_DISCOVERED_SURFACES = 30;
const DISCOVERY_TIMEOUT_MS = 7_000;
const OPERATION_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;

type OpenApiDocument = Record<string, unknown> & {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; description?: string; version?: string };
  servers?: Array<{ url?: string }>;
  host?: string;
  basePath?: string;
  schemes?: string[];
  paths?: Record<string, Record<string, unknown>>;
  components?: { securitySchemes?: Record<string, Record<string, unknown>> };
  securityDefinitions?: Record<string, Record<string, unknown>>;
};

export class IntegrationDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationDiscoveryError';
  }
}

function publicHttpsUrl(raw: string, label: string): URL {
  const errors = validateRemoteMcpUrl(raw);
  if (errors.length > 0) {
    throw new IntegrationDiscoveryError(`${label}: ${errors[0]}`);
  }
  return new URL(raw);
}

function discoveryCandidates(rawUrl: string): URL[] {
  const input = publicHttpsUrl(rawUrl, 'API URL');
  input.hash = '';
  const looksLikeSpec = /(?:openapi|swagger)(?:\.[^/]+)?$/i.test(input.pathname) || /\.json$/i.test(input.pathname);
  if (looksLikeSpec) return [input];
  return [
    new URL('/.well-known/openapi.json', input.origin),
    new URL('/openapi.json', input.origin),
    new URL('/swagger.json', input.origin),
    new URL('/api/openapi.json', input.origin),
    new URL('/v1/openapi.json', input.origin),
    new URL('/api/schema/', input.origin),
  ];
}

async function fetchDocument(url: URL): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    let requestUrl = url;
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      response = await fetch(requestUrl, {
        headers: { accept: 'application/json, application/yaml, text/yaml, application/vnd.oai.openapi+json' },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location || redirects === 3) return null;
      requestUrl = publicHttpsUrl(new URL(location, requestUrl).toString(), 'OpenAPI redirect');
    }
    if (!response) return null;
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_SPEC_BYTES) return null;
    const text = await response.text();
    if (text.length > MAX_SPEC_BYTES) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = parseYaml(text);
    }
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOpenApiDocument(url: URL): Promise<OpenApiDocument | null> {
  const document = await fetchDocument(url) as OpenApiDocument | null;
  return document && (document.openapi || document.swagger) && document.paths
    ? document
    : null;
}

interface IntegrationSurfacePointer {
  type?: unknown;
  spec?: unknown;
  url?: unknown;
  name?: unknown;
  slug?: unknown;
  docs?: unknown;
  notes?: unknown;
  auth?: unknown;
  transports?: unknown;
  variables?: unknown;
  basis?: { via?: unknown };
}

interface IntegrationCredentialPointer {
  type?: unknown;
  label?: unknown;
  setup?: unknown;
  generateUrl?: unknown;
}

interface IntegrationSurfaceDocument extends Record<string, unknown> {
  version?: unknown;
  domain?: unknown;
  summary?: unknown;
  description?: unknown;
  credentials?: Record<string, IntegrationCredentialPointer>;
  surfaces?: IntegrationSurfacePointer[];
}

interface SurfaceCredentialUse {
  id?: unknown;
  mechanics?: {
    source?: unknown;
    in?: unknown;
    headerName?: unknown;
    scheme?: unknown;
  };
}

function credentialDescription(credential: IntegrationCredentialPointer | undefined): string | undefined {
  if (!credential) return undefined;
  const parts = [credential.label, credential.setup]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (typeof credential.generateUrl === 'string' && credential.generateUrl.trim()) {
    parts.push(`Create credentials: ${credential.generateUrl.trim()}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function dedupeAuthTemplates(templates: IntegrationAuthTemplate[]): IntegrationAuthTemplate[] {
  const output: IntegrationAuthTemplate[] = [];
  const seen = new Set<string>();
  for (const template of templates) {
    const key = `${template.kind}:${template.header ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(template);
  }
  return output;
}

function surfaceAuthTemplates(
  document: IntegrationSurfaceDocument,
  surface: IntegrationSurfacePointer,
): IntegrationAuthTemplate[] {
  const auth = surface.auth && typeof surface.auth === 'object'
    ? surface.auth as { status?: unknown; entries?: Array<{ use?: SurfaceCredentialUse[] }> }
    : null;
  if (auth?.status === 'none') return [{ kind: 'none' }];
  const templates: IntegrationAuthTemplate[] = [];
  for (const entry of auth?.status === 'required' && Array.isArray(auth.entries) ? auth.entries : []) {
    for (const use of Array.isArray(entry.use) ? entry.use : []) {
      const credential = typeof use.id === 'string' ? document.credentials?.[use.id] : undefined;
      const credentialType = typeof credential?.type === 'string' ? credential.type.toLowerCase() : '';
      const mechanics = use.mechanics;
      const scheme = typeof mechanics?.scheme === 'string' ? mechanics.scheme.toLowerCase() : '';
      const header = typeof mechanics?.headerName === 'string' ? mechanics.headerName : undefined;
      const description = credentialDescription(credential);
      if (credentialType === 'oauth2' || credentialType === 'oauth2_cc' || mechanics?.source === 'well-known') {
        templates.push({ kind: 'oauth2', description });
      } else if (credentialType === 'basic') {
        templates.push({ kind: 'basic', description });
      } else if (credentialType === 'bearer' || scheme === 'bearer') {
        templates.push({ kind: 'bearer', description });
      } else if (header) {
        templates.push({ kind: 'header', header, description });
      }
    }
  }
  return dedupeAuthTemplates(templates);
}

function resolveBaseUrl(document: OpenApiDocument, sourceUrl: URL): string {
  const server = document.servers?.find((entry) => typeof entry.url === 'string')?.url;
  if (server) {
    const resolved = new URL(server.replace(/\{[^}]+\}/g, ''), sourceUrl);
    publicHttpsUrl(resolved.toString(), 'Discovered API server');
    return resolved.toString().replace(/\/$/, '');
  }
  if (document.swagger && document.host) {
    const scheme = document.schemes?.includes('https') ? 'https' : document.schemes?.[0] ?? 'https';
    const resolved = new URL(`${scheme}://${document.host}${document.basePath ?? ''}`);
    publicHttpsUrl(resolved.toString(), 'Discovered API server');
    return resolved.toString().replace(/\/$/, '');
  }
  return sourceUrl.origin;
}

function authTemplates(document: OpenApiDocument): IntegrationAuthTemplate[] {
  const schemes = document.components?.securitySchemes ?? document.securityDefinitions ?? {};
  const templates: IntegrationAuthTemplate[] = [];
  for (const scheme of Object.values(schemes)) {
    const type = typeof scheme.type === 'string' ? scheme.type : '';
    const format = typeof scheme.scheme === 'string' ? scheme.scheme.toLowerCase() : '';
    if (type === 'oauth2') {
      templates.push({ kind: 'oauth2', description: 'OAuth 2.0 authorization declared by the API' });
    } else if (type === 'http' && format === 'bearer') {
      templates.push({ kind: 'bearer' });
    } else if (type === 'http' && format === 'basic') {
      templates.push({ kind: 'basic' });
    } else if (type === 'apiKey' && scheme.in === 'header' && typeof scheme.name === 'string') {
      templates.push({ kind: 'header', header: scheme.name });
    }
  }
  return templates.length > 0 ? templates : [{ kind: 'none' }, { kind: 'bearer' }];
}

function operationInputSchema(pathItem: Record<string, unknown>, operation: Record<string, unknown>): Record<string, unknown> {
  const parameters = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ] as Array<Record<string, unknown>>;
  const pathProperties: Record<string, unknown> = {};
  const pathRequired: string[] = [];
  const queryProperties: Record<string, unknown> = {};
  for (const parameter of parameters) {
    if (typeof parameter.name !== 'string') continue;
    const schema = parameter.schema && typeof parameter.schema === 'object' ? parameter.schema : { type: 'string' };
    if (parameter.in === 'path') {
      pathProperties[parameter.name] = schema;
      if (parameter.required !== false) pathRequired.push(parameter.name);
    } else if (parameter.in === 'query') {
      queryProperties[parameter.name] = schema;
    }
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (Object.keys(pathProperties).length > 0) {
    properties.path = { type: 'object', properties: pathProperties, required: pathRequired, additionalProperties: false };
    required.push('path');
  }
  if (Object.keys(queryProperties).length > 0) {
    properties.query = { type: 'object', properties: queryProperties, additionalProperties: true };
  }
  const requestBody = operation.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined;
  const bodySchema = requestBody?.content?.['application/json']?.schema;
  if (bodySchema) properties.body = bodySchema;
  return { type: 'object', properties, required, additionalProperties: false };
}

function operations(document: OpenApiDocument): IntegrationOperationDefinition[] {
  const output: IntegrationOperationDefinition[] = [];
  const usedNames = new Set<string>();
  for (const [path, rawPathItem] of Object.entries(document.paths ?? {})) {
    if (!rawPathItem || typeof rawPathItem !== 'object') continue;
    const pathItem = rawPathItem as Record<string, unknown>;
    for (const method of OPERATION_METHODS) {
      const rawOperation = pathItem[method];
      if (!rawOperation || typeof rawOperation !== 'object') continue;
      const operation = rawOperation as Record<string, unknown>;
      const operationId = typeof operation.operationId === 'string'
        ? operation.operationId
        : `${method}_${path}`;
      const baseName = integrationOperationMethodName(operationId);
      let name = baseName;
      let suffix = 2;
      while (usedNames.has(name)) name = `${baseName}${suffix++}`;
      usedNames.add(name);
      output.push({
        id: operationId,
        name,
        description: typeof operation.summary === 'string'
          ? operation.summary
          : typeof operation.description === 'string' ? operation.description : undefined,
        method: method.toUpperCase() as IntegrationOperationDefinition['method'],
        path,
        access: method === 'get' || method === 'head' ? 'read' : 'write',
        inputSchema: operationInputSchema(pathItem, operation),
      });
      if (output.length >= MAX_OPERATIONS) return output;
    }
  }
  return output;
}

function hostnameFamily(hostname: string): string {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  return labels.slice(-2).join('.');
}

function reviewWarnings(rawUrl: string, endpointUrl: string): string[] {
  const input = new URL(rawUrl);
  const endpoint = new URL(endpointUrl);
  if (hostnameFamily(input.hostname) === hostnameFamily(endpoint.hostname)) return [];
  return [`The discovered endpoint is hosted on ${endpoint.hostname}, outside ${input.hostname}. Verify that it belongs to the intended service.`];
}

function surfaceVariables(surface: IntegrationSurfacePointer, rawLocator?: string): IntegrationVariableDefinition[] {
  const declared = Array.isArray(surface.variables)
    ? surface.variables as Array<{ name?: unknown; in?: unknown; description?: unknown; resolveFrom?: unknown }>
    : [];
  const output: IntegrationVariableDefinition[] = declared
    .filter((variable) => typeof variable.name === 'string' && (!variable.in || variable.in === 'url'))
    .map((variable) => ({
      name: String(variable.name),
      in: 'url' as const,
      description: textValue(variable.description),
      resolveFrom: textValue(variable.resolveFrom),
    }));
  const seen = new Set(output.map((variable) => variable.name));
  for (const match of rawLocator?.matchAll(/\{([^}]+)\}|<([^>]+)>/g) ?? []) {
    const name = (match[1] ?? match[2])?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    output.push({ name, in: 'url' });
  }
  return output;
}

function urlUsesVariable(url: string, name: string): boolean {
  const lowered = url.toLowerCase();
  const normalizedName = name.toLowerCase();
  return lowered.includes(`{${normalizedName}}`) ||
    lowered.includes(`<${normalizedName}>`) ||
    lowered.includes(`%7b${normalizedName}%7d`) ||
    lowered.includes(`%3c${normalizedName}%3e`);
}

function definitionFromOpenApi(
  document: OpenApiDocument,
  sourceUrl: URL,
  rawUrl: string,
  provenance: 'declared' | 'detected' | 'discovered',
  surfaceName?: string,
  declaredAuth: IntegrationAuthTemplate[] = [],
  surfaceSlug?: string,
  variables: IntegrationVariableDefinition[] = [],
): WorkspaceIntegrationDefinition | null {
  const discoveredOperations = operations(document);
  if (discoveredOperations.length === 0) return null;
  const title = surfaceName || document.info?.title?.trim() || new URL(rawUrl).hostname;
  const baseUrl = resolveBaseUrl(document, sourceUrl);
  const applicableVariables = variables.filter((variable) => urlUsesVariable(baseUrl, variable.name));
  return {
    schemaVersion: 1,
    slug: surfaceSlug || integrationOperationMethodName(title, 'api').toLowerCase(),
    displayName: title,
    description: document.info?.description,
    surface: 'openapi',
    source: provenance,
    sourceUrl: sourceUrl.toString(),
    baseUrl,
    auth: dedupeAuthTemplates([...declaredAuth, ...authTemplates(document)]),
    variables: applicableVariables.length > 0 ? applicableVariables : undefined,
    warnings: reviewWarnings(rawUrl, baseUrl),
    operations: discoveredOperations,
    provenance: {
      kind: provenance,
      importedAt: Date.now(),
      documentTitle: document.info?.title,
      documentVersion: document.info?.version,
    },
  };
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function fallbackAuth(
  templates: IntegrationAuthTemplate[],
  authStatus: unknown,
): IntegrationAuthTemplate[] {
  return templates.length > 0
    ? templates
    : [{
      kind: 'unknown',
      description: authStatus === 'required'
        ? 'Authentication is required, but its request binding could not be normalized. Choose a method after verifying the service documentation.'
        : 'Authentication could not be determined. Choose a method after verifying the service documentation.',
    }];
}

function genericSurfaceDefinition(
  document: IntegrationSurfaceDocument,
  documentUrl: URL,
  surface: IntegrationSurfacePointer,
  rawUrl: string,
  provenance: 'declared' | 'detected' | 'discovered',
): WorkspaceIntegrationDefinition | null {
  if (typeof surface.url !== 'string') return null;
  let endpoint: URL;
  try {
    endpoint = publicHttpsUrl(new URL(surface.url, documentUrl).toString(), 'Discovered integration endpoint');
  } catch {
    return null;
  }
  const surfaceType = surface.type === 'graphql' ? 'graphql' : surface.type === 'mcp' ? 'mcp' : 'http';
  const fallbackTitle = textValue(document.domain) ?? new URL(rawUrl).hostname;
  const displayName = textValue(surface.name) ?? `${fallbackTitle} ${surfaceType === 'mcp' ? 'MCP' : surfaceType === 'graphql' ? 'GraphQL' : 'API'}`;
  const description = textValue(surface.notes) ?? textValue(document.description) ?? textValue(document.summary);
  const authStatus = surface.auth && typeof surface.auth === 'object'
    ? (surface.auth as { status?: unknown }).status
    : undefined;
  const discoveredAuth = fallbackAuth(surfaceAuthTemplates(document, surface), authStatus);
  const variables = surfaceVariables(surface, surface.url);
  const operations: IntegrationOperationDefinition[] = surfaceType === 'graphql'
    ? [{
      id: 'graphql.execute',
      name: 'executeGraphql',
      description: 'Execute a GraphQL document. Conservatively classified as write because the document may contain mutations.',
      method: 'POST',
      path: '',
      access: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          body: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              variables: { type: 'object', additionalProperties: true },
              operationName: { type: 'string' },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
        required: ['body'],
        additionalProperties: false,
      },
    }]
    : [];
  return {
    schemaVersion: 1,
    slug: textValue(surface.slug) ?? integrationOperationMethodName(`${displayName} ${surfaceType}`, 'integration').toLowerCase(),
    displayName,
    description,
    surface: surfaceType,
    source: provenance,
    sourceUrl: documentUrl.toString(),
    baseUrl: endpoint.toString().replace(/\/$/, ''),
    auth: discoveredAuth,
    variables: variables.length > 0 ? variables : undefined,
    warnings: reviewWarnings(rawUrl, endpoint.toString()),
    operations,
    provenance: {
      kind: provenance,
      importedAt: Date.now(),
      documentTitle: displayName,
      documentVersion: typeof document.version === 'number' || typeof document.version === 'string'
        ? String(document.version)
        : undefined,
    },
  };
}

async function definitionsFromSurfaceDocument(
  documentUrl: URL,
  rawUrl: string,
  prefetched?: Record<string, unknown> | null,
): Promise<WorkspaceIntegrationDefinition[]> {
  const document = (prefetched ?? await fetchDocument(documentUrl)) as IntegrationSurfaceDocument | null;
  if (!document || !Array.isArray(document.surfaces)) return [];
  const resolved = await Promise.all(document.surfaces.slice(0, MAX_DISCOVERED_SURFACES).map(async (surface) => {
    if (!surface || !['http', 'graphql', 'mcp'].includes(String(surface.type))) return null;
    const basis = surface.basis?.via;
    const provenance = documentUrl.hostname !== 'integrations.sh' || basis === 'declared'
      ? 'declared'
      : basis === 'detected' ? 'detected' : 'discovered';
    const discoveredAuth = surfaceAuthTemplates(document, surface);
    if (surface.type === 'http' && typeof surface.spec === 'string') {
      try {
        const specUrl = publicHttpsUrl(new URL(surface.spec, documentUrl).toString(), 'Declared OpenAPI document');
        const openApi = await fetchOpenApiDocument(specUrl);
        const definition = openApi && definitionFromOpenApi(
          openApi,
          specUrl,
          rawUrl,
          provenance,
          textValue(surface.name),
          discoveredAuth,
          textValue(surface.slug),
          surfaceVariables(surface, textValue(surface.url)),
        );
        if (definition) {
          return definition;
        }
      } catch {
        // A bad or stale spec pointer can still fall back to the declared base URL.
      }
    }
    return genericSurfaceDefinition(document, documentUrl, surface, rawUrl, provenance);
  }));
  return resolved.filter((definition): definition is WorkspaceIntegrationDefinition => Boolean(definition));
}

function definitionFromMcpServerCard(
  card: Record<string, unknown> | null,
  cardUrl: URL,
  rawUrl: string,
): WorkspaceIntegrationDefinition | null {
  if (!card) return null;
  const remote = Array.isArray(card.remotes)
    ? card.remotes.find((candidate) => candidate && typeof candidate === 'object' && typeof (candidate as { url?: unknown }).url === 'string') as Record<string, unknown> | undefined
    : undefined;
  const endpointValue = textValue(card.url) ?? textValue(remote?.url);
  if (!endpointValue) return null;
  let endpoint: URL;
  try {
    endpoint = publicHttpsUrl(new URL(endpointValue, cardUrl).toString(), 'MCP server endpoint');
  } catch {
    return null;
  }
  const authentication = card.authentication && typeof card.authentication === 'object'
    ? card.authentication as { type?: unknown }
    : null;
  const authType = textValue(authentication?.type)?.toLowerCase();
  const auth: IntegrationAuthTemplate[] = authType?.includes('oauth')
    ? [{ kind: 'oauth2', description: 'OAuth metadata declared by the MCP server card.' }]
    : authType === 'none'
      ? [{ kind: 'none' }]
      : [{ kind: 'unknown', description: 'Authentication was not declared by the MCP server card. Choose a method after verifying the service documentation.' }];
  const hostname = new URL(rawUrl).hostname;
  return {
    schemaVersion: 1,
    slug: integrationOperationMethodName(`${hostname} mcp`, 'mcp').toLowerCase(),
    displayName: textValue(card.name) ?? `${hostname} MCP`,
    description: textValue(card.description),
    surface: 'mcp',
    source: 'detected',
    sourceUrl: cardUrl.toString(),
    baseUrl: endpoint.toString().replace(/\/$/, ''),
    auth,
    warnings: reviewWarnings(rawUrl, endpoint.toString()),
    operations: [],
    provenance: { kind: 'detected', importedAt: Date.now() },
  };
}

function uniqueDefinitions(definitions: WorkspaceIntegrationDefinition[]): WorkspaceIntegrationDefinition[] {
  const output: WorkspaceIntegrationDefinition[] = [];
  const locatorIndexes = new Map<string, number>();
  const slugs = new Set<string>();
  const score = (definition: WorkspaceIntegrationDefinition) => {
    let catalogSource = false;
    try {
      catalogSource = Boolean(definition.sourceUrl && new URL(definition.sourceUrl).hostname === 'integrations.sh');
    } catch {
      // Invalid source metadata is already ignored elsewhere; rank it conservatively here.
    }
    const trust = definition.source === 'declared'
      ? catalogSource ? 4_200 : 6_000
      : definition.source === 'detected'
        ? catalogSource ? 3_400 : 5_000
        : definition.source === 'discovered' ? 2_500 : 1_000;
    const knownAuth = definition.auth.some((auth) => auth.kind !== 'unknown');
    const capability = definition.surface === 'mcp'
      ? knownAuth ? 700 : 250
      : definition.surface === 'openapi' ? 650
        : definition.surface === 'graphql' ? 400 : 200;
    return trust + capability + Math.min(definition.operations.length, 40) - (definition.warnings?.length ? 75 : 0);
  };
  for (const definition of definitions) {
    const locatorKind = definition.surface === 'openapi' || definition.surface === 'http'
      ? 'http'
      : definition.surface;
    const locator = `${locatorKind}:${definition.baseUrl.toLowerCase().replace(/\/$/, '')}`;
    const existingIndex = locatorIndexes.get(locator);
    if (existingIndex !== undefined) {
      if (score(definition) > score(output[existingIndex]!)) {
        output[existingIndex] = { ...definition, slug: output[existingIndex]!.slug };
      }
      continue;
    }
    const baseSlug = definition.slug || integrationOperationMethodName(definition.displayName, 'integration').toLowerCase();
    let slug = baseSlug;
    for (let suffix = 2; slugs.has(slug); suffix += 1) slug = `${baseSlug}-${suffix}`;
    slugs.add(slug);
    locatorIndexes.set(locator, output.length);
    output.push({ ...definition, slug });
  }
  return output.sort((left, right) => score(right) - score(left));
}

export async function discoverIntegrationSurfaces(rawUrl: string): Promise<WorkspaceIntegrationDefinition[]> {
  const input = publicHttpsUrl(rawUrl, 'API URL');
  const looksLikeSpec = /(?:openapi|swagger)(?:\.[^/]+)?$/i.test(input.pathname) || /\.(?:json|ya?ml)$/i.test(input.pathname);
  if (looksLikeSpec) {
    const document = await fetchOpenApiDocument(input);
    const definition = document && definitionFromOpenApi(document, input, rawUrl, 'detected');
    if (definition) return [definition];
    throw new IntegrationDiscoveryError('The URL did not return a usable OpenAPI document.');
  }

  const declaredUrl = new URL('/.well-known/integrations.json', input.origin);
  const mcpCardUrl = new URL('/.well-known/mcp/server-card.json', input.origin);
  const catalogUrl = new URL(
    `/api/${encodeURIComponent(input.hostname.toLowerCase())}/surface`,
    'https://integrations.sh',
  );
  const conventionalCandidates = discoveryCandidates(rawUrl);
  const [declaredDocument, mcpCard, catalogDocument, conventionalDocuments] = await Promise.all([
    fetchDocument(declaredUrl),
    fetchDocument(mcpCardUrl),
    fetchDocument(catalogUrl),
    Promise.all(conventionalCandidates.map(async (candidate) => ({
      candidate,
      document: await fetchOpenApiDocument(candidate),
    }))),
  ]);

  const definitions: WorkspaceIntegrationDefinition[] = [];
  definitions.push(...await definitionsFromSurfaceDocument(declaredUrl, rawUrl, declaredDocument));
  for (const { candidate, document } of conventionalDocuments) {
    if (!document) continue;
    const definition = definitionFromOpenApi(document, candidate, rawUrl, 'detected');
    if (definition) definitions.push(definition);
  }
  const mcpDefinition = definitionFromMcpServerCard(mcpCard, mcpCardUrl, rawUrl);
  if (mcpDefinition) definitions.push(mcpDefinition);
  definitions.push(...await definitionsFromSurfaceDocument(catalogUrl, rawUrl, catalogDocument));

  const unique = uniqueDefinitions(definitions);
  if (unique.length > 0) return unique;
  throw new IntegrationDiscoveryError(
    'No API, GraphQL, or remote MCP surface was found in owner declarations, conventional paths, or integrations.sh. Try a direct OpenAPI URL, or use generic HTTP setup.',
  );
}

export async function discoverOpenApiIntegration(rawUrl: string): Promise<WorkspaceIntegrationDefinition> {
  const definitions = await discoverIntegrationSurfaces(rawUrl);
  const openApi = definitions.find((definition) => definition.surface === 'openapi');
  if (!openApi) {
    throw new IntegrationDiscoveryError('No OpenAPI document was found for this service.');
  }
  return openApi;
}
