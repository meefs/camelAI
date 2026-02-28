import { describe, expect, it, vi } from 'vitest';
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

function createMockEnv(overrides?: Partial<Record<string, unknown>>) {
  return {
    EMAIL_FROM_ADDRESS: 'no-reply@mail.camelai.com',
    WORKSPACE_EMAIL_LOCAL_PART: 'chat',
    EMAIL_TO_USER: {
      get: vi.fn().mockResolvedValue(null),
    },
    APP_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as never;
}

describe('handleWorkspaceEmailIngress', () => {
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
    const message = createMessage({
      from: 'stranger@example.com',
      to: 'chat+workspace-1@mail.camelai.com',
      subject: 'hello',
    });

    await handleWorkspaceEmailIngress(message, createMockEnv());

    expect(message.setReject).toHaveBeenCalledWith('Sender is not allowed for this workspace inbox.');
    expect(message.reply).not.toHaveBeenCalled();
  });
});
