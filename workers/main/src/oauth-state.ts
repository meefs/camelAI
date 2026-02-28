/**
 * OAuth state management using per-state Durable Objects for CSRF protection.
 * Each OAuth state maps to its own DO instance (no global chokepoint).
 */

import type { OAuthProvider } from '../../../src/lib/oauth-config';
import type { OAuthStateDO, OAuthStateData } from './oauth-state-do.js';

export type OAuthState = OAuthStateData;

type OAuthStateAtomicStub = Pick<OAuthStateDO, 'create' | 'getState' | 'consume' | 'consumeAndGetState'>;

function getOAuthStateStub(
  namespace: DurableObjectNamespace<OAuthStateDO>,
  state: string
): OAuthStateAtomicStub {
  return namespace.get(namespace.idFromName(state)) as unknown as OAuthStateAtomicStub;
}

/**
 * Create a new OAuth state in a dedicated Durable Object instance.
 */
export async function createOAuthState(
  namespace: DurableObjectNamespace<OAuthStateDO>,
  provider: OAuthProvider,
  redirectUrl: string
): Promise<string> {
  const state = crypto.randomUUID();
  await getOAuthStateStub(namespace, state).create(provider, redirectUrl);

  return state;
}

/**
 * Read OAuth state without consuming it.
 * Returns the state data if valid, null if invalid or expired.
 */
export async function getOAuthState(
  namespace: DurableObjectNamespace<OAuthStateDO>,
  state: string
): Promise<OAuthState | null> {
  return await getOAuthStateStub(namespace, state).getState();
}

/**
 * Consume OAuth state after a successful callback.
 */
export async function consumeOAuthState(
  namespace: DurableObjectNamespace<OAuthStateDO>,
  state: string
): Promise<void> {
  await getOAuthStateStub(namespace, state).consume();
}

/**
 * Atomically validate and consume OAuth state.
 * Returns state data when valid; null when missing/expired/already-consumed.
 */
export async function consumeOAuthStateWithData(
  namespace: DurableObjectNamespace<OAuthStateDO>,
  state: string
): Promise<OAuthState | null> {
  return await getOAuthStateStub(namespace, state).consumeAndGetState();
}
