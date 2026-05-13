#!/usr/bin/env node

const baseUrl = requiredEnv('CAMELAI_WORKER_URL').replace(/\/+$/, '');
const sandboxSecret = requiredEnv('SANDBOX_PROXY_SECRET');
const orgId = requiredEnv('CHIRIDION_ORG_ID');
const workspaceId = requiredEnv('CHIRIDION_WORKSPACE_ID');
const userId = process.env.CHIRIDION_USER_ID || 'connections-mcp-smoke';
const expectedConnections = csv(process.env.EXPECT_CONNECTIONS);
const expectedNativeMcp = csv(process.env.EXPECT_NATIVE_MCP);
const safeCalls = parseSafeCalls(process.env.CONNECTION_MCP_SAFE_CALLS);

const headers = {
  'content-type': 'application/json',
  'x-sandbox-secret': sandboxSecret,
  'x-chiridion-org-id': orgId,
  'x-chiridion-workspace-id': workspaceId,
  'x-chiridion-user-id': userId,
  'x-chiridion-thread-id': process.env.CHIRIDION_THREAD_ID || 'connections-mcp-smoke',
};

const failures = [];

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return value;
}

function csv(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSafeCalls(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('expected an array');
    return parsed.map((item) => ({
      connection: String(item.connection || ''),
      method: String(item.method || ''),
      input: item.input && typeof item.input === 'object' && !Array.isArray(item.input)
        ? item.input
        : {},
    })).filter((item) => item.connection && item.method);
  } catch (error) {
    console.error(`Invalid CONNECTION_MCP_SAFE_CALLS JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

async function postJson(path, body, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : null;
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${text.slice(0, 600)}`);
  }
  return { response, payload };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .filter((line) => line && line !== '[DONE]');
    if (dataLines.length > 0) {
      try {
        return JSON.parse(dataLines.join('\n'));
      } catch {
        return { raw: text };
      }
    }
    return { raw: text };
  }
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function connectionKey(connection) {
  return `${connection.id}:${connection.type || connection.integration_type}:${connection.name}`;
}

async function mcpRpc(path, method, params = {}, sessionId) {
  const rpcHeaders = {
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
  if (sessionId) rpcHeaders['mcp-session-id'] = sessionId;
  const { response, payload } = await postJson(path, {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  }, rpcHeaders);
  if (payload?.error) {
    throw new Error(`${path} ${method} returned JSON-RPC error: ${JSON.stringify(payload.error)}`);
  }
  return { response, result: payload?.result ?? payload };
}

async function nativeTools(connectionId) {
  const initialized = await mcpRpc(`/mcp/integrations/native/${encodeURIComponent(connectionId)}`, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'camelai-connections-smoke', version: '1.0.0' },
  });
  const sessionId = initialized.response.headers.get('mcp-session-id');
  const tools = await mcpRpc(
    `/mcp/integrations/native/${encodeURIComponent(connectionId)}`,
    'tools/list',
    {},
    sessionId
  );
  return tools.result?.tools || [];
}

async function main() {
  console.log(`Testing connections MCP for workspace ${workspaceId} at ${baseUrl}`);

  const connections = await postJson('/api/connections', { action: 'list' }).then((r) => r.payload);
  assert(Array.isArray(connections), '/api/connections list should return an array');
  console.log(`Connections API returned ${Array.isArray(connections) ? connections.length : 0} connection(s).`);

  const connectionMap = new Map((Array.isArray(connections) ? connections : []).flatMap((connection) => [
    [connection.id, connection],
    [connection.name, connection],
    [connection.type, connection],
  ]));
  for (const expected of expectedConnections) {
    assert(connectionMap.has(expected), `Expected connection "${expected}" was not returned by /api/connections`);
  }

  const registry = await mcpRpc('/mcp/integrations', 'tools/call', {
    name: 'list_connected_integrations',
    arguments: {},
  }).then((r) => parseToolText(r.result));
  assert(Array.isArray(registry?.integrations), '/mcp/integrations list_connected_integrations should return integrations');

  const nativeServers = await mcpRpc('/mcp/integrations', 'tools/call', {
    name: 'list_mcp_servers',
    arguments: {},
  }).then((r) => parseToolText(r.result));
  const servers = Array.isArray(nativeServers?.servers) ? nativeServers.servers : [];
  console.log(`Registry returned ${servers.length} native MCP server(s).`);
  for (const expected of expectedNativeMcp) {
    assert(
      servers.some((server) => server.integration_id === expected || server.integration_name === expected || server.integration_type === expected),
      `Expected native MCP server "${expected}" was not returned by /mcp/integrations`
    );
  }

  for (const connection of Array.isArray(connections) ? connections : []) {
    if (!connection.nativeMcp) continue;
    try {
      const tools = await postJson('/api/connections', {
        action: 'tools',
        connection: connection.id,
      }).then((r) => r.payload);
      assert(Array.isArray(tools), `/api/connections tools for ${connectionKey(connection)} should return an array`);
      console.log(`- ${connectionKey(connection)}: ${Array.isArray(tools) ? tools.length : 0} tool(s) through /api/connections`);
    } catch (error) {
      failures.push(`/api/connections tools failed for ${connectionKey(connection)}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    try {
      const tools = await nativeTools(connection.id);
      assert(Array.isArray(tools), `native MCP tools/list for ${connectionKey(connection)} should return an array`);
      console.log(`  native MCP path returned ${Array.isArray(tools) ? tools.length : 0} tool(s).`);
    } catch (error) {
      failures.push(`native MCP tools/list failed for ${connectionKey(connection)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const call of safeCalls) {
    try {
      await postJson('/api/connections', {
        action: 'invoke',
        connection: call.connection,
        method: call.method,
        input: call.input,
      });
      console.log(`Safe call passed: ${call.connection}.${call.method}`);
    } catch (error) {
      failures.push(`Safe call failed for ${call.connection}.${call.method}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    console.error('\nConnections MCP smoke test failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log('\nConnections MCP smoke test passed.');
}

function parseToolText(result) {
  const text = result?.content?.find((part) => part?.type === 'text')?.text;
  if (typeof text !== 'string') return result;
  return parseJson(text);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
