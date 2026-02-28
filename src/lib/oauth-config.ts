/**
 * OAuth provider configuration for Google and GitHub sign-in.
 */

export type OAuthProvider = 'google' | 'github';

export interface OAuthProviderConfig {
  clientIdEnvVar: string;
  clientSecretEnvVar: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  displayName: string;
}

export const OAUTH_PROVIDERS: Record<OAuthProvider, OAuthProviderConfig> = {
  google: {
    clientIdEnvVar: 'GOOGLE_CLIENT_ID',
    clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: ['openid', 'email', 'profile'],
    displayName: 'Google',
  },
  github: {
    clientIdEnvVar: 'GITHUB_CLIENT_ID',
    clientSecretEnvVar: 'GITHUB_CLIENT_SECRET',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scopes: ['read:user', 'user:email'],
    displayName: 'GitHub',
  },
};

export interface OAuthUserInfo {
  provider: OAuthProvider;
  providerId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
}

export interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export interface GitHubUserInfo {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

export interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null;
}

const OAUTH_FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = OAUTH_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('aborted'))
    ) {
      throw new Error(`OAuth upstream request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function isValidOAuthProvider(provider: string): provider is OAuthProvider {
  return provider === 'google' || provider === 'github';
}

/**
 * Build the OAuth authorization URL for a provider.
 */
export function buildAuthorizationUrl(
  provider: OAuthProvider,
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const config = OAUTH_PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
  });

  // Google-specific parameters
  if (provider === 'google') {
    params.set('access_type', 'offline');
    params.set('prompt', 'select_account');
  }

  return `${config.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  provider: OAuthProvider,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  timeoutMs = OAUTH_FETCH_TIMEOUT_MS
): Promise<OAuthTokenResponse> {
  const config = OAUTH_PROVIDERS[provider];

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  // Google requires grant_type; GitHub does not use it
  if (provider === 'google') {
    body.set('grant_type', 'authorization_code');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  // GitHub requires Accept header to return JSON
  if (provider === 'github') {
    headers['Accept'] = 'application/json';
  }

  const response = await fetchWithTimeout(config.tokenUrl, {
    method: 'POST',
    headers,
    body: body.toString(),
  }, timeoutMs);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json() as Record<string, unknown>;

  // GitHub returns 200 OK even for errors (e.g. bad_verification_code),
  // so we must check the response body for an error field.
  if (data.error) {
    throw new Error(`Token exchange failed: ${data.error} - ${data.error_description || 'unknown error'}`);
  }

  return data as unknown as OAuthTokenResponse;
}

/**
 * Fetch user info from OAuth provider.
 */
export async function fetchUserInfo(
  provider: OAuthProvider,
  accessToken: string,
  timeoutMs = OAUTH_FETCH_TIMEOUT_MS
): Promise<OAuthUserInfo> {
  const config = OAUTH_PROVIDERS[provider];

  const response = await fetchWithTimeout(config.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'Chiridion',
    },
  }, timeoutMs);

  if (!response.ok) {
    throw new Error(`Failed to fetch user info: ${response.status}`);
  }

  if (provider === 'google') {
    const data = (await response.json()) as GoogleUserInfo;
    return {
      provider: 'google',
      providerId: data.id,
      email: data.email,
      name: data.name || null,
      avatarUrl: data.picture || null,
    };
  }

  if (provider === 'github') {
    const data = (await response.json()) as GitHubUserInfo;

    // GitHub may not return email in user info, need to fetch separately
    let email = data.email;
    if (!email) {
      email = await fetchGitHubPrimaryEmail(accessToken, timeoutMs);
    }

    if (!email) {
      throw new Error('Could not retrieve email from GitHub. Please ensure your email is public or use another sign-in method.');
    }

    return {
      provider: 'github',
      providerId: String(data.id),
      email,
      name: data.name || data.login,
      avatarUrl: data.avatar_url || null,
    };
  }

  throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Fetch primary email from GitHub (when not public).
 */
async function fetchGitHubPrimaryEmail(
  accessToken: string,
  timeoutMs = OAUTH_FETCH_TIMEOUT_MS
): Promise<string | null> {
  const response = await fetchWithTimeout('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'Chiridion',
    },
  }, timeoutMs);

  if (!response.ok) {
    return null;
  }

  const emails = (await response.json()) as GitHubEmail[];
  const primary = emails.find((e) => e.primary && e.verified);
  return primary?.email || emails.find((e) => e.verified)?.email || null;
}
