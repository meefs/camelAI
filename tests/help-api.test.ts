import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HELP_DESCRIPTION_MAX_LENGTH,
  HELP_PAGE_URL_MAX_LENGTH,
  HELP_SCREEN_SIZE_MAX_LENGTH,
} from '@/lib/help';

const waitUntilMock = vi.fn();
const requireAuthContextMock = vi.fn();
const getEnvMock = vi.fn();
const sendHelpConfirmationEmailMock = vi.fn();
const sendHelpSupportEmailMock = vi.fn();

let waitUntilPromises: Promise<unknown>[] = [];

vi.mock('cloudflare:workers', () => ({
  waitUntil: waitUntilMock,
}));

vi.mock('@/lib/wait-until', () => ({
  waitUntil: waitUntilMock,
}));

vi.mock('@/lib/auth.server', () => ({
  requireAuthContext: requireAuthContextMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/email.server', () => ({
  sendHelpConfirmationEmail: sendHelpConfirmationEmailMock,
  sendHelpSupportEmail: sendHelpSupportEmailMock,
}));

const { action } = await import('@/routes/api/help');

const authContext = {
  user: {
    id: 'usr_123',
    email: 'jane@example.com',
    name: 'Jane Doe',
  },
  currentOrg: {
    id: 'org_123',
    name: 'Acme Inc',
    slug: 'acme-inc',
    billing_status: 'paying',
  },
  currentWorkspace: {
    id: 'ws_123',
    name: 'Main Workspace',
  },
};

function makeRequest(
  form: Record<string, string>,
  headers?: Record<string, string>
): Request {
  const body = new URLSearchParams(form).toString();
  return new Request('https://camelai.com/api/help', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(headers ?? {}),
    },
    body,
  });
}

async function flushWaitUntil(): Promise<void> {
  const pending = [...waitUntilPromises];
  waitUntilPromises = [];
  await Promise.all(pending);
}

describe('POST /api/help', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilPromises = [];
    waitUntilMock.mockImplementation((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });
    requireAuthContextMock.mockResolvedValue(authContext);
    sendHelpConfirmationEmailMock.mockResolvedValue({ status: 'sent' });
    sendHelpSupportEmailMock.mockResolvedValue({ status: 'sent' });
    getEnvMock.mockReturnValue({
      AI: {
        run: vi.fn().mockResolvedValue({
          response: 'Agent freezes on large upload',
        }),
      },
    });
  });

  it('returns 401 for unauthenticated requests', async () => {
    requireAuthContextMock.mockRejectedValue(
      new Response(null, {
        status: 302,
        headers: { Location: '/login' },
      })
    );

    const response = await action({
      request: makeRequest({
        category: 'bug',
        severity: 'high',
        description: 'Something failed',
      }),
      context: {},
    } as never);

    expect(response.status).toBe(401);
  });

  it('returns 400 when category is missing', async () => {
    const response = await action({
      request: makeRequest({
        severity: 'high',
        description: 'Something failed',
      }),
      context: {},
    } as never);

    expect(response.status).toBe(400);
  });

  it('returns 400 when description is empty', async () => {
    const response = await action({
      request: makeRequest({
        category: 'bug',
        severity: 'high',
        description: '   ',
      }),
      context: {},
    } as never);

    expect(response.status).toBe(400);
  });

  it('returns 400 when description exceeds max length', async () => {
    const response = await action({
      request: makeRequest({
        category: 'bug',
        severity: 'high',
        description: 'x'.repeat(HELP_DESCRIPTION_MAX_LENGTH + 1),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(400);
    expect(sendHelpConfirmationEmailMock).not.toHaveBeenCalled();
    expect(sendHelpSupportEmailMock).not.toHaveBeenCalled();
  });

  it('returns 400 when pageUrl exceeds max length', async () => {
    const response = await action({
      request: makeRequest({
        category: 'bug',
        severity: 'high',
        description: 'Agent freezes',
        pageUrl: `https://camelai.com/${'x'.repeat(HELP_PAGE_URL_MAX_LENGTH)}`,
      }),
      context: {},
    } as never);

    expect(response.status).toBe(400);
    expect(sendHelpConfirmationEmailMock).not.toHaveBeenCalled();
    expect(sendHelpSupportEmailMock).not.toHaveBeenCalled();
  });

  it('returns 400 when screenSize exceeds max length', async () => {
    const response = await action({
      request: makeRequest({
        category: 'bug',
        severity: 'high',
        description: 'Agent freezes',
        screenSize: 'x'.repeat(HELP_SCREEN_SIZE_MAX_LENGTH + 1),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(400);
    expect(sendHelpConfirmationEmailMock).not.toHaveBeenCalled();
    expect(sendHelpSupportEmailMock).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid category value', async () => {
    const response = await action({
      request: makeRequest({
        category: 'invalid-category',
        severity: 'high',
        description: 'Something failed',
      }),
      context: {},
    } as never);

    expect(response.status).toBe(400);
  });

  it('defaults severity to low when not provided', async () => {
    const response = await action({
      request: makeRequest({
        category: 'question',
        description: 'Can I invite more members?',
      }),
      context: {},
    } as never);
    await flushWaitUntil();

    expect(response.status).toBe(200);
    expect(sendHelpConfirmationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'Low',
      })
    );
    expect(sendHelpSupportEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'Low',
      })
    );
  });

  it('returns success for valid submissions', async () => {
    const response = await action({
      request: makeRequest({
        category: 'bug',
        severity: 'high',
        description: 'Agent freezes when uploading files.',
      }),
      context: {},
    } as never);
    const json = (await response.json()) as { success?: boolean };

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
  });

  it('does not fail the request when async email delivery throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sendHelpConfirmationEmailMock.mockRejectedValueOnce(new Error('smtp down'));

    const response = await action({
      request: makeRequest({
        category: 'bug',
        severity: 'high',
        description: 'Agent freezes when uploading files.',
      }),
      context: {},
    } as never);
    await flushWaitUntil();

    expect(response.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      'Help email delivery failed:',
      expect.any(Error)
    );
    errorSpy.mockRestore();
  });

  it('passes pageUrl and screenSize from form data to support email', async () => {
    await action({
      request: makeRequest({
        category: 'bug',
        severity: 'medium',
        description: 'Agent freezes.',
        pageUrl: 'https://camelai.com/chat/abc123',
        screenSize: '1440x900',
      }),
      context: {},
    } as never);
    await flushWaitUntil();

    expect(sendHelpSupportEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pageUrl: 'https://camelai.com/chat/abc123',
        screenSize: '1440x900',
      })
    );
  });

  it('passes User-Agent and Referer headers to support email', async () => {
    await action({
      request: makeRequest(
        {
          category: 'bug',
          severity: 'medium',
          description: 'Agent freezes.',
        },
        {
          'user-agent': 'Mozilla/5.0 Test Browser',
          referer: 'https://camelai.com/chat/abc123',
        }
      ),
      context: {},
    } as never);
    await flushWaitUntil();

    expect(sendHelpSupportEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userAgent: 'Mozilla/5.0 Test Browser',
        referer: 'https://camelai.com/chat/abc123',
      })
    );
  });

  it('calls both email senders with expected recipients', async () => {
    await action({
      request: makeRequest({
        category: 'feature',
        severity: 'high',
        description: 'Please add CSV export.',
      }),
      context: {},
    } as never);
    await flushWaitUntil();

    expect(sendHelpConfirmationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'jane@example.com',
      })
    );
    expect(sendHelpSupportEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'support@camelai.com',
      })
    );
  });

  it('falls back to "there" when user name is whitespace-only', async () => {
    requireAuthContextMock.mockResolvedValue({
      ...authContext,
      user: {
        ...authContext.user,
        name: '   ',
      },
    });

    await action({
      request: makeRequest({
        category: 'bug',
        severity: 'medium',
        description: 'Agent freezes.',
      }),
      context: {},
    } as never);
    await flushWaitUntil();

    expect(sendHelpConfirmationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'there',
      })
    );
  });
});
