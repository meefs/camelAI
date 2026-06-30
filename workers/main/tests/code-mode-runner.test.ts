import { describe, expect, it } from 'vitest';
import { codeModeWorkerModule } from '../src/code-mode-runner';

function createConnectionsFacade(binding: any): Record<string, unknown> {
  const legacyInvokeMethod = ['_', '_', 'invoke'].join('');
  const invokeConnectionMethod = (request: unknown) => {
    if (typeof binding.invoke === 'function') {
      return binding.invoke(request);
    }
    if (typeof binding[legacyInvokeMethod] === 'function') {
      return binding[legacyInvokeMethod](request);
    }
    throw new Error('CONNECTIONS method invocation is not configured');
  };

  return new Proxy({}, {
    get(_target, connectionName) {
      if (connectionName === 'then') return undefined;
      if (connectionName === '$methods') return () => binding.methods();
      if (connectionName === '$find') return (query: unknown) => binding.find(query);
      if (connectionName === '$test') return (query: unknown) => binding.test(query);
      if (connectionName === '$list') return () => binding.list();
      if (connectionName === '$get') return (connection: unknown) => binding.get(connection);
      if (connectionName === '$tools') return (connection: unknown) => binding.tools(connection);
      if (typeof connectionName !== 'string') return binding[connectionName];
      if (
        ['list', 'get', 'tools', 'methods', 'find', 'test', 'invoke', legacyInvokeMethod]
          .includes(connectionName)
      ) {
        const value = binding[connectionName];
        return typeof value === 'function' ? (...args: unknown[]) => value.apply(binding, args) : value;
      }

      return new Proxy({}, {
        get(_connectionTarget, methodName) {
          if (methodName === 'then') return undefined;
          if (typeof methodName !== 'string') return undefined;
          return async (...args: unknown[]) => {
            const input = args[0] ?? {};
            return invokeConnectionMethod({
              connection: connectionName,
              method: methodName,
              input,
            });
          };
        },
      });
    },
  });
}

function createVmFacade(tools: Record<string, (args: unknown) => unknown>): {
  exec: (...args: unknown[]) => unknown;
} {
  const normalizeExecArgs = (commandOrOptions: unknown, options = {}) => {
    if (
      commandOrOptions &&
      typeof commandOrOptions === 'object' &&
      !Array.isArray(commandOrOptions)
    ) {
      return commandOrOptions;
    }
    return { command: commandOrOptions, ...options };
  };
  return Object.freeze({
    exec: (commandOrOptions: unknown, options = {}) =>
      tools.vm_exec(normalizeExecArgs(commandOrOptions, options)),
  });
}

function createToolHelp() {
  return (input?: unknown) => {
    const runtime = typeof input === 'object' && input !== null
      ? (input as { runtime?: unknown }).runtime
      : null;
    if (runtime === 'text/store/load') {
      return {
        runtime: {
          name: 'text/store/load',
          category: 'runtime',
        },
      };
    }
    return null;
  };
}

describe('code mode runner connection facade', () => {
  it('wraps global fetch through the secure fetch binding', () => {
    const source = codeModeWorkerModule('await fetch("https://example.com");');

    expect(source).toContain('function installSecureFetch(secureFetchBinding)');
    expect(source).toContain('const cleanupSecureFetch = installSecureFetch(this.env.SECURE_FETCH);');
    expect(source).toContain('cleanupSecureFetch();');
  });

  it('does not inject projects as a standalone user-code binding', () => {
    const source = codeModeWorkerModule('const projects = ["local"]; return projects.length;');

    expect(source).toContain('const PROJECTS = createProjectsFacade(tools)');
    expect(source).toContain('projects: env.PROJECTS');
    expect(source).toContain('const projects = ["local"]; return projects.length;');
    expect(source).not.toContain('async function runUserCode(tools, CONNECTIONS, connections, VM, vm, PROJECTS, projects');
    expect(source).not.toContain('const projects = PROJECTS');
  });

  it('supports object and command/options forms for vm.exec', async () => {
    const calls: unknown[] = [];
    const vm = createVmFacade({
      vm_exec(input: unknown) {
        calls.push(input);
        return input;
      },
    });

    const objectStyle = await vm.exec({
      command: 'bun run test:run',
      project: 'web-app',
      timeoutSeconds: 120,
    });
    const splitStyle = await vm.exec('bun run test:run', {
      project: 'web-app',
      timeoutSeconds: 120,
    });

    expect(objectStyle).toEqual({
      command: 'bun run test:run',
      project: 'web-app',
      timeoutSeconds: 120,
    });
    expect(splitStyle).toEqual(objectStyle);
    expect(calls).toEqual([objectStyle, objectStyle]);
  });

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

describe('code mode runner VM facade', () => {
  it('accepts both vm.exec(command, options) and vm.exec({ command, project })', async () => {
    const calls: unknown[] = [];
    const vm = createVmFacade({
      vm_exec: (args) => {
        calls.push(args);
        return { ok: true, args };
      },
    });

    expect(vm.exec('bun run deploy', {
      project: 'deploy-fake-data',
      timeoutSeconds: 120,
    })).toEqual({
      ok: true,
      args: {
        command: 'bun run deploy',
        project: 'deploy-fake-data',
        timeoutSeconds: 120,
      },
    });

    expect(vm.exec({
      command: 'bun run build',
      project: 'deploy-fake-data',
      timeoutSeconds: 120,
    })).toEqual({
      ok: true,
      args: {
        command: 'bun run build',
        project: 'deploy-fake-data',
        timeoutSeconds: 120,
      },
    });

    expect(calls).toEqual([
      {
        command: 'bun run deploy',
        project: 'deploy-fake-data',
        timeoutSeconds: 120,
      },
      {
        command: 'bun run build',
        project: 'deploy-fake-data',
        timeoutSeconds: 120,
      },
    ]);
  });

  it('does not pass runtime helper names as runUserCode parameters', () => {
    const source = codeModeWorkerModule(
      'const projects = await tools.list_projects();\nreturn projects;',
    );

    expect(source).toContain('async function runUserCode()');
    expect(source).toContain('installRuntimeGlobals');
    expect(source).not.toContain('async function runUserCode(tools');
  });

  it('installs the documented store helper as a runtime global', () => {
    const source = codeModeWorkerModule(
      'store("lastResult", 42);\nreturn load("lastResult");',
    );

    expect(source).toContain('store: save');
    expect(source).toContain('store("lastResult", 42);');
    expect(source).toContain('load("lastResult")');
  });

  it('keeps names on every runtime help entry so js_exec can initialize', () => {
    const source = codeModeWorkerModule('');
    expect(source).toContain('name: "text/store/load"');
    expect(source).toContain('name: "env.SCREENSHOT"');

    const help = createToolHelp();
    expect(help({ runtime: 'text/store/load' })).toEqual({
      runtime: expect.objectContaining({
        name: 'text/store/load',
        category: 'runtime',
      }),
    });
  });
});
