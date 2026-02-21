export interface ResendConfig {
  apiKey: string;
  fromAddress: string;
}

export interface SendEmailParams {
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

const RESEND_SEND_URL = 'https://api.resend.com/emails';

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const candidate = body as { message?: unknown; error?: { message?: unknown } };
  if (typeof candidate.message === 'string' && candidate.message.trim()) {
    return candidate.message;
  }
  if (
    candidate.error &&
    typeof candidate.error === 'object' &&
    typeof candidate.error.message === 'string' &&
    candidate.error.message.trim()
  ) {
    return candidate.error.message;
  }
  return null;
}

export async function sendEmail(
  config: ResendConfig,
  params: SendEmailParams
): Promise<SendEmailResult> {
  try {
    const response = await fetch(RESEND_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `camelAI <${config.fromAddress}>`,
        to: params.to,
        ...(params.cc ? { cc: params.cc } : {}),
        ...(params.replyTo ? { reply_to: params.replyTo } : {}),
        subject: params.subject,
        text: params.textBody,
        html: params.htmlBody,
      }),
    });

    const rawBody = await response.text();
    let jsonBody: Record<string, unknown> = {};
    if (rawBody) {
      try {
        jsonBody = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        jsonBody = {};
      }
    }
    if (!response.ok) {
      const details = extractErrorMessage(jsonBody) ?? rawBody;
      return {
        success: false,
        error: `Resend API error: ${response.status}${details ? ` ${details}` : ''}`,
      };
    }

    return {
      success: true,
      messageId: typeof jsonBody.id === 'string' ? jsonBody.id : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error sending email',
    };
  }
}
