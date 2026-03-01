import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRunExternalMessageTurn,
  mockGetWorkspaceStub,
  mockGetOrgStub,
  mockGetUserStub,
} = vi.hoisted(() => ({
  mockRunExternalMessageTurn: vi.fn(),
  mockGetWorkspaceStub: vi.fn(),
  mockGetOrgStub: vi.fn(),
  mockGetUserStub: vi.fn(),
}));

vi.mock('cloudflare:email', () => ({
  EmailMessage: class MockEmailMessage {
    from: string;
    to: string;
    raw: string;

    constructor(from: string, to: string, raw: string) {
      this.from = from;
      this.to = to;
      this.raw = raw;
    }
  },
}));

vi.mock('../src/helpers/external-turn.js', () => ({
  runExternalMessageTurn: mockRunExternalMessageTurn,
}));

vi.mock('../src/helpers/stubs.js', () => ({
  getWorkspaceStub: mockGetWorkspaceStub,
  getOrgStub: mockGetOrgStub,
  getUserStub: mockGetUserStub,
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
}): ForwardableEmailMessage & {
  setReject: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
} {
  const setReject = vi.fn();
  const reply = vi.fn().mockResolvedValue(undefined);

  const rawBody = args.rawBody || 'hello';
  const raw = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${args.subject || ''}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    rawBody,
  ].join('\r\n');

  return {
    from: args.from,
    to: args.to,
    headers: new Headers({
      subject: args.subject || '',
      'message-id': '<incoming@example.com>',
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

function createMockKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

describe('handleWorkspaceEmailIngress markdown email replies', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRunExternalMessageTurn.mockResolvedValue({
      status: 'result',
      reply: '## Summary\n\n- item one\n- item two',
    });

    mockGetWorkspaceStub.mockReturnValue({
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
      getMemberAccess: vi.fn().mockResolvedValue({ access_level: 'full' }),
    });

    mockGetOrgStub.mockReturnValue({
      isMember: vi.fn().mockResolvedValue(true),
      getThread: vi.fn().mockResolvedValue(null),
      createThread: vi.fn().mockResolvedValue({
        id: 'thread-1',
        title: 'Build something',
      }),
    });

    mockGetUserStub.mockReturnValue({
      getProfile: vi.fn().mockResolvedValue({ name: 'Miguel' }),
    });
  });

  it('sends multipart reply with markdown rendered HTML', async () => {
    const message = createMessage({
      from: 'user@example.com',
      to: 'chat+workspace-1@mail.camelai.com',
      subject: 'Need help',
      rawBody: 'Can you summarize this?',
    });

    const env = {
      WORKSPACE_EMAIL_DOMAIN: 'mail.camelai.com',
      WORKSPACE_EMAIL_LOCAL_PART: 'chat',
      EMAIL_TO_USER: {
        get: vi.fn().mockResolvedValue('user-1'),
      },
      APP_KV: createMockKv(),
    } as never;

    await handleWorkspaceEmailIngress(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledTimes(1);

    const outbound = message.reply.mock.calls[0]?.[0] as { raw: string };
    const raw = outbound.raw;

    expect(raw).toContain('Content-Type: multipart/alternative; boundary="camelai-');
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');

    expect(raw).toContain('## Summary');
    expect(raw).toContain('<h2>Summary</h2>');
    expect(raw).toContain('<li>item one</li>');
  });
});
