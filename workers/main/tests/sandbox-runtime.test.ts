import { describe, it, expect, vi } from 'vitest';
import { WorkspaceContainer } from '../src/workspace-container';
import type { WorkspaceContainerEnv } from '../src/workspace-container';

describe('sandbox runtime', () => {
  it('creates independent instances per call', () => {
    const env = {} as WorkspaceContainerEnv;
    const a = new WorkspaceContainer(env, 'ws-1', 'org-1');
    const b = new WorkspaceContainer(env, 'ws-1', 'org-1');
    expect(a).not.toBe(b);
  });

  it('returns false when integration env refresh cannot fetch vars', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const env = {
      INTEGRATION_SECRET_KEY: 'test-secret',
      WORKSPACE: {
        idFromName() {
          throw new Error('workspace lookup failed');
        },
      },
    } as unknown as WorkspaceContainerEnv;

    const container = new WorkspaceContainer(env, 'ws-1', 'org-1');
    await expect(container.refreshIntegrationEnvVars()).resolves.toBe(false);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('uses single recursive fs list request when sandbox host supports recursive mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          recursive: true,
          files: [
            {
              name: 'main.ts',
              type: 'file',
              size: 42,
              modifiedAt: '2026-02-28T00:00:00.000Z',
              relativePath: 'src/main.ts',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const env = {
      SANDBOX_HOST: { fetch: fetchMock },
    } as unknown as WorkspaceContainerEnv;

    const container = new WorkspaceContainer(env, 'ws-1', 'org-1');
    const result = await container.listFiles('/home/claude', { recursive: true, includeHidden: true });

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.files[0]?.relativePath).toBe('src/main.ts');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('/fs/list');
    expect(calledUrl).toContain('recursive=1');
  });

  it('falls back to legacy recursive walk when sandbox host does not report recursive support', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const path = url.searchParams.get('path');
      const recursive = url.searchParams.get('recursive');

      if (recursive === '1') {
        return new Response(
          JSON.stringify({
            files: [
              { name: 'src', type: 'directory', size: 0, modifiedAt: '2026-02-28T00:00:00.000Z' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (path === '/home/claude') {
        return new Response(
          JSON.stringify({
            files: [
              { name: 'src', type: 'directory', size: 0, modifiedAt: '2026-02-28T00:00:00.000Z' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (path === '/home/claude/src') {
        return new Response(
          JSON.stringify({
            files: [
              { name: 'main.ts', type: 'file', size: 12, modifiedAt: '2026-02-28T00:00:00.000Z' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('Not found', { status: 404 });
    });

    const env = {
      SANDBOX_HOST: { fetch: fetchMock },
    } as unknown as WorkspaceContainerEnv;

    const container = new WorkspaceContainer(env, 'ws-1', 'org-1');
    const result = await container.listFiles('/home/claude', { recursive: true, includeHidden: true });

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.files.some((file) => file.relativePath === 'src')).toBe(true);
    expect(result.files.some((file) => file.relativePath === 'src/main.ts')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries transient message history fetch handshake failures', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const timeout = new Error('handshake timeout');
    timeout.name = 'HandshakeTimeoutError';
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, messages: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const env = {
      SANDBOX_HOST: { fetch: fetchMock },
    } as unknown as WorkspaceContainerEnv;

    const container = new WorkspaceContainer(env, 'ws-1', 'org-1');
    const result = await container.readThreadMessagesStream('thread-1');

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      '[Sandbox] transient sandbox fetch failed; retrying',
      expect.objectContaining({
        operation: 'chat_messages',
        workspaceId: 'ws-1',
        orgId: 'org-1',
        attempt: 1,
      }),
    );

    warnSpy.mockRestore();
  });

});
