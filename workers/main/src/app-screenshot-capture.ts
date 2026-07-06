import type { Browser, HTTPRequest, Page } from '@cloudflare/puppeteer';
import {
  buildWorkspaceAppHostIndex,
  fetchWorkspaceAppViaDispatch,
  isWorkspaceAppHostname,
  type WorkspaceAppContext,
  type WorkspaceAppFetcherEnv,
  type WorkspaceAppHostIndex,
} from './workspace-app-fetcher.js';

export const SCREENSHOT_VIEWPORT = {
  width: 1280,
  height: 720,
  deviceScaleFactor: 1.5,
};

export const SCREENSHOT_CLIP = {
  x: 0,
  y: 0,
  width: SCREENSHOT_VIEWPORT.width,
  height: SCREENSHOT_VIEWPORT.height,
};

export function screenshotViewport(width = SCREENSHOT_VIEWPORT.width, height = SCREENSHOT_VIEWPORT.height) {
  return {
    width,
    height,
    deviceScaleFactor: SCREENSHOT_VIEWPORT.deviceScaleFactor,
  };
}

export function screenshotClip(width = SCREENSHOT_CLIP.width, height = SCREENSHOT_CLIP.height) {
  return {
    x: 0,
    y: 0,
    width,
    height,
  };
}

export const NAVIGATION_TIMEOUT_MS = 30_000;
export const READY_TIMEOUT_MS = 1500;
export const POST_LOAD_DELAY_MS = 600;

export function truncateError(err: unknown, maxLength = 500): string {
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
      { timeout: READY_TIMEOUT_MS },
    );
  } catch {
    // Optional signal - ignore timeout.
  }
}

async function applyScreenshotStyles(page: Page): Promise<void> {
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
}

export function headersRecord(headers: Headers): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  // Headers.forEach collapses duplicate Set-Cookie into a single comma-joined
  // value, which corrupts cookies (Expires and some values contain commas).
  // Preserve each Set-Cookie separately so request.respond emits multiple
  // headers — needed for private-app login/multi-cookie flows via env.BROWSER.
  // puppeteer's request.respond splits array header values into distinct
  // headers, so passing the array through is sufficient.
  const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  if (setCookies.length > 0) {
    output['set-cookie'] = setCookies;
  }
  return output;
}

export interface DispatchInterceptionOptions {
  // Redirect mode passed to the dispatch fetch for intercepted app requests.
  // Screenshots leave this at the default 'follow' (they only need the final
  // rendered page). Interactive browser sessions pass 'manual' so 3xx responses
  // are handed back to Chrome as-is and it performs the redirect itself —
  // preserving real navigation semantics (url(), history, cookies, and
  // POST/redirect/GET or login redirects) for private apps too.
  redirect?: RequestRedirect;
}

export async function installDispatchRequestInterception(
  page: Page,
  env: WorkspaceAppFetcherEnv,
  context: WorkspaceAppContext,
  hostIndex: WorkspaceAppHostIndex,
  options?: DispatchInterceptionOptions,
): Promise<() => void> {
  await page.setRequestInterception(true);
  const handler = async (request: HTTPRequest) => {
    try {
      const url = new URL(request.url());
      if (
        (url.protocol === 'http:' || url.protocol === 'https:')
        && isWorkspaceAppHostname(hostIndex, url.hostname)
      ) {
        const upstream = await fetchWorkspaceAppViaDispatch(
          env,
          context,
          new Request(request.url(), {
            method: request.method(),
            headers: request.headers(),
            body: request.method() === 'GET' || request.method() === 'HEAD'
              ? undefined
              : request.postData(),
            redirect: options?.redirect,
          }),
          hostIndex,
        );
        const body = upstream.status === 204 || upstream.status === 304
          ? undefined
          : Buffer.from(await upstream.arrayBuffer());
        await request.respond({
          status: upstream.status,
          headers: headersRecord(upstream.headers),
          body,
        });
        return;
      }
      await request.continue();
    } catch (error) {
      console.warn('[app-screenshot] request interception failed', {
        url: request.url(),
        error: truncateError(error),
      });
      await request.abort();
    }
  };
  page.on('request', handler);
  return () => {
    page.off('request', handler);
  };
}

export interface CaptureAppScreenshotParams {
  targetUrl: string;
  logContext: Record<string, unknown>;
  useDispatchInterception: boolean;
  postLoadDelayMs?: number;
  width?: number;
  height?: number;
}

export async function captureAppScreenshotBuffer(
  browserBinding: Fetcher,
  env: WorkspaceAppFetcherEnv,
  context: WorkspaceAppContext,
  params: CaptureAppScreenshotParams,
): Promise<Buffer> {
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  let browser: Browser | null = null;
  let page: Page | null = null;
  let removeInterception: (() => void) | undefined;

  try {
    browser = await puppeteer.launch(browserBinding);
    page = await browser.newPage();
    const viewport = screenshotViewport(params.width, params.height);
    const clip = screenshotClip(params.width, params.height);
    await page.setViewport(viewport);

    if (params.useDispatchInterception && env.DISPATCHER) {
      const hostIndex = await buildWorkspaceAppHostIndex(env, context);
      removeInterception = await installDispatchRequestInterception(
        page,
        env,
        context,
        hostIndex,
      );
    }

    const { response, waitUntil } = await navigateWithFallback(
      page,
      params.targetUrl,
      params.logContext,
    );

    console.log('[app-screenshot] navigation complete', {
      ...params.logContext,
      status: response?.status() ?? null,
      waitUntil,
    });

    if (response && !response.ok()) {
      const statusText = typeof response.statusText === 'function' ? response.statusText() : '';
      throw new Error(
        `Navigation failed with status ${response.status()}${statusText ? ` ${statusText}` : ''} for ${params.targetUrl}`,
      );
    }

    await applyScreenshotStyles(page);
    await waitForReadySignal(page);
    await new Promise((resolve) => setTimeout(
      resolve,
      params.postLoadDelayMs ?? POST_LOAD_DELAY_MS,
    ));
    await page.evaluate(() => window.scrollTo(0, 0));

    return (await page.screenshot({
      type: 'jpeg',
      quality: 80,
      clip,
    })) as Buffer;
  } finally {
    removeInterception?.();
    if (page) {
      await page.close();
    }
    if (browser) {
      await browser.close();
    }
  }
}

export function bufferToImageDataUrl(image: Buffer): string {
  return `data:image/jpeg;base64,${Buffer.from(image).toString('base64')}`;
}
