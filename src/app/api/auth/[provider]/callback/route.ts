import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import {
  exchangeCodeForTokens,
  fetchUserInfo,
  isValidOAuthProvider,
  OAUTH_PROVIDERS,
  type OAuthProvider,
} from '@/lib/oauth-config';
import { validateAndConsumeOAuthState } from '../../../../../../workers/main/src/oauth-state';
import * as authDO from '@/lib/auth-do';
import { setSessionCookie } from '@/lib/auth';

interface RouteParams {
  params: Promise<{ provider: string }>;
}

interface OAuthEnv {
  SESSIONS: KVNamespace;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

// Validate redirect URL to prevent open redirects
function getSafeRedirect(redirect: string | null): string {
  if (!redirect) return '/';
  if (redirect.startsWith('/') && !redirect.startsWith('//') && !redirect.includes(':')) {
    return redirect;
  }
  return '/';
}

/**
 * GET /api/auth/[provider]/callback
 * Handles OAuth callback from the provider.
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const { provider: providerParam } = await params;

  // Validate provider
  if (!isValidOAuthProvider(providerParam)) {
    return redirectWithError(request.nextUrl.origin, 'Invalid OAuth provider');
  }

  const provider = providerParam as OAuthProvider;
  const config = OAUTH_PROVIDERS[provider];
  const searchParams = request.nextUrl.searchParams;

  // Check for error from provider
  const error = searchParams.get('error');
  if (error) {
    const errorDescription = searchParams.get('error_description') || error;
    return redirectWithError(request.nextUrl.origin, errorDescription);
  }

  // Get code and state
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  if (!code || !state) {
    return redirectWithError(request.nextUrl.origin, 'Missing code or state');
  }

  // Get environment
  const { env } = getCloudflareContext() as unknown as { env: OAuthEnv };

  // Validate state (CSRF protection)
  const oauthState = await validateAndConsumeOAuthState(env.SESSIONS, state);
  if (!oauthState) {
    return redirectWithError(request.nextUrl.origin, 'Invalid or expired state. Please try again.');
  }

  // Verify state matches provider
  if (oauthState.provider !== provider) {
    return redirectWithError(request.nextUrl.origin, 'State provider mismatch');
  }

  // Get client credentials
  const clientId = env[config.clientIdEnvVar as keyof OAuthEnv] as string | undefined;
  const clientSecret = env[config.clientSecretEnvVar as keyof OAuthEnv] as string | undefined;

  if (!clientId || !clientSecret) {
    console.error(`Missing ${config.clientIdEnvVar} or ${config.clientSecretEnvVar}`);
    return redirectWithError(request.nextUrl.origin, `${config.displayName} sign-in is not configured`);
  }

  // Build callback URL
  const origin = request.nextUrl.origin;
  const callbackUrl = `${origin}/api/auth/${provider}/callback`;

  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(
      provider,
      code,
      clientId,
      clientSecret,
      callbackUrl
    );

    // Fetch user info
    const userInfo = await fetchUserInfo(provider, tokens.access_token);

    // Check if user exists with this OAuth provider
    let userId: string;
    const existingOAuthUser = await authDO.getUserByOAuthProvider(provider, userInfo.providerId);

    if (existingOAuthUser) {
      // User exists with this OAuth provider - log them in
      userId = existingOAuthUser.userId;
    } else {
      // Check if user exists with this email
      const existingEmailUser = await authDO.getUserByEmail(userInfo.email);

      if (existingEmailUser) {
        // Link OAuth to existing email user
        userId = existingEmailUser.userId;
        await authDO.linkOAuthProvider(userId, provider, userInfo.providerId);
      } else {
        // Create new user
        const newUser = await authDO.createUserFromOAuth(
          userInfo.email,
          userInfo.name,
          provider,
          userInfo.providerId
        );
        userId = newUser.userId;

        // Create default organization for new user
        const org = await authDO.createOrg(
          `${userInfo.name || userInfo.email.split('@')[0]}'s Workspace`,
          userId
        );

        // Get default workspace
        const workspaces = await authDO.listUserWorkspaces(userId, org.id);
        const defaultWorkspace = workspaces[0] || null;

        // Create session with org and workspace
        const { sessionId } = await authDO.createSession(
          userId,
          org.id,
          defaultWorkspace?.id ?? null
        );
        await setSessionCookie(sessionId, request);

        // Redirect to safe URL
        const redirectUrl = getSafeRedirect(oauthState.redirect_url);
        return NextResponse.redirect(new URL(redirectUrl, origin));
      }
    }

    // Get user's orgs for session
    const orgs = await authDO.getUserOrgs(userId);

    if (orgs.length === 0) {
      // User has no orgs - create one
      const user = existingOAuthUser?.user || (await authDO.getUserById(userId));
      const org = await authDO.createOrg(
        `${user?.name || userInfo.email.split('@')[0]}'s Workspace`,
        userId
      );
      orgs.push({
        org_id: org.id,
        org_name: org.name,
        role: 'owner',
        joined_at: org.created_at,
        last_workspace_id: null,
      });
    }

    // Get preferred workspace
    const currentOrg = orgs[0];
    const workspaces = await authDO.listUserWorkspaces(userId, currentOrg.org_id);
    const preferredWorkspaceId = currentOrg.last_workspace_id ?? null;
    const currentWorkspace = workspaces.find((ws) => ws.id === preferredWorkspaceId) || workspaces[0] || null;

    // Create session
    const { sessionId } = await authDO.createSession(
      userId,
      currentOrg.org_id,
      currentWorkspace?.id ?? null
    );
    await setSessionCookie(sessionId, request);

    // Redirect to safe URL
    const redirectUrl = getSafeRedirect(oauthState.redirect_url);
    return NextResponse.redirect(new URL(redirectUrl, origin));
  } catch (err) {
    console.error(`OAuth callback error for ${provider}:`, err);
    const message = err instanceof Error ? err.message : 'Authentication failed';
    return redirectWithError(origin, message);
  }
}

function redirectWithError(origin: string, error: string): NextResponse {
  const url = new URL('/login', origin);
  url.searchParams.set('error', error);
  return NextResponse.redirect(url);
}
