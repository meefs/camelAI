import { redirect } from 'next/navigation';
import { getSessionContext } from '@/lib/auth-context';
import { LoginForm } from './login-form';

// Validate redirect URL to prevent open redirects
function getSafeRedirect(redirect: string | null): string {
  if (!redirect) return '/';
  // Must start with single slash and not be a protocol-relative URL
  if (redirect.startsWith('/') && !redirect.startsWith('//') && !redirect.includes(':')) {
    return redirect;
  }
  return '/';
}

type PageProps = {
  searchParams: Promise<{ redirect?: string }>;
};

export default async function LoginPage({ searchParams }: PageProps) {
  // Server-side auth check - if already authenticated, redirect immediately
  // This prevents client-side redirect loops
  const session = await getSessionContext();
  const params = await searchParams;
  const redirectTo = getSafeRedirect(params.redirect ?? null);

  if (session) {
    redirect(redirectTo);
  }

  return <LoginForm redirectTo={redirectTo} />;
}
