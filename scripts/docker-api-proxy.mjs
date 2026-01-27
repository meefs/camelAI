#!/usr/bin/env node
/**
 * Docker API Proxy that adds FUSE support to all containers
 * Intercepts container create requests and adds privileged mode.
 */

import net from 'node:net';
import fs from 'node:fs';

const PROXY_SOCKET = '/tmp/docker-fuse-proxy.sock';
const DOCKER_SOCKET = '/var/run/docker.sock';

// Remove stale socket
try { fs.unlinkSync(PROXY_SOCKET); } catch { /* ignore */ }

const server = net.createServer((client) => {
  const docker = net.createConnection(DOCKER_SOCKET);

  let buffer = Buffer.alloc(0);
  let state = 'detect'; // 'detect', 'intercept', 'passthrough'
  let contentLength = 0;
  let headerEndIndex = -1;

  client.on('data', (chunk) => {
    if (state === 'passthrough') {
      // Already determined this connection should pass through
      docker.write(chunk);
      return;
    }

    buffer = Buffer.concat([buffer, chunk]);

    if (state === 'detect') {
      // Look for end of headers to determine request type
      headerEndIndex = buffer.indexOf('\r\n\r\n');
      if (headerEndIndex === -1) {
        // Need more data for headers - but don't wait too long
        // If buffer is large, assume it's a build context and pass through
        if (buffer.length > 8192) {
          state = 'passthrough';
          docker.write(buffer);
          buffer = Buffer.alloc(0);
        }
        return;
      }

      const headers = buffer.slice(0, headerEndIndex).toString();

      // Only intercept POST /containers/create
      const isCreateContainer = /POST\s+\/[^\s]*\/containers\/create/.test(headers) ||
                                /POST\s+\/containers\/create/.test(headers);

      if (!isCreateContainer) {
        // Pass through everything else immediately
        state = 'passthrough';
        docker.write(buffer);
        buffer = Buffer.alloc(0);
        return;
      }

      // This is a create request - intercept it
      state = 'intercept';
      const clMatch = headers.match(/Content-Length:\s*(\d+)/i);
      contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
    }

    if (state === 'intercept') {
      const bodyStart = headerEndIndex + 4;
      const bodyReceived = buffer.length - bodyStart;

      if (bodyReceived < contentLength) {
        // Still waiting for full body
        return;
      }

      // We have the full create request - modify it
      const headers = buffer.slice(0, headerEndIndex).toString();
      const body = buffer.slice(bodyStart, bodyStart + contentLength).toString();

      try {
        const json = JSON.parse(body);
        if (!json.HostConfig) json.HostConfig = {};
        json.HostConfig.Privileged = true;

        const newBody = JSON.stringify(json);
        const newHeaders = headers.replace(
          /Content-Length:\s*\d+/i,
          `Content-Length: ${Buffer.byteLength(newBody)}`
        );

        console.log('[docker-proxy] Modified container create for FUSE support');
        docker.write(newHeaders + '\r\n\r\n' + newBody);

        // Any remaining data after this request
        const remaining = buffer.slice(bodyStart + contentLength);
        if (remaining.length > 0) {
          docker.write(remaining);
        }
      } catch (e) {
        console.error('[docker-proxy] Failed to modify:', e.message);
        docker.write(buffer);
      }

      // Switch to passthrough for rest of connection
      state = 'passthrough';
      buffer = Buffer.alloc(0);
    }
  });

  // Forward response back to client
  docker.on('data', (chunk) => client.write(chunk));

  client.on('end', () => docker.end());
  docker.on('end', () => client.end());
  client.on('error', () => docker.destroy());
  docker.on('error', () => client.destroy());
});

server.listen(PROXY_SOCKET, () => {
  fs.chmodSync(PROXY_SOCKET, 0o666);
  console.log(`[docker-proxy] Listening on ${PROXY_SOCKET}`);
  console.log(`[docker-proxy] Use: DOCKER_HOST=unix://${PROXY_SOCKET}`);
});

process.on('SIGINT', () => {
  server.close();
  try { fs.unlinkSync(PROXY_SOCKET); } catch { /* ignore */ }
  process.exit(0);
});
