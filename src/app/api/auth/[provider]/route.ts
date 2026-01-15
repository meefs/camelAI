import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import {
  buildAuthorizationUrl,
  isValidOAuthProvider,
  OAUTH_PROVIDERS,
  type OAuthProvider,
} from '@/lib/oauth-config';
import { createOAuthState } from '../../../../../workers/main/src/oauth-state';

interface RouteParams {
  params: Promise<{ provider: string }>;
}

interface OAuthEnv {
  SESSIONS: KVNamespace;
  GOOGLE_CLIENT_ID?: string;
  GITHUB_CLIENT_ID?: string;
}

/**
 * GET /api/auth/[provider]
 * Initiates OAuth flow by redirecting to the provider's authorization URL.
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const { provider: providerParam } = await params;

  // Validate provider
  if (!isValidOAuthProvider(providerParam)) {
    return NextResponse.json(
      { error: 'Invalid OAuth provider' },
      { status: 400 }
    );
  }

  const provider = providerParam as OAuthProvider;
  const config = OAUTH_PROVIDERS[provider];

  // Get environment
  const { env } = getCloudflareContext() as unknown as { env: OAuthEnv };

  // Get client ID from environment
  const clientId = env[config.clientIdEnvVar as keyof OAuthEnv] as string | undefined;
  if (!clientId) {
    console.error(`Missing ${config.clientIdEnvVar} environment variable`);
    return NextResponse.json(
      { error: `${config.displayName} sign-in is not configured` },
      { status: 503 }
    );
  }

  // Get redirect URL from query params (for post-auth redirect)
  const searchParams = request.nextUrl.searchParams;
  const redirectUrl = searchParams.get('redirect') || '/';

  // Build callback URL
  const origin = request.nextUrl.origin;
  const callbackUrl = `${origin}/api/auth/${provider}/callback`;

  // Create OAuth state for CSRF protection
  const state = await createOAuthState(env.SESSIONS, provider, redirectUrl);

  // Build authorization URL and redirect
  const authUrl = buildAuthorizationUrl(provider, clientId, callbackUrl, state);

  return NextResponse.redirect(authUrl);
}
