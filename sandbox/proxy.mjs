#!/usr/bin/env node
/**
 * Integration Proxy for Chiridion
 *
 * Runs inside the sandbox container and forwards requests to the Chiridion
 * proxy endpoint. All integrations use port 8080 - the integration ID is
 * extracted from the auth header and determines the upstream destination.
 *
 * Credentials are read from /tmp/proxy-creds on each request, allowing
 * the token to be updated without restarting the proxy.
 *
 * Environment variables (for initial startup only):
 *   CHIRIDION_PROXY_TOKEN     - API token for Chiridion authentication
 *   CHIRIDION_PROXY_BASE_URL  - Base URL of Chiridion app
 *   CHIRIDION_ORG_ID          - Organization ID
 *
 * Or credentials file (/tmp/proxy-creds):
 *   CHIRIDION_PROXY_TOKEN=xxx
 *   CHIRIDION_PROXY_BASE_URL=https://...
 *   CHIRIDION_ORG_ID=org_xxx
 *
 * Usage:
 *   // Any SDK - use integration ID as the API key, point to localhost:8080
 *   const stripe = new Stripe('your-stripe-integration-id', {
 *     host: '127.0.0.1',
 *     port: 8080,
 *     protocol: 'http',
 *   });
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

const PROXY_PORT = process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT, 10) : 8081;
const CREDS_FILE = '/tmp/proxy-creds';

/**
 * Read credentials from file or fall back to environment variables.
 * Called on each request to pick up token updates.
 */
function getCredentials() {
  // Try reading from file first (allows hot-reload of credentials)
  try {
    if (fs.existsSync(CREDS_FILE)) {
      const content = fs.readFileSync(CREDS_FILE, 'utf-8');
      const creds = {};
      for (const line of content.split('\n')) {
        const match = line.match(/^([A-Z_]+)=(.*)$/);
        if (match) {
          creds[match[1]] = match[2];
        }
      }
      if (creds.CHIRIDION_PROXY_TOKEN && creds.CHIRIDION_PROXY_BASE_URL && creds.CHIRIDION_ORG_ID) {
        return creds;
      }
    }
  } catch (e) {
    // Fall through to env vars
  }

  // Fall back to environment variables
  return {
    CHIRIDION_PROXY_TOKEN: process.env.CHIRIDION_PROXY_TOKEN,
    CHIRIDION_PROXY_BASE_URL: process.env.CHIRIDION_PROXY_BASE_URL,
    CHIRIDION_ORG_ID: process.env.CHIRIDION_ORG_ID,
  };
}

/**
 * Extract integration ID from request headers.
 * Tries multiple formats to support different SDKs.
 */
function extractIntegrationId(req) {
  // Try Authorization: Bearer <id>
  const auth = req.headers.authorization || '';
  const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) return bearerMatch[1];

  // Try x-api-key header (Anthropic style)
  if (req.headers['x-api-key']) return req.headers['x-api-key'];

  // Try explicit x-integration-id header
  if (req.headers['x-integration-id']) return req.headers['x-integration-id'];

  return null;
}

// Check if we have credentials available (from file or env)
const initialCreds = getCredentials();
if (!initialCreds.CHIRIDION_PROXY_TOKEN || !initialCreds.CHIRIDION_PROXY_BASE_URL || !initialCreds.CHIRIDION_ORG_ID) {
  console.log('[proxy] No credentials available yet (will check on each request)');
  console.log('[proxy]   CHIRIDION_PROXY_TOKEN:', initialCreds.CHIRIDION_PROXY_TOKEN ? 'set' : 'not set');
  console.log('[proxy]   CHIRIDION_PROXY_BASE_URL:', initialCreds.CHIRIDION_PROXY_BASE_URL || 'not set');
  console.log('[proxy]   CHIRIDION_ORG_ID:', initialCreds.CHIRIDION_ORG_ID || 'not set');
} else {
  console.log('[proxy] Credentials loaded');
  console.log('[proxy]   CHIRIDION_PROXY_TOKEN:', initialCreds.CHIRIDION_PROXY_TOKEN.slice(0, 8) + '...');
  console.log('[proxy]   CHIRIDION_PROXY_BASE_URL:', initialCreds.CHIRIDION_PROXY_BASE_URL);
  console.log('[proxy]   CHIRIDION_ORG_ID:', initialCreds.CHIRIDION_ORG_ID);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res);
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`[proxy] Listening on http://127.0.0.1:${PROXY_PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[proxy] Port ${PROXY_PORT} already in use (proxy already running)`);
    process.exit(0); // Exit cleanly - proxy is already running
  } else {
    console.error('[proxy] Server error:', err.message);
  }
});

function handleRequest(req, res) {
  // Read credentials fresh on each request
  const creds = getCredentials();

  if (!creds.CHIRIDION_PROXY_TOKEN || !creds.CHIRIDION_PROXY_BASE_URL || !creds.CHIRIDION_ORG_ID) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Proxy not configured',
      details: 'Missing credentials. Ensure CHIRIDION_PROXY_TOKEN, CHIRIDION_PROXY_BASE_URL, and CHIRIDION_ORG_ID are set.',
    }));
    return;
  }

  // Extract integration ID from the request
  const integrationId = extractIntegrationId(req);

  if (!integrationId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Missing integration ID',
      details: 'Pass the integration ID where you would normally pass the API key (Authorization: Bearer <id> or x-api-key header)',
    }));
    return;
  }

  // Build the target URL
  const targetUrl = new URL(creds.CHIRIDION_PROXY_BASE_URL);
  const isHttps = targetUrl.protocol === 'https:';
  const httpModule = isHttps ? https : http;

  const requestPath = req.url || '/';
  const proxyPath = `/api/orgs/${creds.CHIRIDION_ORG_ID}/integrations/${integrationId}/proxy${requestPath}`;

  // Build headers - forward relevant ones and add Chiridion auth
  const headers = {
    host: targetUrl.host,
    authorization: `Bearer ${creds.CHIRIDION_PROXY_TOKEN}`,
  };

  // Forward specific headers from the original request (but NOT the original auth)
  const headersToForward = ['content-type', 'accept', 'user-agent', 'content-length'];
  for (const header of headersToForward) {
    if (req.headers[header]) {
      headers[header] = req.headers[header];
    }
  }

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: proxyPath,
    method: req.method,
    headers,
  };

  console.log(`[proxy] ${req.method} ${req.url} -> integration:${integrationId.slice(0, 8)}...`);

  // Make the proxied request
  const proxyReq = httpModule.request(options, (proxyRes) => {
    // Forward status and headers
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[proxy] Request error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy request failed', details: err.message }));
    }
  });

  // Forward request body
  req.pipe(proxyReq);
}
