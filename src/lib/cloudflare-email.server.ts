export interface CloudflareEmailSender {
  send(message: {
    to: string | string[];
    from: string | { email: string; name: string };
    subject: string;
    html?: string;
    text?: string;
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | { email: string; name: string };
    attachments?: Array<{
      content: string | ArrayBuffer;
      filename: string;
      type: string;
      disposition: "attachment" | "inline";
      contentId?: string;
    }>;
  }): Promise<{ messageId?: string }>;
}

export interface CloudflareEmailConfig {
  email: CloudflareEmailSender;
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

export async function sendEmail(
  config: CloudflareEmailConfig,
  params: SendEmailParams
): Promise<SendEmailResult> {
  try {
    const response = await config.email.send({
      from: { email: config.fromAddress, name: 'camelAI' },
      to: params.to,
      ...(params.cc ? { cc: params.cc } : {}),
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
      subject: params.subject,
      text: params.textBody,
      html: params.htmlBody,
    });

    return {
      success: true,
      messageId: response.messageId,
    };
  } catch (error) {
    const maybeError = error as { code?: unknown; message?: unknown };
    const code =
      typeof maybeError.code === 'string' && maybeError.code.trim()
        ? `${maybeError.code}: `
        : '';
    const message =
      typeof maybeError.message === 'string' && maybeError.message.trim()
        ? maybeError.message
        : error instanceof Error
          ? error.message
          : 'Unknown error sending email';
    return {
      success: false,
      error: `${code}${message}`,
    };
  }
}
