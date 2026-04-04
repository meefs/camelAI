'use client';

import { useRouteLoaderData } from 'react-router';
import type { AuthState } from '@/types';

/**
 * Hook to access auth data from the _app layout loader.
 * This is the recommended way to access auth state in components.
 *
 * Data comes from the server loader and is automatically revalidated
 * after mutations (logout, switch-workspace, etc.)
 */
export function useAuthData(): AuthState {
  const data = useRouteLoaderData('routes/_app') as { authState: AuthState } | undefined;
  if (!data?.authState) {
    throw new Error('useAuthData must be used within a route under _app layout');
  }
  return data.authState;
}

/**
 * Optional version that returns null instead of throwing when used
 * outside the _app layout (e.g., in auth pages).
 */
export function useOptionalAuthData(): AuthState | null {
  const data = useRouteLoaderData('routes/_app') as { authState: AuthState } | undefined;
  return data?.authState ?? null;
}
