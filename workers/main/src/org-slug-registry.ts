import { DurableObject } from 'cloudflare:workers';

export interface SlugOwnerRecord {
  orgId: string;
  claimedAt: number;
}

interface ClaimResult {
  ok: boolean;
  owner: string | null;
}

export interface OrgSlugD1MigrationExport {
  exportVersion: 1;
  exportedAt: number;
  owner: SlugOwnerRecord | null;
}

/**
 * Durable Object keyed by slug value for race-safe slug ownership.
 * Each instance stores exactly one owner record.
 */
export class OrgSlugDO extends DurableObject {
  getOwner(): string | null {
    const record = this.ctx.storage.kv.get<SlugOwnerRecord>('owner');
    return record?.orgId ?? null;
  }

  claim(orgId: string): ClaimResult {
    if (!orgId) {
      throw new Error('orgId is required');
    }

    const existing = this.ctx.storage.kv.get<SlugOwnerRecord>('owner');
    if (existing && existing.orgId !== orgId) {
      return { ok: false, owner: existing.orgId };
    }

    if (!existing) {
      this.ctx.storage.kv.put('owner', {
        orgId,
        claimedAt: Date.now(),
      } satisfies SlugOwnerRecord);
    }

    return { ok: true, owner: orgId };
  }

  release(orgId: string): boolean {
    if (!orgId) {
      throw new Error('orgId is required');
    }

    const existing = this.ctx.storage.kv.get<SlugOwnerRecord>('owner');
    if (!existing) {
      return false;
    }
    if (existing.orgId !== orgId) {
      return false;
    }

    this.ctx.storage.kv.delete('owner');
    return true;
  }

  exportD1MigrationRecord(): OrgSlugD1MigrationExport {
    return {
      exportVersion: 1,
      exportedAt: Date.now(),
      owner: this.ctx.storage.kv.get<SlugOwnerRecord>('owner') ?? null,
    };
  }
}
