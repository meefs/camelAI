import { DurableObject } from 'cloudflare:workers';
import type { OAuthProvider } from '../../../src/lib/oauth-config';

export interface OAuthStateData {
  provider: OAuthProvider;
  redirect_url: string;
  created_at: number;
}

const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;
const OAUTH_STATE_KEY = 'state';

export class OAuthStateDO extends DurableObject {
  async create(provider: OAuthProvider, redirectUrl: string): Promise<void> {
    const state: OAuthStateData = {
      provider,
      redirect_url: redirectUrl,
      created_at: Date.now(),
    };

    this.ctx.storage.kv.put(OAUTH_STATE_KEY, state);
    await this.ctx.storage.setAlarm(state.created_at + OAUTH_STATE_TTL_MS);
  }

  getState(): OAuthStateData | null {
    const state = this.ctx.storage.kv.get<OAuthStateData>(OAUTH_STATE_KEY);
    if (!state) {
      return null;
    }

    if (Date.now() - state.created_at > OAUTH_STATE_TTL_MS) {
      this.ctx.storage.kv.delete(OAUTH_STATE_KEY);
      return null;
    }

    return state;
  }

  consume(): boolean {
    const state = this.getState();
    if (!state) {
      return false;
    }

    this.ctx.storage.kv.delete(OAUTH_STATE_KEY);
    return true;
  }

  consumeAndGetState(): OAuthStateData | null {
    const state = this.getState();
    if (!state) {
      return null;
    }

    this.ctx.storage.kv.delete(OAUTH_STATE_KEY);
    return state;
  }

  alarm(): void {
    this.ctx.storage.kv.delete(OAUTH_STATE_KEY);
  }
}
