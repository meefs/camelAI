import puppeteer, { type Page } from '@cloudflare/puppeteer';
import { createScreenshotToken } from './worker-auth.js';
import type { OrgDO } from './auth.js';

export interface AppScreenshotJob {
  script_name: string;
  org_id: string;
  workspace_id: string;
  deploy_ts: number;
  env_prefix: string;
  is_public: boolean;
  screenshot_token?: string;
}

export interface ScreenshotEnv {
  BROWSER?: Fetcher;
  R2_BUCKET: R2Bucket;
  API_TOKENS: KVNamespace;
  LOCAL_APP_PREVIEW_URL?: string;
  ORG: DurableObjectNamespace<OrgDO>;
}

const VIEWPORT = {
  width: 1280,
  height: 720,
  deviceScaleFactor: 1.5,
};
const SCREENSHOT_CLIP = {
  x: 0,
  y: 0,
  width: VIEWPORT.width,
  height: VIEWPORT.height,
};

const PREVIEW_PREFIX = 'app-previews';
const LOCAL_PREVIEW_URL = 'https://hello-world-test.chiridion.app/';
const NAVIGATION_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 1500;
const POST_LOAD_DELAY_MS = 600;
const MAX_SCREENSHOT_RETRIES = 3;

function getLocalPreviewUrl(env: ScreenshotEnv): string {
  const override = env.LOCAL_APP_PREVIEW_URL?.trim();
  return override ? override : LOCAL_PREVIEW_URL;
}

function buildTargetUrl(job: AppScreenshotJob, env: ScreenshotEnv): string | null {
  if (job.env_prefix === 'local') {
    return getLocalPreviewUrl(env);
  }
  const suffix = job.env_prefix ? `apps.${job.env_prefix}.chiridion.ai` : 'apps.chiridion.ai';
  return `https://${job.script_name}.${suffix}`;
}

function buildPreviewKeys(job: AppScreenshotJob): { currentKey: string; versionedKey: string } {
  const base = `${PREVIEW_PREFIX}/${job.org_id}/${job.workspace_id}/${job.script_name}`;
  return {
    currentKey: `${base}/current.jpg`,
    versionedKey: `${base}/${job.deploy_ts}.jpg`,
  };
}

function truncateError(err: unknown, maxLength = 500): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength)}...`;
}

async function navigateWithFallback(page: Page, targetUrl: string, logContext: Record<string, unknown>) {
  try {
    const response = await page.goto(targetUrl, {
      waitUntil: 'networkidle0',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    return { response, waitUntil: 'networkidle0' as const };
  } catch (err) {
    console.warn('[app-screenshot] navigation fallback', {
      ...logContext,
      error: truncateError(err),
      from: 'networkidle0',
      to: 'domcontentloaded',
    });
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    return { response, waitUntil: 'domcontentloaded' as const };
  }
}

async function waitForReadySignal(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const root = document.documentElement;
        if (root?.dataset?.chiridionReady === 'true') return true;
        if (document.body?.dataset?.chiridionReady === 'true') return true;
        return Boolean(document.querySelector('[data-chiridion-ready="true"]'));
      },
      { timeout: READY_TIMEOUT_MS }
    );
  } catch {
    // Optional signal - ignore timeout.
  }
}

export async function captureScreenshot(
  env: ScreenshotEnv,
  job: AppScreenshotJob,
  screenshotToken?: string
): Promise<{ success: boolean; error?: string }> {
  const orgStub = env.ORG.get(env.ORG.idFromName(job.org_id));

  if (!env.BROWSER) {
    const errorMessage = 'Missing BROWSER binding for screenshot capture.';
    await orgStub.updateWorkerScriptPreview(job.script_name, {
      status: 'failed',
      preview_key: null,
      preview_error: errorMessage,
      deploy_ts: job.deploy_ts,
    });
    return { success: false, error: errorMessage };
  }

  const targetUrl = buildTargetUrl(job, env);
  if (!targetUrl) {
    return { success: false, error: 'Could not build target URL' };
  }

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  let page: Page | null = null;

  try {
    browser = await puppeteer.launch(env.BROWSER);
    page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    if (screenshotToken && job.env_prefix !== 'local') {
      await page.setExtraHTTPHeaders({
        'x-chiridion-screenshot-token': screenshotToken,
      });
    }

    const { response, waitUntil } = await navigateWithFallback(page, targetUrl, {
      scriptName: job.script_name,
      orgId: job.org_id,
    });

    console.log('[app-screenshot] navigation complete', {
      scriptName: job.script_name,
      orgId: job.org_id,
      status: response?.status() ?? null,
      waitUntil,
    });

    if (response && !response.ok()) {
      const statusText = typeof response.statusText === 'function' ? response.statusText() : '';
      throw new Error(
        `Navigation failed with status ${response.status()}${statusText ? ` ${statusText}` : ''} for ${targetUrl}`
      );
    }

    await page.addStyleTag({ content: 'body { overflow: hidden !important; }' });
    await waitForReadySignal(page);
    await page.waitForTimeout(POST_LOAD_DELAY_MS);
    await page.evaluate(() => window.scrollTo(0, 0));

    const image = (await page.screenshot({
      type: 'jpeg',
      quality: 80,
      clip: SCREENSHOT_CLIP,
    })) as Buffer;

    const { currentKey, versionedKey } = buildPreviewKeys(job);
    await env.R2_BUCKET.put(versionedKey, image, {
      httpMetadata: {
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: {
        script_name: job.script_name,
        org_id: job.org_id,
        workspace_id: job.workspace_id,
        deploy_ts: String(job.deploy_ts),
      },
    });
    await env.R2_BUCKET.put(currentKey, image, {
      httpMetadata: {
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=300',
      },
      customMetadata: {
        script_name: job.script_name,
        org_id: job.org_id,
        workspace_id: job.workspace_id,
        deploy_ts: String(job.deploy_ts),
      },
    });

    const updateResult = await orgStub.updateWorkerScriptPreview(job.script_name, {
      status: 'ready',
      preview_key: currentKey,
      preview_error: null,
      deploy_ts: job.deploy_ts,
    });

    if (updateResult.stale) {
      console.log('[app-screenshot] preview update skipped (stale)', {
        scriptName: job.script_name,
        orgId: job.org_id,
      });
    } else if (!updateResult.updated) {
      console.warn('[app-screenshot] preview update skipped (columns missing or script not found)', {
        scriptName: job.script_name,
        orgId: job.org_id,
        scriptExists: !!updateResult.script,
      });
    }

    console.log('[app-screenshot] captured preview', {
      scriptName: job.script_name,
      orgId: job.org_id,
      targetUrl,
    });

    return { success: true };
  } catch (err) {
    const errorMessage = truncateError(err);
    console.error('[app-screenshot] capture failed', {
      scriptName: job.script_name,
      orgId: job.org_id,
      error: errorMessage,
    });

    await orgStub.updateWorkerScriptPreview(job.script_name, {
      status: 'failed',
      preview_key: null,
      preview_error: errorMessage,
      deploy_ts: job.deploy_ts,
    });

    return { success: false, error: errorMessage };
  } finally {
    if (page) {
      await page.close();
    }
    if (browser) {
      await browser.close();
    }
  }
}

export async function handleScreenshotQueue(
  batch: MessageBatch<AppScreenshotJob>,
  env: ScreenshotEnv
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    const attempt = message.attempts ?? 1;

    if (!job?.script_name || !job.org_id || !job.workspace_id) {
      console.warn('[app-screenshot] invalid job payload', { job });
      message.ack();
      continue;
    }

    try {
      const orgStub = env.ORG.get(env.ORG.idFromName(job.org_id));
      const script = await orgStub.getWorkerScript(job.script_name);

      if (!script) {
        console.warn('[app-screenshot] script not found, skipping', {
          scriptName: job.script_name,
          orgId: job.org_id,
        });
        message.ack();
        continue;
      }

      if (job.deploy_ts < script.updated_at) {
        console.log('[app-screenshot] stale job, skipping', {
          scriptName: job.script_name,
          orgId: job.org_id,
          deployTs: job.deploy_ts,
          updatedAt: script.updated_at,
        });
        message.ack();
        continue;
      }

      console.log('[app-screenshot] processing job', {
        scriptName: job.script_name,
        orgId: job.org_id,
        envPrefix: job.env_prefix,
        attempt,
      });

      let screenshotToken = job.screenshot_token;
      if (!job.is_public && job.env_prefix !== 'local') {
        if (!screenshotToken || attempt > 1) {
          screenshotToken = await createScreenshotToken(env.API_TOKENS, {
            script_name: job.script_name,
            org_id: job.org_id,
          });
        }
      } else {
        screenshotToken = undefined;
      }

      const result = await captureScreenshot(env, job, screenshotToken);

      if (result.success) {
        message.ack();
      } else if (attempt >= MAX_SCREENSHOT_RETRIES) {
        console.warn('[app-screenshot] max retries reached, acking', {
          scriptName: job.script_name,
          orgId: job.org_id,
          attempts: attempt,
        });
        message.ack();
      } else {
        message.retry();
      }
    } catch (err) {
      console.error('[app-screenshot] unexpected error', {
        scriptName: job.script_name,
        orgId: job.org_id,
        error: String(err),
      });

      if ((message.attempts ?? 1) >= MAX_SCREENSHOT_RETRIES) {
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}
