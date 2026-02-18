/**
 * Deploy side effects service
 */

import { type Env } from '../types.js';
import type { DeploySideEffectsInfo } from '../cf-api-proxy.js';
import type { AppScreenshotJob } from '../screenshot-queue.js';
import { resolveEnvPrefix } from '../cf-api-proxy.js';
import { createScreenshotToken } from '../worker-auth.js';
import { getOrgStub } from '../helpers/stubs.js';

// KV key prefix for script access info (namespaced by org-slug)
const SCRIPT_PREFIX = 'script:';
// Legacy KV key prefix (for backwards compatibility and legacy URL redirect)
const SCRIPT_ORG_PREFIX_LEGACY = 'script_org:';

export async function handleDeploySideEffects(env: Env, info: DeploySideEffectsInfo): Promise<void> {
  const { scriptName, dispatchScriptName, orgId, orgSlug, workspaceId, hostname, threadId, configPath } = info;
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

  const script = await orgStub.registerWorkerScript(scriptName, workspaceId, createdBy, configPath);

  // Store in KV with namespaced key: script:{script-name}--{org-slug}
  // This allows the dispatcher to look up access info by dispatchScriptName
  await env.APP_KV.put(
    `${SCRIPT_PREFIX}${dispatchScriptName}`,
    JSON.stringify({ org_id: orgId, org_slug: orgSlug, is_public: script.is_public })
  );

  // Also write legacy format for legacy URL redirect support.
  // When someone uses a legacy URL (script.camelai.app), the dispatcher can
  // look this up and redirect to the new URL format (script--org-slug.camelai.app).
  // Note: If multiple orgs deploy workers with the same name, this entry gets overwritten.
  // That's acceptable since this is only for redirect purposes - the primary lookup
  // uses the namespaced format which is unique per org.
  await env.APP_KV.put(
    `${SCRIPT_ORG_PREFIX_LEGACY}${scriptName}`,
    JSON.stringify({ org_id: orgId, org_slug: orgSlug, is_public: script.is_public })
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

  const screenshotToken = script.is_public
    ? undefined
    : await createScreenshotToken(env.APP_KV, { script_name: scriptName, org_id: orgId });

  try {
    await env.APP_SCREENSHOT_QUEUE.send(
      { ...jobBase, ...(screenshotToken ? { screenshot_token: screenshotToken } : {}) },
      { contentType: 'json', messageId: `${scriptName}:${script.updated_at}` }
    );
  } catch (err) {
    await orgStub.updateWorkerScriptPreview(scriptName, {
      status: 'failed',
      preview_key: null,
      preview_error: String(err),
      deploy_ts: script.updated_at,
    });
  }
}
