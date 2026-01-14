import { redirect } from 'next/navigation';
import { getSessionContext } from '@/lib/auth-context';
import { SignupForm } from './signup-form';

// Validate redirect URL to prevent open redirects
function getSafeRedirect(redirect: string | null): string {
  if (!redirect) return '/';
  if (redirect.startsWith('/') && !redirect.startsWith('//') && !redirect.includes(':')) {
    return redirect;
  }
  return '/';
}

type PageProps = {
  searchParams: Promise<{ redirect?: string }>;
};

export default async function SignupPage({ searchParams }: PageProps) {
  // Server-side auth check - if already authenticated, redirect immediately
  // This prevents client-side redirect loops
  const session = await getSessionContext();
  const params = await searchParams;
  const redirectTo = getSafeRedirect(params.redirect ?? null);

  if (session) {
    redirect(redirectTo);
  }

  return <SignupForm redirectTo={redirectTo} />;
}
