import { describe, it, expect } from 'vitest';
import {
  createOAuthState,
  getOAuthState,
  consumeOAuthState,
  consumeOAuthStateWithData,
} from '../src/oauth-state.js';
import type { OAuthStateDO } from '../src/oauth-state-do.js';

interface StoredOAuthState {
  provider: 'google' | 'github';
  redirect_url: string;
  created_at: number;
}

function createMockOAuthStateNamespace(): DurableObjectNamespace {
  const store = new Map<string, StoredOAuthState>();
  const ids = new Map<string, DurableObjectId>();
  const namesById = new Map<string, string>();
  let idCounter = 0;

  const createId = (name: string): DurableObjectId => {
    const idString = `id-${++idCounter}`;
    const id = {
      toString: () => idString,
      equals: () => false,
      name,
    } as unknown as DurableObjectId;
    ids.set(name, id);
    namesById.set(id.toString(), name);
    return id;
  };

  return {
    idFromName(name: string): DurableObjectId {
      return ids.get(name) ?? createId(name);
    },
    get(id: DurableObjectId): DurableObjectStub {
      const idString = id.toString();
      const name = namesById.get(idString);
      if (!name) {
        throw new Error(`Missing stub mapping for id ${idString}`);
      }

      return {
        async create(provider: 'google' | 'github', redirectUrl: string): Promise<void> {
          store.set(name, {
            provider,
            redirect_url: redirectUrl,
            created_at: Date.now(),
          });
        },
        async getState(): Promise<StoredOAuthState | null> {
          return store.get(name) ?? null;
        },
        async consume(): Promise<boolean> {
          const exists = store.has(name);
          store.delete(name);
          return exists;
        },
        async consumeAndGetState(): Promise<StoredOAuthState | null> {
          const value = store.get(name) ?? null;
          if (value) {
            store.delete(name);
          }
          return value;
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

describe('OAuth state lifecycle', () => {
  it('reads state without consuming it', async () => {
    const namespace = createMockOAuthStateNamespace() as unknown as DurableObjectNamespace<OAuthStateDO>;
    const state = await createOAuthState(namespace, 'google', '/chat');

    const firstRead = await getOAuthState(namespace, state);
    const secondRead = await getOAuthState(namespace, state);

    expect(firstRead).not.toBeNull();
    expect(firstRead?.provider).toBe('google');
    expect(firstRead?.redirect_url).toBe('/chat');
    expect(secondRead).not.toBeNull();
  });

  it('consumes state only when requested', async () => {
    const namespace = createMockOAuthStateNamespace() as unknown as DurableObjectNamespace<OAuthStateDO>;
    const state = await createOAuthState(namespace, 'github', '/');

    await consumeOAuthState(namespace, state);
    const afterConsume = await getOAuthState(namespace, state);

    expect(afterConsume).toBeNull();
  });

  it('atomically consumes and returns state only once', async () => {
    const namespace = createMockOAuthStateNamespace() as unknown as DurableObjectNamespace<OAuthStateDO>;
    const state = await createOAuthState(namespace, 'google', '/login');

    const firstConsume = await consumeOAuthStateWithData(namespace, state);
    const secondConsume = await consumeOAuthStateWithData(namespace, state);

    expect(firstConsume).not.toBeNull();
    expect(firstConsume?.provider).toBe('google');
    expect(secondConsume).toBeNull();
  });
});
