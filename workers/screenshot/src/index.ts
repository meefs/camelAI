import puppeteer, { type Page } from '@cloudflare/puppeteer';
import type { DoRpcService } from '../../main/src/rpc-service';

interface AppScreenshotJob {
  script_name: string;
  org_id: string;
  workspace_id: string;
  deploy_ts: number;
  env_prefix: string;
  is_public: boolean;
  screenshot_token?: string;
}

interface Env {
  APP_SCREENSHOT_QUEUE: Queue<AppScreenshotJob>;
  R2_BUCKET: R2Bucket;
  MAIN_RPC: DoRpcService;
  BROWSER: Fetcher;
}

const VIEWPORT = {
  width: 1280,
  height: 720,
  deviceScaleFactor: 2,
};

const PREVIEW_PREFIX = 'app-previews';
const NAVIGATION_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 1500;
const POST_LOAD_DELAY_MS = 600;
const MAX_RETRIES = 3;

function buildPreviewKeys(job: AppScreenshotJob): { currentKey: string; versionedKey: string } {
  const base = `${PREVIEW_PREFIX}/${job.org_id}/${job.workspace_id}/${job.script_name}`;
  return {
    currentKey: `${base}/current.jpg`,
    versionedKey: `${base}/${job.deploy_ts}.jpg`,
  };
}

function buildTargetUrl(job: AppScreenshotJob): string | null {
  if (job.env_prefix === 'local') {
    return null;
  }
  const suffix = job.env_prefix ? `apps.${job.env_prefix}.chiridion.ai` : 'apps.chiridion.ai';
  return `https://${job.script_name}.${suffix}`;
}

function truncateError(err: unknown, maxLength = 500): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength)}...`;
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

export default {
  async queue(batch: MessageBatch<AppScreenshotJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      const startedAt = Date.now();

      if (!job?.script_name || !job.org_id || !job.workspace_id) {
        console.warn('[app-screenshot] invalid job payload', { job });
        message.ack();
        continue;
      }

      try {
        const script = await env.MAIN_RPC.getWorkerScript(job.org_id, job.script_name);
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

        const targetUrl = buildTargetUrl(job);
        if (!targetUrl) {
          console.log('[app-screenshot] skipping local env screenshot', {
            scriptName: job.script_name,
            orgId: job.org_id,
          });
          message.ack();
          continue;
        }

        const browser = await puppeteer.launch(env.BROWSER);
        let page: Page | null = null;
        try {
          page = await browser.newPage();
          await page.setViewport(VIEWPORT);
          if (job.screenshot_token) {
            await page.setExtraHTTPHeaders({
              'x-chiridion-screenshot-token': job.screenshot_token,
            });
          }
          await page.goto(targetUrl, {
            waitUntil: 'networkidle0',
            timeout: NAVIGATION_TIMEOUT_MS,
          });
          await page.addStyleTag({ content: 'body { overflow: hidden !important; }' });
          await waitForReadySignal(page);
          await page.waitForTimeout(POST_LOAD_DELAY_MS);
          const image = (await page.screenshot({
            type: 'jpeg',
            quality: 80,
            fullPage: false,
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

          const updateResult = await env.MAIN_RPC.updateWorkerScriptPreview(job.org_id, job.script_name, {
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
          }

          console.log('[app-screenshot] captured preview', {
            scriptName: job.script_name,
            orgId: job.org_id,
            durationMs: Date.now() - startedAt,
          });
          message.ack();
        } finally {
          if (page) {
            await page.close();
          }
          await browser.close();
        }
      } catch (err) {
        const errorMessage = truncateError(err);
        console.error('[app-screenshot] capture failed', {
          scriptName: job.script_name,
          orgId: job.org_id,
          error: errorMessage,
        });

        await env.MAIN_RPC.updateWorkerScriptPreview(job.org_id, job.script_name, {
          status: 'failed',
          preview_key: null,
          preview_error: errorMessage,
          deploy_ts: job.deploy_ts,
        });

        if ((message.attempts ?? 1) >= MAX_RETRIES) {
          message.ack();
        } else {
          message.retry();
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;
