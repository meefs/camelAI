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

function loadGeneratedVmFacade(): (tools: Record<string, (args: unknown) => unknown>) => {
  exec: (...args: unknown[]) => unknown;
} {
  const source = codeModeWorkerModule('');
  const start = source.indexOf('function createVmFacade(tools)');
  const end = source.indexOf('\n\nfunction createProjectsFacade', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const facadeSource = source.slice(start, end);
  return new Function(`${facadeSource}; return createVmFacade;`)() as (
    tools: Record<string, (args: unknown) => unknown>,
  ) => { exec: (...args: unknown[]) => unknown };
}

describe('code mode runner connection facade', () => {
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
    const createVmFacade = loadGeneratedVmFacade();
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

describe('code mode runner VM facade', () => {
  it('accepts both vm.exec(command, options) and vm.exec({ command, project })', async () => {
    const calls: unknown[] = [];
    const createVmFacade = loadGeneratedVmFacade();
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
});
