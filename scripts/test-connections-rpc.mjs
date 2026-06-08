#!/usr/bin/env node

const baseUrl = requiredEnv('CAMELAI_WORKER_URL').replace(/\/+$/, '');
const sandboxSecret = requiredEnv('SANDBOX_PROXY_SECRET');
const orgId = requiredEnv('CHIRIDION_ORG_ID');
const workspaceId = requiredEnv('CHIRIDION_WORKSPACE_ID');
const userId = process.env.CHIRIDION_USER_ID || 'connections-rpc-smoke';
const expectedConnections = csv(process.env.EXPECT_CONNECTIONS);
const safeCalls = parseSafeCalls(process.env.CONNECTION_RPC_SAFE_CALLS);

const headers = {
  'content-type': 'application/json',
  'x-sandbox-secret': sandboxSecret,
  'x-chiridion-org-id': orgId,
  'x-chiridion-workspace-id': workspaceId,
  'x-chiridion-user-id': userId,
  'x-chiridion-thread-id': process.env.CHIRIDION_THREAD_ID || 'connections-rpc-smoke',
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
      action: String(item.action || ''),
      params: item.params && typeof item.params === 'object' && !Array.isArray(item.params)
        ? item.params
        : {},
    })).filter((item) => item.action);
  } catch (error) {
    console.error(`Invalid CONNECTION_RPC_SAFE_CALLS JSON: ${error instanceof Error ? error.message : String(error)}`);
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

async function connectionsRpc(action, params = {}) {
  const { response, payload } = await postJson('/rpc/connections', { action, ...params }, {
    accept: 'application/json',
  });
  if (payload?.error) {
    throw new Error(`/rpc/connections ${action} returned error: ${JSON.stringify(payload.error)}`);
  }
  return { response, result: payload?.result ?? payload };
}

async function main() {
  console.log(`Testing connections RPC for workspace ${workspaceId} at ${baseUrl}`);

  const methods = await connectionsRpc('methods').then((r) => r.result || []);
  assert(Array.isArray(methods), '/rpc/connections methods should return an array');
  console.log(`Connections RPC returned ${Array.isArray(methods) ? methods.length : 0} connection method catalog entries.`);

  const listed = await connectionsRpc('list').then((r) => r.result);
  assert(Array.isArray(listed), 'list should return an array');
  for (const expected of expectedConnections) {
    assert(
      listed.some((connection) => connection?.id === expected || connection?.name === expected || connection?.type === expected),
      `Expected connection "${expected}" was not returned by list`
    );
  }

  for (const call of safeCalls) {
    try {
      await connectionsRpc(call.action, call.params);
      console.log(`Safe call passed: ${call.action}`);
    } catch (error) {
      failures.push(`Safe call failed for ${call.action}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    console.error('\nConnections RPC smoke test failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log('\nConnections RPC smoke test passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
