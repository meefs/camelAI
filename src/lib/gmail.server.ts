/**
 * Gmail API client for sending emails via Google Workspace.
 *
 * Uses a service account with domain-wide delegation to send emails
 * as the configured sender address.
 *
 * Required setup:
 * 1. Create a service account in Google Cloud Console
 * 2. Enable domain-wide delegation for the service account
 * 3. In Google Workspace Admin, grant the service account the
 *    scope: https://www.googleapis.com/auth/gmail.send
 * 4. Set environment variables:
 *    - GMAIL_SERVICE_ACCOUNT_EMAIL: service account email
 *    - GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY: private key (PEM format)
 *    - GMAIL_SENDER_EMAIL: email to send as (e.g., no-reply@chiridion.ai)
 */

export interface GmailConfig {
  serviceAccountEmail: string;
  privateKey: string;
  senderEmail: string;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/**
 * Base64url encode (URL-safe base64 without padding)
 */
function base64urlEncode(data: string | ArrayBuffer): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Import a PEM private key for signing
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Handle escaped newlines from environment variables
  const normalizedPem = pem.replace(/\\n/g, '\n');

  // Extract the base64 content from PEM
  const pemContents = normalizedPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
    .replace(/-----END RSA PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );
}

/**
 * Create a signed JWT for Google OAuth
 */
async function createSignedJwt(config: GmailConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const payload = {
    iss: config.serviceAccountEmail,
    sub: config.senderEmail, // Impersonate this user
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600, // 1 hour
    scope: GMAIL_SCOPE,
  };

  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const privateKey = await importPrivateKey(config.privateKey);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  const encodedSignature = base64urlEncode(signature);
  return `${signingInput}.${encodedSignature}`;
}

/**
 * Exchange a signed JWT for an access token
 */
async function getAccessToken(config: GmailConfig): Promise<string> {
  const jwt = await createSignedJwt(config);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get access token: ${response.status} ${error}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Build an RFC 2822 email message
 */
function buildRawEmail(
  from: string,
  to: string,
  subject: string,
  textBody: string,
  htmlBody: string
): string {
  const messageId = crypto.randomUUID();
  const boundary = `chiridion_${messageId.replace(/-/g, '')}`;

  const lines = [
    `From: Chiridion <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${messageId}@chiridion.ai>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(unescape(encodeURIComponent(textBody))),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(unescape(encodeURIComponent(htmlBody))),
    '',
    `--${boundary}--`,
  ];

  return lines.join('\r\n');
}

/**
 * Send an email via Gmail API
 */
export async function sendEmail(
  config: GmailConfig,
  params: SendEmailParams
): Promise<SendEmailResult> {
  try {
    const accessToken = await getAccessToken(config);

    const rawEmail = buildRawEmail(
      config.senderEmail,
      params.to,
      params.subject,
      params.textBody,
      params.htmlBody
    );

    // Gmail API expects base64url-encoded raw message
    const encodedMessage = base64urlEncode(rawEmail);

    const response = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: encodedMessage }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Gmail API error: ${response.status} ${error}`,
      };
    }

    const data = (await response.json()) as { id: string };
    return {
      success: true,
      messageId: data.id,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error sending email',
    };
  }
}

/**
 * Check if Gmail is configured
 */
export function isGmailConfigured(env: {
  GMAIL_SERVICE_ACCOUNT_EMAIL?: string;
  GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  GMAIL_SENDER_EMAIL?: string;
}): boolean {
  return Boolean(
    env.GMAIL_SERVICE_ACCOUNT_EMAIL?.trim() &&
      env.GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY?.trim() &&
      env.GMAIL_SENDER_EMAIL?.trim()
  );
}

/**
 * Get Gmail config from environment
 */
export function getGmailConfig(env: {
  GMAIL_SERVICE_ACCOUNT_EMAIL?: string;
  GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  GMAIL_SENDER_EMAIL?: string;
}): GmailConfig | null {
  if (!isGmailConfigured(env)) {
    return null;
  }

  return {
    serviceAccountEmail: env.GMAIL_SERVICE_ACCOUNT_EMAIL!.trim(),
    privateKey: env.GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY!.trim(),
    senderEmail: env.GMAIL_SENDER_EMAIL!.trim(),
  };
}
