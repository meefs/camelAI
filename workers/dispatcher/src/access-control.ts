const SCRIPT_PREFIX = 'script:';
const SCRIPT_ORG_PREFIX_LEGACY = 'script_org:';

export interface WorkerAccessInfo {
  is_public: boolean;
  org_id: string;
  org_slug?: string;
  is_legacy?: boolean;
  usage_guard_status?: 'active' | 'warned' | 'suspending' | 'suspended' | 'probation' | 'error' | 'exempt';
  usage_guard_reason?: string | null;
  usage_guard_probation_until?: number | null;
}

interface KvReader {
  get(key: string): Promise<string | null>;
}

export type MissingRegistryMode = 'open' | 'legacy-open' | 'closed';

// During migration we default to fail-open. For gradual tightening, use "legacy-open".
export function resolveMissingRegistryMode(rawMode?: string | null): MissingRegistryMode {
  const mode = rawMode?.trim().toLowerCase();
  if (mode === 'legacy-open' || mode === 'legacy_open') {
    return 'legacy-open';
  }
  if (mode === 'closed' || mode === 'fail-closed') {
    return 'closed';
  }
  return 'open';
}

export function shouldFailOpenForMissingRegistry(
  mode: MissingRegistryMode,
  orgSlug: string | null
): boolean {
  if (mode === 'open') return true;
  if (mode === 'legacy-open') return orgSlug === null;
  return false;
}

/**
 * Get worker script access info from KV index.
 * Tries new namespaced format first, then falls back to legacy.
 *
 * Returns:
 * - is_legacy: false - Found in new namespaced format, worker is deployed as {script}--{org-slug}
 * - is_legacy: true, has org_slug - Found in legacy format but was redeployed with new system (redirect candidate)
 * - is_legacy: true, no org_slug - Old worker deployed before org-slug namespacing (serve from legacy dispatch)
 */
export async function getWorkerAccessInfo(
  kv: KvReader,
  dispatchScriptName: string,
  legacyScriptName?: string,
  orgSlug?: string | null
): Promise<WorkerAccessInfo | null> {
  // Try new format first: script:{script-name}--{org-slug}
  let data = await kv.get(`${SCRIPT_PREFIX}${dispatchScriptName}`);
  let primary: WorkerAccessInfo | null = null;
  if (data) {
    primary = { ...(JSON.parse(data) as WorkerAccessInfo), is_legacy: false };
  }

  // Compatibility fallback for historical key writes that used swapped dispatch name.
  // If both keys exist and disagree on visibility, prefer private to avoid leaking a private app.
  if (orgSlug && legacyScriptName) {
    const swappedDispatchScriptName = `${orgSlug}--${legacyScriptName}`;
    if (swappedDispatchScriptName !== dispatchScriptName) {
      const swappedData = await kv.get(`${SCRIPT_PREFIX}${swappedDispatchScriptName}`);
      if (swappedData) {
        const swapped = { ...(JSON.parse(swappedData) as WorkerAccessInfo), is_legacy: false };
        if (!primary) {
          primary = swapped;
        } else if (primary.org_id === swapped.org_id && primary.is_public && !swapped.is_public) {
          primary = { ...primary, is_public: false };
        }
      }
    }
  }

  if (primary) {
    return primary;
  }

  // Fall back to legacy format: script_org:{script-name}
  // Note: New deploys write this with org_slug for legacy URL redirect support.
  if (legacyScriptName) {
    data = await kv.get(`${SCRIPT_ORG_PREFIX_LEGACY}${legacyScriptName}`);
    if (data) {
      const parsed = JSON.parse(data) as WorkerAccessInfo;
      return { ...parsed, is_legacy: true };
    }
  }

  return null;
}
