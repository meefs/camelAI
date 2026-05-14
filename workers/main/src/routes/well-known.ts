/**
 * .well-known OAuth discovery endpoints.
 * These stay in the worker route table because React Router
 * can't handle dotfile paths like /.well-known/*.
 */

import type { RouteContext } from '../types.js';
import { ADMIN_MCP_SCOPE } from '../admin-mcp-oauth.js';

function getBaseUrl(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function getAdminMcpResource(base: string): string {
  return `${base}/api/admin/mcp`;
}

function getAdminOAuthIssuer(base: string): string {
  return `${base}/api/admin/oauth`;
}

function isAdminMcpResourcePath(pathname: string): boolean {
  return pathname.endsWith('/api/admin/mcp') || pathname.includes('/api/admin/mcp/');
}

export async function handleOAuthMetadata({ req }: RouteContext): Promise<Response | null> {
  if (req.method !== 'GET') return null;
  const base = getBaseUrl(req);
  const url = new URL(req.url);
  const adminIssuer = getAdminOAuthIssuer(base);
  const isAdminMcp = url.pathname.includes('/api/admin/oauth') ||
    url.pathname.includes('/api/admin/mcp') ||
    url.searchParams.get('resource') === getAdminMcpResource(base) ||
    url.searchParams.get('issuer') === adminIssuer;

  if (isAdminMcp) {
    return Response.json({
      issuer: adminIssuer,
      authorization_endpoint: `${base}/api/admin/oauth/authorize`,
      token_endpoint: `${base}/api/admin/oauth/token`,
      revocation_endpoint: `${base}/api/admin/oauth/revoke`,
      registration_endpoint: `${base}/api/admin/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [ADMIN_MCP_SCOPE],
      resource_parameter_supported: true,
    }, { headers: { 'cache-control': 'public, max-age=3600' } });
  }

  return Response.json({
    issuer: base,
    authorization_endpoint: `${base}/api/ext/oauth/authorize`,
    token_endpoint: `${base}/api/ext/oauth/token`,
    revocation_endpoint: `${base}/api/ext/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['workspace'],
  }, { headers: { 'cache-control': 'public, max-age=3600' } });
}

export async function handleResourceMetadata({ req }: RouteContext): Promise<Response | null> {
  if (req.method !== 'GET') return null;
  const base = getBaseUrl(req);
  const url = new URL(req.url);
  const requestedResource = url.searchParams.get('resource');
  if (
    requestedResource === getAdminMcpResource(base) ||
    isAdminMcpResourcePath(url.pathname)
  ) {
    return Response.json({
      resource: getAdminMcpResource(base),
      authorization_servers: [getAdminOAuthIssuer(base)],
      bearer_methods_supported: ['header'],
      scopes_supported: [ADMIN_MCP_SCOPE],
      resource_name: 'camelAI Admin MCP',
    }, { headers: { 'cache-control': 'public, max-age=3600' } });
  }

  return Response.json({
    resource: `${base}/api/ext`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['workspace'],
    resource_name: 'camelAI Workspace',
  }, { headers: { 'cache-control': 'public, max-age=3600' } });
}
