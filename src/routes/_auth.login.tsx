import { useLoaderData } from 'react-router';
import type { Route } from './+types/_auth.login';
import { LoginForm } from '@/components/auth/login-form';

export function meta() {
  return [
    { title: 'Sign In - camelAI' },
    { name: 'description', content: 'Sign in to your camelAI account' },
  ];
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_denied: 'You cancelled the sign-in.',
  oauth_state_invalid: 'Sign-in expired. Please try again.',
  oauth_race_condition: 'Sign-in conflict. Please try again.',
  oauth_failed: 'Sign-in failed. Please try again.',
  oauth_invalid: 'Invalid sign-in response. Please try again.',
  oauth_config: 'OAuth is not configured. Please contact support.',
};

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const redirectTo = getSafeRedirect(url.searchParams.get('redirect'));
  const errorCode = url.searchParams.get('error');
  const oauthError = errorCode ? OAUTH_ERROR_MESSAGES[errorCode] ?? null : null;
  return { redirectTo, oauthError };
}

export default function LoginPage() {
  const { redirectTo, oauthError } = useLoaderData<typeof loader>();
  return <LoginForm redirectTo={redirectTo} oauthError={oauthError} />;
}

function getSafeRedirect(redirect: string | null): string {
  if (!redirect) return '/';
  if (
    redirect.startsWith('/') &&
    !redirect.startsWith('//') &&
    !redirect.includes(':')
  ) {
    return redirect;
  }
  return '/';
}
