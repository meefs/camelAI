import { describe, expect, it, vi } from 'vitest';

import { buildRunnerUserMessageContent } from '../src/routes/websocket';

describe('chat runner websocket connection mentions', () => {
  function connection(overrides: Record<string, unknown> = {}) {
    return {
      id: 'conn_sales',
      integration_type: 'postgres',
      name: 'Sales DB',
      created_at: 1,
      config: '{}',
      ...overrides,
    };
  }

  function project(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ca-workspace-1-camel-site',
      name: 'camel-site',
      description: 'Marketing site rebuild with pricing pages',
      kind: 'project',
      createdAt: '2026-06-10T12:00:00.000Z',
      updatedAt: '2026-06-11T12:00:00.000Z',
      ...overrides,
    };
  }

  function makeEnv(options?: {
    integrations?: unknown[];
    projects?: unknown[];
    integrationsError?: unknown;
    projectsError?: unknown;
  }) {
    const workspaceStub = {
      getIntegrations: options?.integrationsError
        ? vi.fn().mockRejectedValue(options.integrationsError)
        : vi.fn().mockResolvedValue(options?.integrations ?? []),
    };
    const workspaceFsStub = {
      listProjects: options?.projectsError
        ? vi.fn().mockRejectedValue(options.projectsError)
        : vi.fn().mockResolvedValue(options?.projects ?? []),
    };
    const env = {
      WORKSPACE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => workspaceStub),
      },
      WORKSPACE_FS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => workspaceFsStub),
      },
    } as any;
    return { env, workspaceStub, workspaceFsStub };
  }

  it('expands @connection mentions before forwarding browser messages to the runner', async () => {
    const { env, workspaceStub, workspaceFsStub } = makeEnv({
      integrations: [connection()],
    });

    const content = await buildRunnerUserMessageContent(
      env,
      'workspace-1',
      'Check @sales_db orders',
      { userName: 'Ada', userEmail: 'ada@example.com' },
    );

    expect(workspaceStub.getIntegrations).toHaveBeenCalledTimes(1);
    expect(workspaceFsStub.listProjects).toHaveBeenCalledTimes(1);
    expect(content).toContain('<camelai system message>');
    expect(content).toContain('## Available connections');
    expect(content).toContain('@sales_db — postgres "Sales DB" (connection id: conn_sales)');
    expect(content).toContain('Use the `js_exec` tool');
    expect(content).toContain('Connection credentials are intentionally hidden behind');
    expect(content).toContain(
      '[web message from Ada (ada@example.com)]: Check @sales_db ⟦ref: postgres "Sales DB" id=conn_sales⟧ orders',
    );
    expect(content).not.toContain('## Referenced projects');
  });

  it('expands project-only mentions and injects referenced project context', async () => {
    const { env } = makeEnv({
      projects: [project()],
    });

    const content = await buildRunnerUserMessageContent(
      env,
      'workspace-1',
      'Work in @camel_site',
      { userName: 'Ada' },
    );

    expect(content).toContain('## Referenced projects');
    expect(content).toContain(
      '- @camel_site — project "camel-site": Marketing site rebuild with pricing pages',
    );
    expect(content).toContain(
      '[web message from Ada]: Work in @camel_site ⟦ref: project "camel-site" id=ca-workspace-1-camel-site⟧',
    );
    expect(content).not.toContain('## Available connections');
  });

  it('emits connection context before project context for mixed mentions', async () => {
    const { env } = makeEnv({
      integrations: [connection({
        id: 'conn_stripe',
        integration_type: 'stripe',
        name: 'Stripe',
      })],
      projects: [project()],
    });

    const content = await buildRunnerUserMessageContent(
      env,
      'workspace-1',
      'Use @stripe and @camel_site',
    );

    expect(content).toContain('@stripe ⟦ref: stripe "Stripe" id=conn_stripe⟧');
    expect(content).toContain('@camel_site ⟦ref: project "camel-site" id=ca-workspace-1-camel-site⟧');
    expect(content.indexOf('## Available connections')).toBeLessThan(
      content.indexOf('## Referenced projects'),
    );
  });

  it('does not annotate nested clone mentions or inject project context', async () => {
    const { env } = makeEnv({
      projects: [
        project({
          clones: [
            {
              id: 'ca-workspace-1-camel-site-v2',
              name: 'camel-site-v2',
              description: 'Experiment branch for the new hero',
              createdAt: '2026-06-11T12:00:00.000Z',
              updatedAt: '2026-06-11T12:00:00.000Z',
            },
          ],
        }),
      ],
    });

    const content = await buildRunnerUserMessageContent(
      env,
      'workspace-1',
      'Try @camel_site_v2',
    );

    expect(content).toBe('[web message]: Try @camel_site_v2');
    expect(content).not.toContain('⟦ref:');
    expect(content).not.toContain('## Referenced projects');
  });

  it('does not change connections-only behavior when no project mention matches', async () => {
    const { env } = makeEnv({
      integrations: [connection()],
      projects: [project()],
    });

    const content = await buildRunnerUserMessageContent(
      env,
      'workspace-1',
      'Check @sales_db and @unknown_project',
    );

    expect(content).toContain('## Available connections');
    expect(content).not.toContain('## Referenced projects');
    expect(content).toContain('@sales_db ⟦ref: postgres "Sales DB" id=conn_sales⟧');
    expect(content).toContain('@unknown_project');
  });

  it('resolves cross-kind slug collisions through deterministic suffixes', async () => {
    const { env } = makeEnv({
      integrations: [connection({
        id: 'conn_camel',
        name: 'camel',
        integration_type: 'postgres',
        created_at: 1,
      })],
      projects: [project({
        id: 'ca-workspace-1-camel',
        name: 'camel',
        createdAt: '2026-06-10T12:00:00.000Z',
      })],
    });

    const content = await buildRunnerUserMessageContent(
      env,
      'workspace-1',
      'Compare @camel and @camel-2',
    );

    expect(content).toContain('@camel ⟦ref: postgres "camel" id=conn_camel⟧');
    expect(content).toContain('@camel-2 ⟦ref: project "camel" id=ca-workspace-1-camel⟧');
  });

  it('keeps connection mentions when project listing fails', async () => {
    const { env } = makeEnv({
      integrations: [connection()],
      projectsError: new Error('projects unavailable'),
    });

    const content = await buildRunnerUserMessageContent(
      env,
      'workspace-1',
      'Check @sales_db',
    );

    expect(content).toContain('## Available connections');
    expect(content).toContain('@sales_db ⟦ref: postgres "Sales DB" id=conn_sales⟧');
  });

  it('keeps project mentions when integration listing fails', async () => {
    const { env } = makeEnv({
      integrationsError: new Error('integrations unavailable'),
      projects: [project()],
    });

    const content = await buildRunnerUserMessageContent(
      env,
      'workspace-1',
      'Work in @camel_site',
    );

    expect(content).toContain('## Referenced projects');
    expect(content).toContain('@camel_site ⟦ref: project "camel-site" id=ca-workspace-1-camel-site⟧');
  });

  it('does not fetch integrations for messages without mention tokens', async () => {
    const { env, workspaceStub, workspaceFsStub } = makeEnv();

    const content = await buildRunnerUserMessageContent(
      env,
      'workspace-1',
      'No connection here',
      { userName: 'Ada' },
    );

    expect(workspaceStub.getIntegrations).not.toHaveBeenCalled();
    expect(workspaceFsStub.listProjects).not.toHaveBeenCalled();
    expect(content).toBe('[web message from Ada]: No connection here');
  });
});
