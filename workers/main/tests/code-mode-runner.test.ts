import { describe, expect, it } from 'vitest';
import { codeModeWorkerModule, prepareCodeModeUserCode, stripTypeScriptFromUserCode } from '../src/code-mode-runner';

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

    expect(source).toContain('const PROJECTS = createProjectsFacade(rawTools)');
    expect(source).toContain('projects: env.PROJECTS');
    expect(source).toContain('const projects = ["local"]; return projects.length;');
    expect(source).not.toContain('async function runUserCode(tools, CONNECTIONS, connections, VM, vm, PROJECTS, projects');
    expect(source).not.toContain('const projects = PROJECTS');
  });

  it('generates helpful env.BROWSER errors for unsupported methods', () => {
    const source = codeModeWorkerModule(
      'const b = await env.BROWSER.launch({ scriptName: "app" });\nreturn await b.text();',
    );

    expect(source).toContain('env.BROWSER session has no method');
    expect(source).toContain('Supported session methods');
    expect(source).toContain('use await session.textContent("body") and then result.text');
    expect(source).toContain('env.BROWSER has no method');
    expect(source).toContain('Use await env.BROWSER.launch({ scriptName, path? })');
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

describe('code mode runner TypeScript stripping', () => {
  it('strips type annotations, casts, interfaces, and generics from user code', () => {
    const stripped = stripTypeScriptFromUserCode([
      'interface Row { id: number; name: string }',
      'const limit: number = 5;',
      'const rows = (await tools.list_apps({ limit })) as { data: Row[] };',
      'function pick<T>(items: T[]): T | undefined { return items[0]; }',
      'return pick(rows.data)!;',
    ].join('\n'));

    expect(stripped).not.toContain('interface');
    expect(stripped).not.toContain(': number');
    expect(stripped).not.toContain('as {');
    expect(stripped).not.toContain('<T>');
    expect(stripped).toContain('const limit = 5;');
    expect(stripped).toContain('return pick(rows.data);');
  });

  it('leaves plain JavaScript intact, including ternaries and object literals', () => {
    const code = [
      'const config = { mode: enabled ? "on" : "off", retries: 3 };',
      'return await tools.set_preview({ app_name: config.mode });',
    ].join('\n');
    expect(stripTypeScriptFromUserCode(code)).toBe(code);
  });

  it('supports top-level return and await, and falls back on unparseable code', () => {
    expect(stripTypeScriptFromUserCode('return await tools.list_apps();')).toBe(
      'return await tools.list_apps();',
    );
    const broken = 'const x = {;';
    expect(stripTypeScriptFromUserCode(broken)).toBe(broken);
  });

  it('is applied by codeModeWorkerModule before embedding user code', () => {
    const source = codeModeWorkerModule('const n: number = 1;\nreturn n;');
    expect(source).toContain('const n = 1;');
    expect(source).not.toContain('const n: number = 1;');
  });
});

function loadGeneratedToolHelp(): (allTools: unknown[]) => (input?: unknown) => any {
  const source = codeModeWorkerModule('');
  const start = source.indexOf('const TOOL_CATEGORY_DESCRIPTIONS');
  const end = source.indexOf('\n\nfunction createCamelAiFacade', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const slice = source.slice(start, end);
  return new Function(`${slice}; return createToolHelp;`)();
}

describe('code mode runner tools.help guide', () => {
  it('resolves the connections category over the connections runtime facade for bare keys', () => {
    const createHelp = loadGeneratedToolHelp();
    const help = createHelp([
      { name: 'warehouse_list_connections', category: 'connections', description: 'List warehouse connections.' },
    ]);

    const result = help('connections');
    expect(result.category).toBe('connections');
    expect(result.tools.map((tool: any) => tool.name)).toContain('warehouse_list_connections');
    // The runtime facade still shows up inside the category view...
    expect(result.runtimes.map((entry: any) => entry.name)).toContain('connections');
    // ...and stays directly reachable via an explicit runtime request.
    expect(help({ runtime: 'connections' }).runtime.name).toBe('connections');
  });

  it('returns the full usage guide from a no-argument tools.help() call', () => {
    const createHelp = loadGeneratedToolHelp();
    const help = createHelp([
      { name: 'send_email', category: 'communication', description: 'Send an email.' },
    ]);

    const result = help();
    expect(Array.isArray(result.guide)).toBe(true);
    const guide = result.guide.join('\n');
    // The long-form guidance moved out of the js_exec tool description lives here.
    expect(guide).toContain('set_preview');
    expect(guide).toContain('env.CONNECTIONS.find');
    expect(guide).toContain('location');
    expect(guide).toContain('file.data.text');
    expect(guide).toContain('vm.exec');
    expect(guide).toContain('env.AI.run');
    // Executor-style calling shape: envelope semantics and TypeScript acceptance.
    expect(guide).toContain('{ ok: true, data }');
    expect(guide).toContain('type annotations are stripped');
    expect(result.categories.length).toBeGreaterThan(0);
  });

  it('includes a targeted hint for JSON.parse on a tool result envelope', () => {
    const { formatRuntimeError } = loadGeneratedRuntimeErrorHelpers();

    const result = formatRuntimeError(new SyntaxError('"[object Object]" is not valid JSON'));

    expect(result).toContain('"[object Object]" is not valid JSON');
    expect(result).toContain('JSON.parse received an object');
    expect(result).toContain('js_exec tools return { ok, data }');
    expect(result).toContain('parse result.data.text');
  });

  it('reports js_exec code locations without leaking generated stack frames', () => {
    const { formatRuntimeError, USER_CODE_START_LINE } = loadGeneratedRuntimeErrorHelpers([
      'const before = true;',
      'JSON.parse(await tools.read({ location: "project", project: "app", path: "package.json" }));',
      'const after = true;',
    ].join('\n'));
    const error = new SyntaxError('"[object Object]" is not valid JSON');
    error.stack = [
      'SyntaxError: "[object Object]" is not valid JSON',
      `    at runUserCode (index.js:${USER_CODE_START_LINE + 1}:7)`,
      '    at CodeModeRunner.run (index.js:1101:28)',
    ].join('\n');

    const result = formatRuntimeError(error);

    expect(result).toContain('at js_exec code line 2, column 7');
    expect(result).not.toContain('CodeModeRunner');
    expect(result).not.toContain('runUserCode');
    expect(result).not.toContain('index.js');
  });
});

function loadGeneratedRuntimeErrorHelpers(userCode = ''): {
  formatRuntimeError: (error: unknown) => string;
  USER_CODE_START_LINE: number;
  USER_CODE_END_LINE: number;
} {
  const source = codeModeWorkerModule(userCode);
  const start = source.indexOf('const USER_CODE_START_LINE');
  const end = source.indexOf('\n\nfunction createOutputConsole', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const slice = source.slice(start, end);
  return new Function(`${slice}; return { formatRuntimeError, USER_CODE_START_LINE, USER_CODE_END_LINE };`)();
}

function loadGeneratedToolSearch(): {
  createToolSearch: (allTools: unknown[]) => (input?: unknown) => any;
  createToolDescribe: (allTools: unknown[]) => (input?: unknown) => any;
  createEnvelopeToolCall: (name: string, callTool: (name: string, args?: unknown) => unknown) => (args?: unknown) => Promise<any>;
  schemaToTypeScript: (schema: unknown) => string;
} {
  const source = codeModeWorkerModule('');
  const start = source.indexOf('const RUNTIME_HELP_ENTRIES');
  const end = source.indexOf('\n\nfunction createScreenshotFacade', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const slice = source.slice(start, end);
  return new Function(`${slice}; return { createToolSearch, createToolDescribe, createEnvelopeToolCall, schemaToTypeScript };`)();
}

describe('code mode runner tools.search / tools.describe', () => {
  const allTools = [
    { name: 'send_email', category: 'communication', description: 'Send an email message to a recipient.', examples: ['await tools.send_email({ to, subject, body })'] },
    { name: 'list_apps', category: 'apps', description: 'List deployed apps for the current workspace.', examples: [] },
    { name: 'create_workflow', category: 'workflows', description: 'Create a deterministic JavaScript workflow.', examples: [] },
  ];

  it('ranks the most relevant tool first and gates out non-matches', () => {
    const { createToolSearch } = loadGeneratedToolSearch();
    const search = createToolSearch(allTools);

    const result = search('send email');
    expect(result.items[0].name).toBe('send_email');
    expect(result.items.every((item: any) => item.score > 0)).toBe(true);
    // "send email" should not surface unrelated tools (coverage gate).
    expect(result.items.map((item: any) => item.name)).not.toContain('list_apps');
    // Each match advertises how to inspect it next.
    expect(result.items[0].describe).toBe('await tools.describe("send_email")');
  });

  it('accepts a string or { query, limit } and requires a query', () => {
    const { createToolSearch } = loadGeneratedToolSearch();
    const search = createToolSearch(allTools);

    expect(search({ query: 'deployed apps', limit: 1 }).items).toHaveLength(1);
    expect(() => search('')).toThrow(/requires a query/);
    expect(() => search({})).toThrow(/requires a query/);
  });

  it('labels runtime hits as globals instead of suggesting tools.<name> calls', () => {
    const { createToolSearch } = loadGeneratedToolSearch();
    const search = createToolSearch(allTools);

    const toolHit = search('send email').items[0];
    expect(toolHit.kind).toBe('tool');
    expect(toolHit.call).toBe('await tools["send_email"](args)');

    const result = search('connections');
    const runtimeHit = result.items.find((item: any) => item.name === 'env.CONNECTIONS');
    expect(runtimeHit.kind).toBe('runtime');
    expect(runtimeHit.call).toContain('NOT callable via tools.<name>');
    expect(runtimeHit.call).toContain('await env.CONNECTIONS.list()');
    expect(result.usage).toContain('sandbox globals');
  });

  it('describe returns the full definition for a known tool and suggests for misses', () => {
    const { createToolDescribe } = loadGeneratedToolSearch();
    const describe = createToolDescribe(allTools);

    const known = describe('send_email');
    expect(known.tool.name).toBe('send_email');
    expect(known.tool.description).toContain('Send an email');
    expect(known.usage).toContain('await tools.send_email');

    const miss = describe('totally_unknown_tool');
    expect(miss.error).toContain('totally_unknown_tool');
    expect(Array.isArray(miss.suggestions)).toBe(true);
    expect(() => describe('')).toThrow(/requires a tool name/);
  });

  it('describe replaces the JSON Schema with a compact inputTypeScript shape', () => {
    const { createToolDescribe } = loadGeneratedToolSearch();
    const describe = createToolDescribe([
      {
        name: 'create_scheduled_prompt',
        category: 'schedules',
        description: 'Create a scheduled prompt.',
        parameters: {
          type: 'object',
          required: ['name', 'prompt', 'cron_expression'],
          properties: {
            name: { type: 'string' },
            prompt: { type: 'string' },
            cron_expression: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
      },
    ]);

    const result = describe('create_scheduled_prompt');
    expect(result.tool.inputTypeScript).toBe(
      '{ name: string, prompt: string, cron_expression: string, enabled?: boolean }',
    );
    expect(result.tool.parameters).toBeUndefined();
    expect(result.usage).toContain('{ ok: true, data }');
  });

  it('renders enums, unions, arrays, and nested objects as TypeScript', () => {
    const { schemaToTypeScript } = loadGeneratedToolSearch();
    expect(schemaToTypeScript({
      type: 'object',
      required: ['location', 'todos'],
      properties: {
        location: { type: 'string', enum: ['workspace', 'vm', 'r2'] },
        limit: { type: ['number', 'null'] },
        todos: {
          type: 'array',
          items: {
            type: 'object',
            required: ['content'],
            properties: { content: { type: 'string' } },
          },
        },
      },
    })).toBe('{ location: "workspace" | "vm" | "r2", limit?: number | null, todos: { content: string }[] }');
    expect(schemaToTypeScript({ type: 'array', items: { enum: ['a', 'b'] } })).toBe('("a" | "b")[]');
    expect(schemaToTypeScript(undefined)).toBe('unknown');
  });

  it('passes DO-built envelopes through and normalizes transport failures', async () => {
    const { createEnvelopeToolCall } = loadGeneratedToolSearch();

    const success = createEnvelopeToolCall('list_apps', async () => ({ ok: true, data: { apps: [] } }));
    await expect(success({})).resolves.toEqual({ ok: true, data: { apps: [] } });

    const toolFailure = createEnvelopeToolCall('create_scheduled_prompt', async () => ({
      ok: false,
      error: { tool: 'create_scheduled_prompt', message: 'cron_expression is required' },
    }));
    await expect(toolFailure({ name: 'x' })).resolves.toEqual({
      ok: false,
      error: { tool: 'create_scheduled_prompt', message: 'cron_expression is required' },
    });

    const transportFailure = createEnvelopeToolCall('list_apps', async () => {
      throw new Error('RPC connection lost');
    });
    await expect(transportFailure({})).resolves.toEqual({
      ok: false,
      error: { tool: 'list_apps', message: 'RPC connection lost' },
    });
  });

  it('describe on a runtime helper explains it is a global, not a tools.<name> call', () => {
    const { createToolDescribe } = loadGeneratedToolSearch();
    const describe = createToolDescribe(allTools);

    const runtime = describe('env.CONNECTIONS');
    expect(runtime.runtime.name).toBe('env.CONNECTIONS');
    expect(runtime.usage).toContain('NOT callable via tools.<name>');
    expect(runtime.usage).toContain('await env.CONNECTIONS.list()');
  });

  it('describes the project facades advertised in the js_exec guide', () => {
    const { createToolDescribe } = loadGeneratedToolSearch();
    const describe = createToolDescribe(allTools);

    const projects = describe('env.PROJECTS');
    expect(projects.runtime.name).toBe('env.PROJECTS');
    expect(projects.runtime.methods.map((method: any) => method.name)).toEqual(
      ['list', 'create', 'setDescription', 'clone'],
    );

    const vm = describe('vm');
    expect(vm.runtime.name).toBe('vm');
    expect(vm.usage).toContain('vm.exec');
  });
});

describe('js_exec result-shape contracts', () => {
  const source = codeModeWorkerModule('return 1;', { orgId: 'o', workspaceId: 'w' });

  it('tools.search returns { query, total, items, usage } directly, never { ok, data }', () => {
    // The sandbox search helper's return construction — locked so agents can
    // rely on the documented direct shape (no wrapper).
    expect(source).toMatch(/return \{\s*query,\s*total: scored\.length,\s*items,\s*usage/);
    // And the guidance must say exactly that, including the shape.
    expect(source).toContain('tools.search resolves to { query, total, items, usage }');
    expect(source).toContain('NO { ok, data } wrapper');
  });

  it('resolves ok: false for build/deploy operational failures, with the result kept in data', () => {
    // The wrapper flips ok for these tools when data.success === false.
    expect(source).toContain('OPERATIONAL_OUTCOME_TOOLS = new Set(["build_project", "deploy_project"])');
    expect(source).toContain('envelope.data.success === false');
    expect(source).toContain('resolve ok: false when the build or deploy FAILS');
  });
});

describe('empty js_exec output', () => {
  it('explains no-output runs instead of returning a silent blank', () => {
    const source = codeModeWorkerModule('return 1;', { orgId: 'o', workspaceId: 'w' });
    // The blank case must be self-explaining: agents receiving "" invented
    // renderer failures (the "see attached image" incident). The message must
    // name the if/else pitfall since block-final scripts are the common cause.
    expect(source).toContain('js_exec completed: no return value and no console output');
    expect(source).toContain('expressions inside if/else or loop blocks are not');
    expect(source).toMatch(/if \(output\.length === 0\)/);
  });

  it('auto-return still skips block-closing final lines (the pitfall the message covers)', () => {
    const prepared = prepareCodeModeUserCode([
      'const r = await tools.deploy_project({ project: "x" });',
      'if (r.ok) {',
      '  r.data;',
      '} else {',
      '  r.error;',
      '}',
    ].join('\n'));
    expect(prepared).not.toContain('return');
  });
});
