'use client';

import { useContext } from 'react';
import { UNSAFE_DataRouterStateContext } from 'react-router';
import type { AuthState } from '@/types';

const APP_ROUTE_ID = 'routes/_app';

function getAuthStateFromRouter(): AuthState | null {
  const routerState = useContext(UNSAFE_DataRouterStateContext);
  const routeData = routerState?.loaderData?.[APP_ROUTE_ID] as
    | { authState?: AuthState }
    | undefined;
  return routeData?.authState ?? null;
}

/**
 * Hook to access auth data from the _app layout loader.
 * This is the recommended way to access auth state in components.
 *
 * Data comes from the server loader and is automatically revalidated
 * after mutations (logout, switch-workspace, etc.)
 */
export function useAuthData(): AuthState {
  const authState = getAuthStateFromRouter();
  if (!authState) {
    throw new Error('useAuthData must be used within a route under _app layout');
  }
  return authState;
}

/**
 * Optional version that returns null instead of throwing when used
 * outside the _app layout (e.g., in auth pages).
 */
export function useOptionalAuthData(): AuthState | null {
  return getAuthStateFromRouter();
}
