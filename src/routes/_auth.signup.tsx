import { useLoaderData } from 'react-router';
import type { Route } from './+types/_auth.signup';
import { SignupForm } from '@/components/auth/signup-form';

export function meta() {
  return [
    { title: 'Sign Up - camelAI' },
    { name: 'description', content: 'Create your camelAI account' },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const redirectTo = getSafeRedirect(url.searchParams.get('redirect'));
  return { redirectTo };
}

export default function SignupPage() {
  const { redirectTo } = useLoaderData<typeof loader>();
  return <SignupForm redirectTo={redirectTo} />;
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
