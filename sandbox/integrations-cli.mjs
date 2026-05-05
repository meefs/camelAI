#!/usr/bin/env node

const serverBase = (process.env.MCP_SERVER_URL || '').replace(/\/+$/, '');
const endpoint = serverBase ? `${serverBase}/integrations` : '';

function usage() {
  console.log(`Usage:
  camelai-integrations list [--json]
  camelai-integrations get <id|name|type> [--json]
  camelai-integrations mcp list [--json]
  camelai-integrations mcp get <id|name|type> [--json]
  camelai-integrations <id|name|type> list_tools [--json]
  camelai-integrations <id|name|type> call_tool <tool-name> [json-args]
  camelai-integrations types [--json]
  camelai-integrations tools [--json]
  camelai-integrations call <tool-name> [json-args]

Environment:
  MCP_SERVER_URL must point at the camelAI MCP proxy, usually set automatically.`);
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function stripFlags(args) {
  return args.filter((arg) => !arg.startsWith('--'));
}

async function rpc(method, params = {}) {
  if (!endpoint) {
    throw new Error('MCP_SERVER_URL is not set');
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with HTTP ${response.status}`);
  }
  if (payload?.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error));
  }
  return payload?.result;
}

function parseToolJson(result) {
  const text = result?.content?.find((part) => part?.type === 'text')?.text;
  if (typeof text !== 'string') return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callTool(name, args = {}) {
  return parseToolJson(await rpc('tools/call', { name, arguments: args }));
}

function parseNativePayload(text) {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .filter(Boolean);
    if (dataLines.length > 0) {
      return JSON.parse(dataLines.join('\n'));
    }
    return { raw: text };
  }
}

async function nativeHttp(integration, method, params = {}, sessionId) {
  if (!endpoint) {
    throw new Error('MCP_SERVER_URL is not set');
  }
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const response = await fetch(`${endpoint}/native/${encodeURIComponent(integration)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  });
  const text = await response.text();
  const payload = parseNativePayload(text);
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || `Native MCP request failed with HTTP ${response.status}`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  if (payload?.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error));
  }
  return {
    result: payload?.result ?? payload,
    sessionId: response.headers.get('mcp-session-id') || sessionId,
  };
}

async function nativeSession(integration) {
  const initialized = await nativeHttp(integration, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: {
      name: 'camelai-integrations-cli',
      version: '1.0.0',
    },
  });
  return initialized.sessionId;
}

async function nativeRpc(integration, method, params = {}) {
  const sessionId = await nativeSession(integration);
  const response = await nativeHttp(integration, method, params, sessionId);
  return response.result;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printList(payload) {
  const integrations = payload.integrations || [];
  if (integrations.length === 0) {
    console.log('No connected integrations.');
    return;
  }

  const rows = integrations.map((integration) => ({
    type: integration.type,
    name: integration.name,
    id: integration.id,
    credentials: integration.has_credentials ? 'yes' : 'no',
  }));
  const widths = {
    type: Math.max('TYPE'.length, ...rows.map((row) => row.type.length)),
    name: Math.max('NAME'.length, ...rows.map((row) => row.name.length)),
    credentials: 'CREDENTIALS'.length,
  };
  console.log(
    `${'TYPE'.padEnd(widths.type)}  ${'NAME'.padEnd(widths.name)}  ${'CREDENTIALS'.padEnd(widths.credentials)}  ID`
  );
  for (const row of rows) {
    console.log(
      `${row.type.padEnd(widths.type)}  ${row.name.padEnd(widths.name)}  ${row.credentials.padEnd(widths.credentials)}  ${row.id}`
    );
  }
}

function printMcpList(payload) {
  const servers = payload.servers || [];
  if (servers.length === 0) {
    console.log('No native MCP servers are available for connected integrations.');
    return;
  }
  const rows = servers.map((server) => ({
    name: server.server_name,
    integration: `${server.integration_type}/${server.integration_name}`,
    auth: server.auth_strategy,
    connect: server.direct_connect ? 'direct' : 'broker',
    url: server.url,
  }));
  const widths = {
    name: Math.max('SERVER'.length, ...rows.map((row) => row.name.length)),
    integration: Math.max('INTEGRATION'.length, ...rows.map((row) => row.integration.length)),
    auth: Math.max('AUTH'.length, ...rows.map((row) => row.auth.length)),
    connect: 'CONNECT'.length,
  };
  console.log(
    `${'SERVER'.padEnd(widths.name)}  ${'INTEGRATION'.padEnd(widths.integration)}  ${'AUTH'.padEnd(widths.auth)}  ${'CONNECT'.padEnd(widths.connect)}  URL`
  );
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(widths.name)}  ${row.integration.padEnd(widths.integration)}  ${row.auth.padEnd(widths.auth)}  ${row.connect.padEnd(widths.connect)}  ${row.url}`
    );
  }
}

function printIntegration(payload) {
  if (!payload.found) {
    console.error(payload.error || 'Integration not found');
    if (payload.matches?.length) {
      console.error('Matching integrations:');
      for (const item of payload.matches) {
        console.error(`- ${item.type} / ${item.name} (${item.id})`);
      }
    }
    if (payload.available?.length) {
      console.error('Available integrations:');
      for (const item of payload.available) {
        console.error(`- ${item.type} / ${item.name} (${item.id})`);
      }
    }
    process.exitCode = 1;
    return;
  }
  printJson(payload.integration);
}

async function main() {
  const args = stripFlags(process.argv.slice(2));
  const command = args[0] || 'help';
  const json = hasFlag('--json');

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      usage();
      return;

    case 'list': {
      const payload = await callTool('list_connected_integrations');
      json ? printJson(payload) : printList(payload);
      return;
    }

    case 'get': {
      const integration = args[1];
      if (!integration) throw new Error('get requires an integration id, name, or type');
      const payload = await callTool('get_connected_integration', { integration });
      json ? printJson(payload) : printIntegration(payload);
      return;
    }

    case 'mcp': {
      const subcommand = args[1] || 'list';
      if (subcommand === 'list') {
        const payload = await callTool('list_mcp_servers');
        json ? printJson(payload) : printMcpList(payload);
        return;
      }
      if (subcommand === 'get') {
        const integration = args[2];
        if (!integration) throw new Error('mcp get requires an integration id, name, or type');
        const payload = await callTool('get_mcp_server', { integration });
        printJson(payload);
        return;
      }
      throw new Error(`Unknown mcp command: ${subcommand}`);
    }

    case 'types': {
      const payload = await callTool('list_available_integration_types');
      printJson(payload);
      return;
    }

    case 'tools': {
      const payload = await rpc('tools/list');
      json ? printJson(payload) : printJson(payload.tools?.map((tool) => tool.name) || []);
      return;
    }

    case 'call': {
      const toolName = args[1];
      if (!toolName) throw new Error('call requires a tool name');
      const toolArgs = args[2] ? JSON.parse(args[2]) : {};
      printJson(await callTool(toolName, toolArgs));
      return;
    }

    default:
      await handleIntegrationMcpCommand(args, json);
      return;
  }
}

async function handleIntegrationMcpCommand(args, json) {
  const integration = args[0];
  const subcommand = args[1];
  if (!integration || !subcommand) {
    throw new Error(`Unknown command: ${integration || ''}`);
  }

  if (subcommand === 'list_tools') {
    const result = await nativeRpc(integration, 'tools/list');
    json ? printJson(result) : printJson((result.tools || []).map((tool) => tool.name));
    return;
  }

  if (subcommand === 'call_tool') {
    const toolName = args[2];
    if (!toolName) throw new Error(`${integration} call_tool requires a tool name`);
    const toolArgs = args[3] ? JSON.parse(args[3]) : {};
    printJson(await nativeRpc(integration, 'tools/call', { name: toolName, arguments: toolArgs }));
    return;
  }

  if (subcommand === 'info') {
    printJson(await callTool('get_mcp_server', { integration }));
    return;
  }

  throw new Error(`Unknown integration MCP command: ${integration} ${subcommand}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
