import { describe, expect, it } from 'vitest';
import { codeModeWorkerModule } from '../src/code-mode-runner';

function loadGeneratedConnectionsFacade(): (binding: unknown) => Record<string, unknown> {
  const source = codeModeWorkerModule('');
  const start = source.indexOf('function createConnectionsFacade(binding)');
  const end = source.indexOf('\n\nasync function runUserCode', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const facadeSource = source.slice(start, end);
  return new Function(`${facadeSource}; return createConnectionsFacade;`)() as (
    binding: unknown,
  ) => Record<string, unknown>;
}

describe('code mode runner connection facade', () => {
  it('supports workflow-style connection method calls in js_exec', async () => {
    const calls: unknown[] = [];
    const connectionsBinding = {
      list: async () => [],
      get: async () => ({ alias: 'remoteMcpAdmin' }),
      tools: async () => [],
      methods: async () => [{ alias: 'remoteMcpAdmin', method: 'getDashboardSummary' }],
      find: async () => ({ alias: 'remoteMcpAdmin' }),
      test: async () => ({ ok: true }),
      invoke(request: unknown) {
        calls.push(request);
        return { ok: true, request };
      },
    };
    const createConnectionsFacade = loadGeneratedConnectionsFacade();
    const env = { CONNECTIONS: createConnectionsFacade(connectionsBinding) as any };
    const connections = env.CONNECTIONS;
    const context = { cloudflare: { env, connections } };

    const admin = await env.CONNECTIONS.find('admin');
    const workflowStyle = await env.CONNECTIONS[admin.alias].getDashboardSummary({
      date: '2026-05-29',
    });
    const facadeStyle = await connections[admin.alias].getDashboardSummary({
      date: '2026-05-29',
    });
    const contextStyle = await context.cloudflare.connections[admin.alias].getDashboardSummary({
      date: '2026-05-29',
    });

    expect({ workflowStyle, facadeStyle, contextStyle }).toEqual({
      workflowStyle: {
        ok: true,
        request: {
          connection: 'remoteMcpAdmin',
          method: 'getDashboardSummary',
          input: { date: '2026-05-29' },
        },
      },
      facadeStyle: {
        ok: true,
        request: {
          connection: 'remoteMcpAdmin',
          method: 'getDashboardSummary',
          input: { date: '2026-05-29' },
        },
      },
      contextStyle: {
        ok: true,
        request: {
          connection: 'remoteMcpAdmin',
          method: 'getDashboardSummary',
          input: { date: '2026-05-29' },
        },
      },
    });
    expect(calls).toHaveLength(3);
  });

  it('does not detach service binding methods when invoking a connection method', () => {
    const source = codeModeWorkerModule(
      'return await connections.remoteMcpAdmin.getDashboardSummary({ date: "2026-05-29" });',
    );

    expect(source).toContain('createToolBackedConnectionsBinding');
    expect(source).toContain('const CONNECTIONS_BINDING = createToolBackedConnectionsBinding(callTool)');
    expect(source).toContain('const CONNECTIONS = connections');
    expect(source).toContain('return binding.invoke(request);');
    expect(source).toContain('invoke: (request) => callTool("connections_invoke", request)');
    expect(source).not.toContain('invoke.call(binding');
  });
});
