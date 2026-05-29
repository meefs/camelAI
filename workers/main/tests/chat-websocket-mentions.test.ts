import { describe, expect, it, vi } from 'vitest';

import { buildRunnerUserMessageContent } from '../src/routes/websocket';

describe('chat runner websocket connection mentions', () => {
  it('expands @connection mentions before forwarding browser messages to the runner', async () => {
    const workspaceStub = {
      getIntegrations: vi.fn().mockResolvedValue([
        {
          id: 'conn_sales',
          integration_type: 'postgres',
          name: 'Sales DB',
          created_at: 1,
          config: '{}',
        },
      ]),
    };
    const env = {
      WORKSPACE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => workspaceStub),
      },
    } as any;

    const content = await buildRunnerUserMessageContent(
      env,
      'workspace-1',
      'Check @sales_db orders',
      { userName: 'Ada', userEmail: 'ada@example.com' },
    );

    expect(workspaceStub.getIntegrations).toHaveBeenCalledTimes(1);
    expect(content).toContain('<camelai system message>');
    expect(content).toContain('## Available connections');
    expect(content).toContain('@sales_db — postgres "Sales DB" (connection id: conn_sales)');
    expect(content).toContain('Use the `js_exec` tool');
    expect(content).toContain('Connection credentials are intentionally hidden behind');
    expect(content).toContain(
      '[web message from Ada (ada@example.com)]: Check @sales_db ⟦ref: postgres "Sales DB" id=conn_sales⟧ orders',
    );
  });

  it('does not fetch integrations for messages without mention tokens', async () => {
    const workspaceStub = {
      getIntegrations: vi.fn(),
    };
    const env = {
      WORKSPACE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => workspaceStub),
      },
    } as any;

    const content = await buildRunnerUserMessageContent(
      env,
      'workspace-1',
      'No connection here',
      { userName: 'Ada' },
    );

    expect(workspaceStub.getIntegrations).not.toHaveBeenCalled();
    expect(content).toBe('[web message from Ada]: No connection here');
  });
});
