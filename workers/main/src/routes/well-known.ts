/**
 * .well-known OAuth discovery endpoints.
 * These stay in the worker route table because React Router
 * can't handle dotfile paths like /.well-known/*.
 */

import type { RouteContext } from '../types.js';

function getBaseUrl(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export async function handleOAuthMetadata({ req }: RouteContext): Promise<Response | null> {
  if (req.method !== 'GET') return null;
  const base = getBaseUrl(req);
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
  return Response.json({
    resource: `${base}/api/ext`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['workspace'],
    resource_name: 'camelAI Workspace',
  }, { headers: { 'cache-control': 'public, max-age=3600' } });
}
