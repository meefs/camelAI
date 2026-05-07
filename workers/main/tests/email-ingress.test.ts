import { beforeEach, describe, expect, it, vi } from 'vitest';
const {
  runExternalMessageTurnMock,
  getWorkspaceStubMock,
  getOrgStubMock,
  getUserStubMock,
} = vi.hoisted(() => ({
  runExternalMessageTurnMock: vi.fn(),
  getWorkspaceStubMock: vi.fn(),
  getOrgStubMock: vi.fn(),
  getUserStubMock: vi.fn(),
}));

vi.mock('../src/helpers/external-turn.js', () => ({
  runExternalMessageTurn: runExternalMessageTurnMock,
}));

vi.mock('../src/helpers/stubs.js', () => ({
  getWorkspaceStub: getWorkspaceStubMock,
  getOrgStub: getOrgStubMock,
  getUserStub: getUserStubMock,
}));

import { handleWorkspaceEmailIngress } from '../src/email-ingress.js';

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createMessage(args: {
  from: string;
  to: string;
  subject?: string;
  rawBody?: string;
  raw?: string;
}): ForwardableEmailMessage & {
  setReject: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
} {
  const setReject = vi.fn();
  const reply = vi.fn().mockResolvedValue(undefined);

  const raw = args.raw ?? (() => {
    const rawBody = args.rawBody || 'hello';
    return [
      `From: ${args.from}`,
      `To: ${args.to}`,
      `Subject: ${args.subject || ''}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      rawBody,
    ].join('\r\n');
  })();

  return {
    from: args.from,
    to: args.to,
    headers: new Headers({
      subject: args.subject || '',
      'message-id': '<msg-1@example.com>',
    }),
    raw: streamFromString(raw),
    rawSize: raw.length,
    setReject,
    forward: vi.fn(),
    reply,
  } as unknown as ForwardableEmailMessage & {
    setReject: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
  };
}

function createMockKvStore(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial || {}));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function createMockEnv(overrides?: Partial<Record<string, unknown>>): any {
  const emailToUser = createMockKvStore();
  const appKv = createMockKvStore();
  return {
    WORKSPACE_EMAIL_DOMAIN: 'mail.camelai.com',
    EMAIL_TO_USER: emailToUser,
    APP_KV: appKv,
    EMAIL_HANDLE: {
      idFromName: (handle: string) => handle,
      get: (handle: string) => ({
        getOwner: async () => handle === 'swift-falcon-ridge' ? 'workspace-1' : null,
      }),
    },
    R2_BUCKET: {
      put: vi.fn().mockResolvedValue({}),
    },
    _emailToUserStore: emailToUser,
    _appKvStore: appKv,
    ...overrides,
  };
}

describe('handleWorkspaceEmailIngress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads email attachments and appends upload refs to the forwarded message', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
      getMemberAccess: vi.fn().mockResolvedValue({ access_level: 'full' }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({ billing_plan: 'pro', billing_status: 'active' }),
      isMember: vi.fn().mockResolvedValue(true),
      getThread: vi.fn().mockResolvedValue(null),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi.fn().mockResolvedValue({ claude_proxy_models: false }),
      createThread: vi.fn().mockResolvedValue({ id: 'thread-1', title: 'Quarterly report' }),
      getWorkspaceBySlug: vi.fn().mockResolvedValue({ id: 'workspace-1', name: 'My Workspace', created_at: 0, archived: 0 }),
    };
    const userStub = {
      getProfile: vi.fn().mockResolvedValue({ name: 'Agent User' }),
    };

    getWorkspaceStubMock.mockReturnValue(workspaceStub);
    getOrgStubMock.mockReturnValue(orgStub);
    getUserStubMock.mockReturnValue(userStub);
    runExternalMessageTurnMock.mockResolvedValue({ status: 'result', reply: 'Looks good.' });

    const env = createMockEnv();
    env.EMAIL_TO_USER.get.mockResolvedValue('user-1');

    const boundary = 'test-boundary';
    const raw = [
      'From: user@example.com',
      'To: swift-falcon-ridge@mail.camelai.com',
      'Subject: Quarterly report',
      'Message-ID: <msg-1@example.com>',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Here is the report.',
      `--${boundary}`,
      'Content-Type: text/plain; name="report 2026.txt"',
      'Content-Disposition: attachment; filename="report 2026.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      'aGVsbG8gYXR0YWNobWVudA==',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const message = createMessage({
      from: 'user@example.com',
      to: 'swift-falcon-ridge@mail.camelai.com',
      subject: 'Quarterly report',
      raw,
    });

    await handleWorkspaceEmailIngress(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(env.R2_BUCKET.put).toHaveBeenCalledTimes(1);
    expect(runExternalMessageTurnMock).toHaveBeenCalledTimes(1);
    expect(message.reply).toHaveBeenCalledTimes(1);

    const [r2Key] = env.R2_BUCKET.put.mock.calls[0] as [string];
    const storedFilename = r2Key.split('/').pop() || '';

    expect(r2Key).toMatch(/^org-1\/workspace-1\/user-uploads\/report_2026-\d+-[a-z0-9]{6}\.txt$/);
    expect(runExternalMessageTurnMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        threadId: 'thread-1',
        message: `Here is the report.\n\n(user uploaded file to /mnt/user-uploads/${storedFilename})`,
      })
    );
  });

  it('falls back to default picker configs when model picker RPC methods are missing', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
      getMemberAccess: vi.fn().mockResolvedValue({ access_level: 'full' }),
      getModelPickerConfig: vi
        .fn()
        .mockRejectedValue(
          new Error('No such RPC method getModelPickerConfig'),
        ),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({ billing_plan: 'pro', billing_status: 'active' }),
      isMember: vi.fn().mockResolvedValue(true),
      getThread: vi.fn().mockResolvedValue(null),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi.fn().mockResolvedValue({ claude_proxy_models: false }),
      getModelPickerConfig: vi
        .fn()
        .mockRejectedValue(
          new Error('No such RPC method getModelPickerConfig'),
        ),
      createThread: vi.fn().mockResolvedValue({ id: 'thread-1', title: 'Need help' }),
      getWorkspaceBySlug: vi.fn().mockResolvedValue({ id: 'workspace-1', name: 'My Workspace', created_at: 0, archived: 0 }),
    };
    const userStub = {
      getProfile: vi.fn().mockResolvedValue({ name: 'Agent User' }),
    };

    getWorkspaceStubMock.mockReturnValue(workspaceStub);
    getOrgStubMock.mockReturnValue(orgStub);
    getUserStubMock.mockReturnValue(userStub);
    runExternalMessageTurnMock.mockResolvedValue({ status: 'result', reply: 'Looks good.' });

    const env = createMockEnv();
    env.EMAIL_TO_USER.get.mockResolvedValue('user-1');

    const message = createMessage({
      from: 'user@example.com',
      to: 'swift-falcon-ridge@mail.camelai.com',
      subject: 'Need help',
      rawBody: 'Please help',
    });

    await handleWorkspaceEmailIngress(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(orgStub.createThread).toHaveBeenCalledWith(
      'workspace-1',
      'Need help',
      'user-1',
      'Please help',
      'sonnet',
      'claude',
    );
    expect(runExternalMessageTurnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown workspace mailbox format', async () => {
    const message = createMessage({
      from: 'user@example.com',
      to: 'support@mail.camelai.com',
      subject: 'hello',
    });

    await handleWorkspaceEmailIngress(message, createMockEnv());

    expect(message.setReject).toHaveBeenCalledWith('Unknown workspace email address.');
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('rejects senders that are not mapped to a user', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({ billing_plan: 'pro', billing_status: 'active' }),
    };
    getWorkspaceStubMock.mockReturnValue(workspaceStub);
    getOrgStubMock.mockReturnValue(orgStub);

    const message = createMessage({
      from: 'stranger@example.com',
      to: 'swift-falcon-ridge@mail.camelai.com',
      subject: 'hello',
    });

    await handleWorkspaceEmailIngress(message, createMockEnv());

    expect(message.setReject).toHaveBeenCalledWith('Sender is not allowed for this workspace inbox.');
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('does not retry forever when Cloudflare refuses to reply to the original email', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
      getMemberAccess: vi.fn().mockResolvedValue({ access_level: 'full' }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({ billing_plan: 'pro', billing_status: 'active' }),
      isMember: vi.fn().mockResolvedValue(true),
      getThread: vi.fn().mockResolvedValue(null),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi.fn().mockResolvedValue({ claude_proxy_models: false }),
      createThread: vi.fn().mockResolvedValue({ id: 'thread-1', title: 'Need help' }),
      getWorkspaceBySlug: vi.fn().mockResolvedValue({ id: 'workspace-1', name: 'My Workspace', created_at: 0, archived: 0 }),
    };
    const userStub = {
      getProfile: vi.fn().mockResolvedValue({ name: 'Agent User' }),
    };

    getWorkspaceStubMock.mockReturnValue(workspaceStub);
    getOrgStubMock.mockReturnValue(orgStub);
    getUserStubMock.mockReturnValue(userStub);
    runExternalMessageTurnMock.mockResolvedValue({ status: 'result', reply: 'Looks good.' });

    const env = createMockEnv();
    env.EMAIL_TO_USER.get.mockResolvedValue('user-1');

    const message = createMessage({
      from: 'user@example.com',
      to: 'swift-falcon-ridge@mail.camelai.com',
      subject: 'Need help',
      rawBody: 'Please reply',
    });
    message.reply.mockRejectedValueOnce(
      new Error('original email is not repliable or exceeds reply limit')
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(handleWorkspaceEmailIngress(message, env)).resolves.toBeUndefined();

    expect(runExternalMessageTurnMock).toHaveBeenCalledTimes(1);
    expect(message.reply).toHaveBeenCalledTimes(1);
    expect(env.APP_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^email_event:/),
      'done',
      expect.objectContaining({ expirationTtl: 600 })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[email-ingress] reply skipped by Cloudflare',
      expect.objectContaining({
        error: 'original email is not repliable or exceeds reply limit',
        threadId: 'thread-1',
      })
    );

    warnSpy.mockRestore();
  });
});
