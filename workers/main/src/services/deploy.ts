/**
 * Deploy side effects service
 */

import { type Env } from '../types.js';
import type { DeploySideEffectsInfo } from '../cf-api-proxy.js';
import type { AppScreenshotJob } from '../screenshot-queue.js';
import {
  resolveEnvPrefix,
} from '../cf-api-proxy.js';
import { getOrgStub } from '../helpers/stubs.js';
import {
  isUsageGuardRecovery,
  markUsageGuardEligible,
  type UsageGuardRegistryFields,
} from '../usage-guard-state.js';

// KV key prefix for script access info (namespaced by org-slug)
const SCRIPT_PREFIX = 'script:';
// Legacy KV key prefix (for backwards compatibility and legacy URL redirect)
const SCRIPT_ORG_PREFIX_LEGACY = 'script_org:';

export async function handleDeploySideEffects(env: Env, info: DeploySideEffectsInfo): Promise<void> {
  const { scriptName, dispatchScriptName, orgId, orgSlug, workspaceId, hostname, threadId, projectId, configPath, commitSha, artifactCacheKey, scriptVersion } = info;
  const orgStub = getOrgStub(env, orgId);

  // Register ownership (stores user-facing scriptName in OrgDO)
  let createdBy = 'system:deploy';
  if (threadId) {
    try {
      const thread = await orgStub.getThread(threadId);
      if (thread?.created_by && thread.workspace_id === workspaceId) {
        createdBy = thread.created_by;
      }
    } catch {}
  }

  const script = await orgStub.registerWorkerScript(scriptName, workspaceId, createdBy, configPath, projectId, commitSha, artifactCacheKey);

  const primaryRegistryKey = `${SCRIPT_PREFIX}${dispatchScriptName}`;
  let existingRegistry: (UsageGuardRegistryFields & { org_id?: string; org_slug?: string; is_public?: boolean }) | null = null;
  try {
    const stored = await env.APP_KV.get(primaryRegistryKey);
    existingRegistry = stored ? JSON.parse(stored) : null;
  } catch (error) {
    console.warn('[deploy] failed to parse existing app registry state', {
      dispatchScriptName,
      error: String(error),
    });
  }

  let usageGuardFields: UsageGuardRegistryFields = existingRegistry?.usage_guard_status
    ? {
        usage_guard_status: existingRegistry.usage_guard_status,
        usage_guard_eligible_version: existingRegistry.usage_guard_eligible_version,
        usage_guard_eligible_at: existingRegistry.usage_guard_eligible_at,
        usage_guard_probation_until: existingRegistry.usage_guard_probation_until,
        usage_guard_reason: existingRegistry.usage_guard_reason,
      }
    : {};
  if (scriptVersion && env.APP_DB) {
    const recovering = isUsageGuardRecovery(existingRegistry?.usage_guard_status);
    const eligibility = await markUsageGuardEligible({
      db: env.APP_DB,
      appId: `${orgId}:${scriptName}`,
      dispatchScriptName,
      orgId,
      workspaceId,
      scriptName,
      scriptVersion,
      artifactCacheKey,
      recovering,
    });
    usageGuardFields = {
      usage_guard_status: eligibility.status,
      usage_guard_eligible_version: scriptVersion,
      usage_guard_eligible_at: Date.now(),
      usage_guard_probation_until: eligibility.probationUntil,
      usage_guard_reason: null,
    };
  }

  // Store in KV with namespaced key: script:{script-name}--{org-slug}
  // This allows the dispatcher to look up access info by dispatchScriptName
  await env.APP_KV.put(
    primaryRegistryKey,
    JSON.stringify({ org_id: orgId, org_slug: orgSlug, is_public: script.is_public, ...usageGuardFields })
  );

  // Also write legacy format for legacy URL redirect support.
  // When someone uses a legacy URL (script.camelai.app), the dispatcher can
  // look this up and redirect to the new URL format (script--org-slug.camelai.app).
  // Note: If multiple orgs deploy workers with the same name, this entry gets overwritten.
  // That's acceptable since this is only for redirect purposes - the primary lookup
  // uses the namespaced format which is unique per org.
  await env.APP_KV.put(
    `${SCRIPT_ORG_PREFIX_LEGACY}${scriptName}`,
    JSON.stringify({ org_id: orgId, org_slug: orgSlug, is_public: script.is_public, ...usageGuardFields })
  );

  // Update preview status
  const envPrefix = resolveEnvPrefix(env.WORKER_BASE_URL, hostname);
  const previewResult = await orgStub.updateWorkerScriptPreview(scriptName, {
    status: 'pending',
    preview_key: null,
    preview_error: null,
    deploy_ts: script.updated_at,
  });

  if (previewResult.stale) return;

  // Queue screenshot
  if (!env.APP_SCREENSHOT_QUEUE) return;

  const jobBase: AppScreenshotJob = {
    script_name: scriptName,
    org_id: orgId,
    org_slug: orgSlug,
    workspace_id: workspaceId,
    deploy_ts: script.updated_at,
    env_prefix: envPrefix,
    is_public: script.is_public,
  };

  try {
    const sendOptions = {
      contentType: 'json',
      messageId: `${scriptName}:${script.updated_at}`,
    } as unknown as QueueSendOptions;
    await env.APP_SCREENSHOT_QUEUE.send(jobBase, sendOptions);
  } catch (err) {
    await orgStub.updateWorkerScriptPreview(scriptName, {
      status: 'failed',
      preview_key: null,
      preview_error: String(err),
      deploy_ts: script.updated_at,
    });
  }
}
