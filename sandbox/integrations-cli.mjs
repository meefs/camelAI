#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const serverBase = (process.env.MCP_SERVER_URL || '').replace(/\/+$/, '');
const endpoint = serverBase ? `${serverBase}/integrations` : '';
const explicitConnectionsEndpoint = (process.env.CAMELAI_CONNECTIONS_URL || '').replace(/\/+$/, '');
const connectionsEndpoint = explicitConnectionsEndpoint || (serverBase ? `${serverBase.replace(/\/mcp$/, '')}/api/connections` : '');
const cliName = basename(process.argv[1] || 'camelai-integrations');
const isConnectionsCli = cliName === 'camelai-connections' || cliName === 'connections';

function usage() {
  if (isConnectionsCli) {
    console.log(`Usage:
  camelai-connections list [--json]
  camelai-connections get <id|name|type> [--json]
  camelai-connections tools <id|name|type> [--json]
  camelai-connections call <id|name|type> <tool-name> [json-args]
  camelai-connections types [--write-types] [--out=path]

Environment:
  CAMELAI_CONNECTIONS_URL points at the camelAI connections proxy, usually set automatically.`);
    return;
  }

  console.log(`Usage:
  camelai-integrations list [--json]
  camelai-integrations get <id|name|type> [--json]
  camelai-integrations mcp list [--json]
  camelai-integrations mcp get <id|name|type> [--json]
  camelai-integrations <id|name|type> list_tools [--json]
  camelai-integrations <id|name|type> call_tool <tool-name> [json-args]
  camelai-integrations connections list [--json]
  camelai-integrations connections get <id|name|type> [--json]
  camelai-integrations connections tools <id|name|type> [--json]
  camelai-integrations connections call <id|name|type> <tool-name> [json-args]
  camelai-integrations connections types [--write-types] [--out=path]
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

function flagValue(prefix, fallback) {
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return fallback;
  const value = arg.slice(prefix.length);
  return value || fallback;
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

async function connectionsRequest(action, payload = {}) {
  if (!connectionsEndpoint) {
    throw new Error('CAMELAI_CONNECTIONS_URL is not set');
  }

  const response = await fetch(connectionsEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Connections request failed with HTTP ${response.status}`);
  }
  return body;
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

function printConnections(connections) {
  if (!Array.isArray(connections) || connections.length === 0) {
    console.log('No connected integrations.');
    return;
  }

  const rows = connections.map((connection) => ({
    type: connection.type,
    name: connection.name,
    id: connection.id,
    tools: connection.nativeMcp ? 'mcp' : '-',
  }));
  const widths = {
    type: Math.max('TYPE'.length, ...rows.map((row) => row.type.length)),
    name: Math.max('NAME'.length, ...rows.map((row) => row.name.length)),
    tools: 'TOOLS'.length,
  };
  console.log(
    `${'TYPE'.padEnd(widths.type)}  ${'NAME'.padEnd(widths.name)}  ${'TOOLS'.padEnd(widths.tools)}  ID`
  );
  for (const row of rows) {
    console.log(
      `${row.type.padEnd(widths.type)}  ${row.name.padEnd(widths.name)}  ${row.tools.padEnd(widths.tools)}  ${row.id}`
    );
  }
}

function printConnectionTools(tools) {
  const names = Array.isArray(tools) ? tools.map((tool) => tool?.name).filter(Boolean) : [];
  printJson(names);
}

function toIdentifier(value, fallback = 'value') {
  const words = String(value || '')
    .replace(/['"]/g, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return fallback;
  const [first, ...rest] = words;
  const identifier = `${first.toLowerCase()}${rest.map((word) => `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`).join('')}`;
  return /^[a-zA-Z_$]/.test(identifier) ? identifier : `${fallback}${identifier}`;
}

function literal(value) {
  return JSON.stringify(value);
}

function schemaToTs(schema, fallback = 'unknown') {
  if (!schema || typeof schema !== 'object') return fallback;
  if (schema.const !== undefined) return literal(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((value) => literal(value)).join(' | ');
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((item) => schemaToTs(item, fallback)).join(' | ');
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((item) => schemaToTs(item, fallback)).join(' | ');
  }
  const type = Array.isArray(schema.type) ? schema.type.filter((item) => item !== 'null')[0] : schema.type;
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return `${schemaToTs(schema.items, 'unknown')}[]`;
    case 'object': {
      const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
      const entries = Object.entries(properties);
      if (entries.length === 0) {
        return 'Record<string, unknown>';
      }
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const lines = entries.map(([key, value]) => {
        const optional = required.has(key) ? '' : '?';
        return `  ${JSON.stringify(key)}${optional}: ${schemaToTs(value, 'unknown')};`;
      });
      return `{\n${lines.join('\n')}\n}`;
    }
    default:
      if (schema.properties && typeof schema.properties === 'object') {
        return schemaToTs({ ...schema, type: 'object' }, fallback);
      }
      return fallback;
  }
}

function toolInputType(tool) {
  return schemaToTs(tool?.inputSchema || tool?.input_schema, 'Record<string, unknown>');
}

function toolResultType() {
  return 'unknown';
}

function connectionAlias(connection, used) {
  const base = toIdentifier(`${connection.type}_${connection.name}`, 'connection');
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

async function collectConnectionTypeData(connectionQuery) {
  const connections = await connectionsRequest('list');
  const selected = connectionQuery
    ? [await connectionsRequest('get', { connection: connectionQuery })]
    : connections;
  const entries = [];
  for (const connection of selected) {
    let tools = [];
    if (connection.nativeMcp) {
      tools = await connectionsRequest('tools', { connection: connection.id });
    }
    entries.push({ connection, tools });
  }
  return entries;
}

function generateConnectionsTypes(entries) {
  const usedAliases = new Set();
  const aliasEntries = entries.map(({ connection, tools }) => ({
    connection,
    tools,
    alias: connectionAlias(connection, usedAliases),
  }));

  const connectionToolsLines = aliasEntries.map(({ connection, tools }) => {
    const toolLines = tools.map((tool) => {
      const name = String(tool?.name || '');
      return `    ${literal(name)}: { input: ${toolInputType(tool)}; output: ${toolResultType(tool)} };`;
    });
    return `  ${literal(connection.id)}: {\n${toolLines.join('\n')}\n  };`;
  });

  const facadeLines = aliasEntries.map(({ connection, tools, alias }) => {
    const methodLines = tools.map((tool) => {
      const toolName = String(tool?.name || '');
      const methodName = toIdentifier(toolName, 'tool');
      return `      ${methodName}(input: ToolInput<${literal(connection.id)}, ${literal(toolName)}>) {\n        return binding.call<ToolOutput<${literal(connection.id)}, ${literal(toolName)}>>(${literal(connection.id)}, ${literal(toolName)}, input as Record<string, unknown>);\n      },`;
    });
    return `    ${alias}: {\n${methodLines.join('\n')}\n    },`;
  });

  return `/* eslint-disable */
// Generated by camelai-connections. Re-run \`camelai-connections types --write-types\` after changing workspace connections.

export interface ConnectionSummary {
  id: string;
  type: string;
  name: string;
  displayName: string;
  category: string;
  authMethod: string;
  hasCredentials: boolean;
  capabilities: string[];
  nativeMcp: {
    serverName: string;
    transport: "streamable_http";
    directConnect: false;
  } | null;
}

export interface McpToolSummary {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface ConnectionsBinding {
  list(): Promise<ConnectionSummary[]>;
  get(connection: string): Promise<ConnectionSummary>;
  tools(connection: string): Promise<McpToolSummary[]>;
  call<T = unknown>(connection: string, tool: string, input?: Record<string, unknown>): Promise<T>;
}

export type ConnectionTools = {
${connectionToolsLines.join('\n')}
};

type ToolInput<
  C extends keyof ConnectionTools,
  T extends keyof ConnectionTools[C],
> = ConnectionTools[C][T] extends { input: infer I } ? I : never;

type ToolOutput<
  C extends keyof ConnectionTools,
  T extends keyof ConnectionTools[C],
> = ConnectionTools[C][T] extends { output: infer O } ? O : never;

export function createConnections(env: { CONNECTIONS: ConnectionsBinding }) {
  const binding = env.CONNECTIONS;
  return {
    list: () => binding.list(),
    get: (connection: string) => binding.get(connection),
    tools: (connection: string) => binding.tools(connection),
    call: <
      C extends keyof ConnectionTools & string,
      T extends keyof ConnectionTools[C] & string,
    >(connection: C, tool: T, input: ToolInput<C, T>) =>
      binding.call<ToolOutput<C, T>>(connection, tool, input as Record<string, unknown>),
${facadeLines.join('\n')}
  };
}
`;
}

async function writeConnectionTypes(connectionQuery) {
  const outPath = resolve(flagValue('--out=', '.camelai/connections.ts'));
  const source = generateConnectionsTypes(await collectConnectionTypeData(connectionQuery));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, source);
  return outPath;
}

async function main() {
  const args = stripFlags(process.argv.slice(2));
  const command = args[0] || 'help';
  const json = hasFlag('--json');
  const writeTypes = hasFlag('--write-types');

  if (isConnectionsCli) {
    await handleConnectionsCommand(args, json, writeTypes);
    return;
  }

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

    case 'connections':
      await handleConnectionsCommand(args.slice(1), json, writeTypes);
      return;

    default:
      await handleIntegrationMcpCommand(args, json);
      return;
  }
}

async function handleConnectionsCommand(args, json, writeTypes) {
  const command = args[0] || 'help';

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      usage();
      return;

    case 'list': {
      const payload = await connectionsRequest('list');
      json ? printJson(payload) : printConnections(payload);
      return;
    }

    case 'get': {
      const connection = args[1];
      if (!connection) throw new Error('get requires a connection id, name, or type');
      const payload = await connectionsRequest('get', { connection });
      printJson(payload);
      return;
    }

    case 'tools': {
      const connection = args[1];
      if (writeTypes) {
        const outPath = await writeConnectionTypes(connection);
        console.log(`Wrote ${outPath}`);
        return;
      }
      if (!connection) throw new Error('tools requires a connection id, name, or type');
      const payload = await connectionsRequest('tools', { connection });
      json ? printJson(payload) : printConnectionTools(payload);
      return;
    }

    case 'types': {
      if (writeTypes) {
        const outPath = await writeConnectionTypes(args[1]);
        console.log(`Wrote ${outPath}`);
        return;
      }
      printJson(generateConnectionsTypes(await collectConnectionTypeData(args[1])));
      return;
    }

    case 'call': {
      const connection = args[1];
      const toolName = args[2];
      if (!connection || !toolName) throw new Error('call requires a connection and tool name');
      const input = args[3] ? JSON.parse(args[3]) : {};
      printJson(await connectionsRequest('call', { connection, tool: toolName, input }));
      return;
    }

    default:
      throw new Error(`Unknown connections command: ${command}`);
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
