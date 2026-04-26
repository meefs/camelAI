import type { Browser, Page } from '@cloudflare/puppeteer';
import { createScreenshotToken } from './worker-auth.js';
import type { OrgDO } from './auth.js';

export interface AppScreenshotJob {
  script_name: string;
  org_id: string;
  org_slug?: string; // Optional for backward compat with queued messages
  workspace_id: string;
  deploy_ts: number;
  env_prefix: string;
  is_public: boolean;
  screenshot_token?: string;
}

export interface ScreenshotEnv {
  BROWSER?: Fetcher;
  R2_BUCKET: R2Bucket;
  APP_KV: KVNamespace;
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
const NAVIGATION_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 1500;
const POST_LOAD_DELAY_MS = 600;
const MAX_SCREENSHOT_RETRIES = 3;
const RAW_CAPTURE_TIMEOUT_MS = 10_000;

function buildTargetUrl(job: AppScreenshotJob): string {
  const suffix = job.env_prefix ? `apps.${job.env_prefix}.camelai.dev` : 'apps.camelai.dev';
  // Fall back to legacy format if org_slug is missing (for queued messages before this change)
  if (job.org_slug) {
    const separator = isNewStyleOrgSlug(job.org_slug) ? '-' : '--';
    return `https://${job.script_name}${separator}${job.org_slug}.${suffix}`;
  }
  return `https://${job.script_name}.${suffix}`;
}

/** New-style org slugs are 6+ purely alphanumeric characters (no hyphens). */
function isNewStyleOrgSlug(slug: string): boolean {
  return /^[a-z0-9]{6,}$/.test(slug);
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

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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

  const targetUrl = buildTargetUrl(job);

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    const { default: puppeteer } = await import('@cloudflare/puppeteer');
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

    await page.addStyleTag({
      content: `
        body { overflow: hidden !important; }
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          animation-delay: 0.01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
          transition-delay: 0.01ms !important;
        }
      `,
    });
    await waitForReadySignal(page);
    await new Promise((resolve) => setTimeout(resolve, POST_LOAD_DELAY_MS));
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

export interface RawScreenshotParams {
  scriptName: string;
  orgId: string;
  orgSlug?: string; // Optional - falls back to legacy URL format if missing
  envPrefix: string;
  isPublic: boolean;
  screenshotToken?: string;
  timeoutMs?: number;
}

/**
 * Capture a screenshot and return the raw image buffer without storing to R2.
 * Used by MCP tool to return image directly to the caller.
 */
export async function captureScreenshotRaw(
  browser: Fetcher,
  params: RawScreenshotParams
): Promise<{ success: true; image: Buffer } | { success: false; error: string }> {
  const { scriptName, orgId, orgSlug, envPrefix, isPublic, screenshotToken, timeoutMs } = params;
  const effectiveTimeoutMs = timeoutMs ?? RAW_CAPTURE_TIMEOUT_MS;

  const suffix = envPrefix ? `apps.${envPrefix}.camelai.dev` : 'apps.camelai.dev';
  // Fall back to legacy format if orgSlug is missing
  const targetUrl = orgSlug
    ? `https://${scriptName}${isNewStyleOrgSlug(orgSlug) ? '-' : '--'}${orgSlug}.${suffix}`
    : `https://${scriptName}.${suffix}`;

  let puppeteerBrowser: Browser | null = null;
  let page: Page | null = null;

  try {
    const image = await withTimeout(
      async () => {
        const { default: puppeteer } = await import('@cloudflare/puppeteer');
        puppeteerBrowser = await puppeteer.launch(browser);
        page = await puppeteerBrowser.newPage();
        await page.setViewport(VIEWPORT);

        if (screenshotToken && envPrefix !== 'local') {
          await page.setExtraHTTPHeaders({
            'x-chiridion-screenshot-token': screenshotToken,
          });
        }

        const { response, waitUntil } = await navigateWithFallback(page, targetUrl, {
          scriptName,
          orgId,
        });

        console.log('[app-screenshot-raw] navigation complete', {
          scriptName,
          orgId,
          status: response?.status() ?? null,
          waitUntil,
        });

        if (response && !response.ok()) {
          const statusText = typeof response.statusText === 'function' ? response.statusText() : '';
          throw new Error(
            `Navigation failed with status ${response.status()}${statusText ? ` ${statusText}` : ''} for ${targetUrl}`
          );
        }

        await page.addStyleTag({
          content: `
            body { overflow: hidden !important; }
            *, *::before, *::after {
              animation-duration: 0.01ms !important;
              animation-delay: 0.01ms !important;
              transition-duration: 0.01ms !important;
              transition-delay: 0.01ms !important;
            }
          `,
        });
        await waitForReadySignal(page);
        await new Promise((resolve) => setTimeout(resolve, POST_LOAD_DELAY_MS));
        await page.evaluate(() => window.scrollTo(0, 0));

        return (await page.screenshot({
          type: 'jpeg',
          quality: 80,
          clip: SCREENSHOT_CLIP,
        })) as Buffer;
      },
      effectiveTimeoutMs,
      `Screenshot capture timed out after ${Math.ceil(effectiveTimeoutMs / 1000)}s`
    );

    console.log('[app-screenshot-raw] captured', {
      scriptName,
      orgId,
      targetUrl,
    });

    return { success: true, image };
  } catch (err) {
    const errorMessage = truncateError(err);
    console.error('[app-screenshot-raw] capture failed', {
      scriptName,
      orgId,
      error: errorMessage,
    });

    return { success: false, error: errorMessage };
  } finally {
    if (page) {
      await page.close();
    }
    if (puppeteerBrowser) {
      await puppeteerBrowser.close();
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

      // Backfill org_slug for messages queued before the URL scheme change
      if (!job.org_slug) {
        try {
          const slug = await orgStub.getSlug();
          if (slug) {
            job.org_slug = slug;
          }
        } catch {
          // Continue without org_slug - will use legacy URL format
        }
      }

      console.log('[app-screenshot] processing job', {
        scriptName: job.script_name,
        orgId: job.org_id,
        orgSlug: job.org_slug ?? '(legacy)',
        envPrefix: job.env_prefix,
        attempt,
      });

      let screenshotToken = job.screenshot_token;
      if (!job.is_public && job.env_prefix !== 'local') {
        if (!screenshotToken || attempt > 1) {
          screenshotToken = await createScreenshotToken(env.APP_KV, {
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
