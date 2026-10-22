import { safeRedirectPath } from "@/lib/safe-redirect";
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
  const redirectTo = safeRedirectPath(url.searchParams.get('redirect'));
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
