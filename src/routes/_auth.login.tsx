import { useLoaderData } from 'react-router';
import type { Route } from './+types/_auth.login';
import { LoginForm } from '@/components/auth/login-form';

export function meta() {
  return [
    { title: 'Sign In - Chiridion' },
    { name: 'description', content: 'Sign in to your Chiridion account' },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const redirectTo = getSafeRedirect(url.searchParams.get('redirect'));
  return { redirectTo };
}

export default function LoginPage() {
  const { redirectTo } = useLoaderData<typeof loader>();
  return <LoginForm redirectTo={redirectTo} />;
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
