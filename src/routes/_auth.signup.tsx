import { useLoaderData } from 'react-router';
import type { Route } from './+types/_auth.signup';
import { SignupForm } from '@/components/auth/signup-form';
import { getEnv } from '@/lib/cloudflare.server';
import { getTurnstileAction, shouldBypassTurnstile } from '@/lib/turnstile.server';

export function meta() {
  return [
    { title: 'Sign Up - camelAI' },
    { name: 'description', content: 'Create your camelAI account' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const redirectTo = getSafeRedirect(url.searchParams.get('redirect'));
  const env = getEnv(context);
  const turnstileSiteKey = env.TURNSTILE_SITE_KEY ?? null;
  const emailSignupEnabled =
    shouldBypassTurnstile(env, request.url) ||
    (Boolean(env.TURNSTILE_SITE_KEY) && Boolean(env.TURNSTILE_SECRET_KEY));

  return {
    redirectTo,
    turnstileSiteKey,
    turnstileAction: getTurnstileAction(),
    emailSignupEnabled,
  };
}

export default function SignupPage() {
  const { redirectTo, turnstileSiteKey, turnstileAction, emailSignupEnabled } =
    useLoaderData<typeof loader>();
  return (
    <SignupForm
      redirectTo={redirectTo}
      turnstileSiteKey={turnstileSiteKey}
      turnstileAction={turnstileAction}
      emailSignupEnabled={emailSignupEnabled}
    />
  );
}

function getSafeRedirect(redirect: string | null): string {
  if (!redirect) return '/';
  const pathPart = redirect.split('?')[0];
  if (
    pathPart.startsWith('/') &&
    !pathPart.startsWith('//') &&
    !pathPart.includes(':')
  ) {
    return redirect;
  }
  return '/';
}
