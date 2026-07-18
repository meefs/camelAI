import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverIntegrationSurfaces,
  discoverOpenApiIntegration,
} from '@/lib/openapi-integration.server';
import { resolveIntegrationDefinitionVariables } from '@/lib/integration-definition';

describe('OpenAPI integration discovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('imports typed operations, auth templates, provenance, and access policy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      openapi: '3.1.0',
      info: { title: 'Example CRM', version: '2.0' },
      servers: [{ url: 'https://api.example.com/v2' }],
      components: {
        securitySchemes: {
          token: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
      paths: {
        '/contacts/{contactId}': {
          get: {
            operationId: 'getContact',
            summary: 'Get one contact',
            parameters: [
              { name: 'contactId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'expand', in: 'query', schema: { type: 'string' } },
            ],
          },
          patch: {
            operationId: 'updateContact',
            requestBody: {
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    })));

    await expect(discoverOpenApiIntegration('https://docs.example.com/openapi.json'))
      .resolves.toMatchObject({
        schemaVersion: 1,
        displayName: 'Example CRM',
        baseUrl: 'https://api.example.com/v2',
        source: 'detected',
        auth: [{ kind: 'header', header: 'X-API-Key' }],
        provenance: {
          kind: 'detected',
          documentTitle: 'Example CRM',
          documentVersion: '2.0',
        },
        operations: [
          { id: 'getContact', name: 'getContact', method: 'GET', access: 'read' },
          { id: 'updateContact', name: 'updateContact', method: 'PATCH', access: 'write' },
        ],
      });
  });

  it('rejects discovery redirects to local network targets', async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://localhost/openapi.json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverOpenApiIntegration('https://api.example.com/openapi.json'))
      .rejects.toThrow('did not return a usable OpenAPI document');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prefers owner-declared integrations.json pointers and parses YAML specs', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target === 'https://service.example/.well-known/integrations.json') {
        return Response.json({
          version: 3,
          surfaces: [{
            type: 'http',
            name: 'Declared API',
            spec: 'https://specs.example/service.yaml',
          }],
        });
      }
      if (target === 'https://specs.example/service.yaml') {
        return new Response([
          'openapi: 3.0.3',
          'info:',
          '  title: Service API',
          '  version: "1"',
          'servers:',
          '  - url: https://api.service.example/v1',
          'paths:',
          '  /widgets:',
          '    get:',
          '      operationId: listWidgets',
        ].join('\n'), { headers: { 'content-type': 'application/yaml' } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverOpenApiIntegration('https://service.example'))
      .resolves.toMatchObject({
        displayName: 'Declared API',
        baseUrl: 'https://api.service.example/v1',
        provenance: { kind: 'declared' },
        operations: [{ name: 'listWidgets', access: 'read' }],
      });
    const fetchedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(fetchedUrls).toContain('https://service.example/.well-known/integrations.json');
    expect(fetchedUrls).toContain('https://specs.example/service.yaml');
  });

  it('imports MCP, GraphQL, and OpenAPI surfaces from integrations.sh stored discovery', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target === 'https://integrations.sh/api/service.example/surface') {
        return Response.json({
          version: 3,
          domain: 'service.example',
          summary: 'Example service integrations',
          credentials: {
            oauth: {
              type: 'oauth2',
              label: 'Example OAuth',
              setup: 'Authorize access in the browser.',
            },
            token: {
              type: 'api_key',
              label: 'Example API key',
              setup: 'Create a key in account settings.',
            },
          },
          surfaces: [
            {
              type: 'mcp',
              slug: 'remote-mcp',
              name: 'Example MCP',
              url: 'https://mcp.service.example/mcp',
              auth: {
                status: 'required',
                entries: [{ use: [{ id: 'oauth', mechanics: { source: 'well-known' } }] }],
              },
            },
            {
              type: 'graphql',
              slug: 'graphql-api',
              name: 'Example GraphQL',
              url: 'https://api.service.example/graphql',
              auth: {
                status: 'required',
                entries: [{ use: [{ id: 'token', mechanics: { source: 'http', headerName: 'X-Service-Key' } }] }],
              },
            },
            {
              type: 'http',
              slug: 'rest-api',
              name: 'Example REST',
              spec: 'https://specs.service.example/openapi.json',
              auth: { status: 'unknown' },
            },
          ],
        });
      }
      if (target === 'https://specs.service.example/openapi.json') {
        return Response.json({
          openapi: '3.1.0',
          info: { title: 'Example REST' },
          servers: [{ url: 'https://api.service.example/v1' }],
          paths: { '/widgets': { get: { operationId: 'listWidgets' } } },
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverIntegrationSurfaces('https://service.example')).resolves.toMatchObject([
      {
        slug: 'remote-mcp',
        surface: 'mcp',
        source: 'discovered',
        baseUrl: 'https://mcp.service.example/mcp',
        auth: [{ kind: 'oauth2', description: expect.stringContaining('Authorize access') }],
      },
      {
        slug: 'rest-api',
        surface: 'openapi',
        baseUrl: 'https://api.service.example/v1',
        operations: [{ name: 'listWidgets', access: 'read' }],
      },
      {
        slug: 'graphql-api',
        surface: 'graphql',
        baseUrl: 'https://api.service.example/graphql',
        auth: [{ kind: 'header', header: 'X-Service-Key' }],
        operations: [{ id: 'graphql.execute', access: 'write', path: '' }],
      },
    ]);
  });

  it('detects a remote MCP server card without integrations.sh', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url) === 'https://service.example/.well-known/mcp/server-card.json') {
        return Response.json({
          name: 'Owner MCP',
          url: 'https://mcp.service.example/mcp',
          authentication: { type: 'oauth2' },
        });
      }
      return new Response(null, { status: 404 });
    }));

    await expect(discoverIntegrationSurfaces('https://service.example')).resolves.toMatchObject([
      {
        displayName: 'Owner MCP',
        surface: 'mcp',
        source: 'detected',
        auth: [{ kind: 'oauth2' }],
      },
    ]);
  });

  it('ranks a known-auth direct MCP surface ahead of direct OpenAPI and catalog results', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target === 'https://service.example/.well-known/mcp/server-card.json') {
        return Response.json({
          name: 'Owner MCP',
          url: 'https://mcp.service.example/mcp',
          authentication: { type: 'oauth2' },
        });
      }
      if (target === 'https://service.example/.well-known/openapi.json') {
        return Response.json({
          openapi: '3.1.0',
          info: { title: 'Conventional API' },
          servers: [{ url: 'https://api.service.example' }],
          paths: { '/items': { get: { operationId: 'listItems' } } },
        });
      }
      if (target === 'https://integrations.sh/api/service.example/surface') {
        return Response.json({
          version: 3,
          domain: 'service.example',
          surfaces: [{
            type: 'http',
            name: 'Catalog API',
            url: 'https://catalog.service.example',
            basis: { via: 'declared' },
          }],
        });
      }
      return new Response(null, { status: 404 });
    }));

    const definitions = await discoverIntegrationSurfaces('https://service.example');
    expect(definitions.map((definition) => definition.displayName)).toEqual([
      'Owner MCP',
      'Conventional API',
      'Catalog API',
    ]);
  });

  it('captures and safely resolves tenant URL variables while warning about a different endpoint domain', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url) === 'https://integrations.sh/api/shopify.com/surface') {
        return Response.json({
          version: 3,
          domain: 'shopify.com',
          surfaces: [{
            type: 'graphql',
            slug: 'admin-graphql',
            name: 'Shopify Admin GraphQL',
            url: 'https://{shop}.myshopify.com/admin/api/{api_version}/graphql.json',
            variables: [
              { name: 'shop', description: 'Shop subdomain' },
              { name: 'api_version', description: 'Shopify API version' },
            ],
            auth: { status: 'unknown' },
            basis: { via: 'discovered', evidence: ['https://shopify.dev/docs/api/admin-graphql'] },
          }],
        });
      }
      return new Response(null, { status: 404 });
    }));

    const [definition] = await discoverIntegrationSurfaces('https://shopify.com');
    expect(definition).toMatchObject({
      surface: 'graphql',
      auth: [{ kind: 'unknown' }],
      variables: [
        { name: 'shop', in: 'url' },
        { name: 'api_version', in: 'url' },
      ],
      warnings: [expect.stringContaining('myshopify.com')],
    });
    expect(resolveIntegrationDefinitionVariables(definition!, {
      shop: 'acme-store',
      api_version: '2026-07',
    }).baseUrl).toBe('https://acme-store.myshopify.com/admin/api/2026-07/graphql.json');
    expect(() => resolveIntegrationDefinitionVariables(definition!, {
      shop: 'localhost/path',
      api_version: '2026-07',
    })).toThrow('hostname-safe');
  });

  it('deduplicates discovered generic HTTP when a stronger OpenAPI definition shares its endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target === 'https://service.example/.well-known/integrations.json') {
        return Response.json({
          version: 3,
          surfaces: [{
            type: 'http',
            slug: 'owner-api',
            name: 'Owner API',
            spec: 'https://service.example/openapi-owner.json',
            url: 'https://api.service.example',
          }],
        });
      }
      if (target === 'https://service.example/openapi-owner.json') {
        return Response.json({
          openapi: '3.1.0',
          info: { title: 'Owner API' },
          servers: [{ url: 'https://api.service.example' }],
          paths: { '/items': { get: { operationId: 'listItems' } } },
        });
      }
      if (target === 'https://integrations.sh/api/service.example/surface') {
        return Response.json({
          version: 3,
          domain: 'service.example',
          surfaces: [{
            type: 'http',
            slug: 'catalog-api',
            name: 'Catalog API',
            url: 'https://api.service.example',
            auth: { status: 'unknown' },
            basis: { via: 'discovered', evidence: ['https://service.example/docs'] },
          }],
        });
      }
      return new Response(null, { status: 404 });
    }));

    await expect(discoverIntegrationSurfaces('https://service.example')).resolves.toMatchObject([
      {
        surface: 'openapi',
        source: 'declared',
        baseUrl: 'https://api.service.example',
        operations: [{ name: 'listItems' }],
      },
    ]);
  });
});
