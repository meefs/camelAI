import type { Route } from './+types/ext.oauth.authorize';
import { redirect, data } from 'react-router';
import { getEnv } from '@/lib/cloudflare.server';
import { getOAuth, err, OAuthError, CLI_REDIRECT_URI, verifyWorkspaceAccess, listUserWorkspaces } from '@/lib/ext-api.server';
import { getSignedSessionFromRequest } from '../../../workers/main/src/cookies';

function parseParams(request: Request, url: URL): URLSearchParams {
  if (request.method === 'POST') {
    // For POST, params come from the form body — but we can't read it in loader.
    // The form posts to the same URL with query params, so use those.
    return url.searchParams;
  }
  return url.searchParams;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const oauth = getOAuth(env);
  if (!oauth) return err('External API not configured', 503);

  const url = new URL(request.url);
  const params = url.searchParams;

  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const responseType = params.get('response_type');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method');
  const state = params.get('state') ?? '';
  const scope = params.get('scope') ?? 'workspace';

  if (!clientId || !redirectUri || responseType !== 'code')
    return new OAuthError('invalid_request', 'Missing required parameters').toResponse();
  if (!codeChallenge)
    return new OAuthError('invalid_request', 'code_challenge is required').toResponse();
  if (codeChallengeMethod !== 'S256')
    return new OAuthError('invalid_request', 'Only S256 supported').toResponse();
  if (!oauth.validateClient(clientId))
    return new OAuthError('invalid_client', 'Unknown client_id').toResponse();
  if (redirectUri !== CLI_REDIRECT_URI)
    return new OAuthError('invalid_request', 'Invalid redirect_uri').toResponse();

  const session = await getSignedSessionFromRequest(request, env.TOKEN_SIGNING_SECRET);
  if (!session) {
    return redirect(`/login?redirect=${encodeURIComponent(url.pathname + url.search)}`);
  }

  const workspaces = await listUserWorkspaces(env, session.user_id, session.org_id);

  return {
    clientId, redirectUri, codeChallenge, codeChallengeMethod: codeChallengeMethod ?? '',
    state, scope,
    userName: session.user_name ?? session.user_email ?? session.user_id,
    workspaces,
    authorizeUrl: url.pathname + url.search,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const env = getEnv(context);
  const oauth = getOAuth(env);
  if (!oauth) return err('External API not configured', 503);

  const url = new URL(request.url);
  const formData = new URLSearchParams(await request.text());
  // Merge query params
  for (const [k, v] of url.searchParams) { if (!formData.has(k)) formData.set(k, v); }

  const clientId = formData.get('client_id');
  const redirectUri = formData.get('redirect_uri');
  const codeChallenge = formData.get('code_challenge');
  const state = formData.get('state') ?? undefined;
  const scope = formData.get('scope');
  const workspaceId = formData.get('workspace_id');

  if (!clientId || !redirectUri || !codeChallenge)
    return new OAuthError('invalid_request', 'Missing required parameters').toResponse();
  if (!oauth.validateClient(clientId))
    return new OAuthError('invalid_client', 'Unknown client_id').toResponse();
  if (!workspaceId)
    return new OAuthError('invalid_request', 'No workspace selected').toResponse();

  const session = await getSignedSessionFromRequest(request, env.TOKEN_SIGNING_SECRET);
  if (!session) return new OAuthError('invalid_request', 'Not authenticated').toResponse(401);

  const ok = await verifyWorkspaceAccess(env, session.user_id, session.org_id, workspaceId);
  if (!ok) return new OAuthError('access_denied', 'No access to this workspace').toResponse();

  const code = await oauth.createAuthorizationCode({
    client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge,
    scopes: scope ? scope.split(' ') : ['workspace'],
    user_id: session.user_id, org_id: session.org_id, workspace_id: workspaceId, state,
  });

  const cb = new URL(redirectUri);
  cb.searchParams.set('code', code);
  if (state) cb.searchParams.set('state', state);
  return redirect(cb.toString());
}

export default function AuthorizePage({ loaderData }: Route.ComponentProps) {
  const d = loaderData as any;
  if (!d?.workspaces) return null;

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight">Authorize Access</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">camelAI CLI</span>{' '}
          wants to access your workspace.
        </p>

        <form method="POST" action={d.authorizeUrl} className="mt-5 space-y-4">
          <input type="hidden" name="client_id" value={d.clientId} />
          <input type="hidden" name="redirect_uri" value={d.redirectUri} />
          <input type="hidden" name="response_type" value="code" />
          <input type="hidden" name="code_challenge" value={d.codeChallenge} />
          <input type="hidden" name="code_challenge_method" value={d.codeChallengeMethod} />
          <input type="hidden" name="state" value={d.state} />
          <input type="hidden" name="scope" value={d.scope} />

          <div>
            <label htmlFor="workspace_id" className="text-sm font-medium text-muted-foreground">
              Workspace
            </label>
            <select
              name="workspace_id"
              id="workspace_id"
              required
              className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="" disabled selected>Select a workspace…</option>
              {d.workspaces.map((ws: any) => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
          </div>

          <div className="rounded-lg border bg-muted/50 p-3 text-xs">
            <p className="font-medium uppercase tracking-wider text-muted-foreground">This will allow</p>
            <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
              <li>Execute commands in your workspace</li>
              <li>Read and write files</li>
              <li>List and manage deployed apps</li>
            </ul>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => window.close()}
              className="flex-1 rounded-lg border bg-background px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Authorize
            </button>
          </div>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Signed in as {d.userName}
        </p>
      </div>
    </div>
  );
}
