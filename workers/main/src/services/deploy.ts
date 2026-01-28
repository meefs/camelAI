/**
 * Deploy side effects service
 */

import { SCRIPT_ORG_PREFIX, type Env } from '../types.js';
import type { DeploySideEffectsInfo } from '../cf-api-proxy.js';
import type { AppScreenshotJob } from '../screenshot-queue.js';
import { resolveEnvPrefix } from '../cf-api-proxy.js';
import { captureScreenshot } from '../screenshot-queue.js';
import { createScreenshotToken } from '../worker-auth.js';
import { getOrgStub } from '../helpers/stubs.js';

export async function handleDeploySideEffects(env: Env, info: DeploySideEffectsInfo): Promise<void> {
  const { scriptName, orgId, workspaceId, hostname, threadId, configPath } = info;
  const orgStub = getOrgStub(env, orgId);

  // Register ownership
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
  await env.API_TOKENS.put(
    `${SCRIPT_ORG_PREFIX}${scriptName}`,
    JSON.stringify({ org_id: orgId, is_public: script.is_public })
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
  const jobBase: AppScreenshotJob = {
    script_name: scriptName,
    org_id: orgId,
    workspace_id: workspaceId,
    deploy_ts: script.updated_at,
    env_prefix: envPrefix,
    is_public: script.is_public,
  };

  if (envPrefix === 'local') {
    await captureScreenshot(env, jobBase);
    return;
  }

  if (!env.APP_SCREENSHOT_QUEUE) return;

  const screenshotToken = script.is_public
    ? undefined
    : await createScreenshotToken(env.API_TOKENS, { script_name: scriptName, org_id: orgId });

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
