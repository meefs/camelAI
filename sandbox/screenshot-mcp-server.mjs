#!/usr/bin/env node

import process from 'node:process';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function createScreenshotMcpServer(sessionToken) {
  return createSdkMcpServer({
    name: 'screenshot',
    version: '1.0.0',
    tools: [
      tool(
        'take_screenshot',
        'Take a screenshot of a URL and return the image. Use this after deploying an app to verify it renders correctly. Pass the full app URL (get it from list_apps first). Automatically authenticates with private *.camelai.app deployments.',
        {
          url: z.string().url().describe('The full URL to screenshot (e.g. https://my-app--my-org.camelai.app)'),
          width: z.number().int().min(320).max(3840).optional().describe('Viewport width in pixels (default 1280)'),
          height: z.number().int().min(240).max(2160).optional().describe('Viewport height in pixels (default 720)'),
        },
        async ({ url, width, height }) => {
          const HARD_TIMEOUT_MS = 10_000;
          const CLEANUP_TIMEOUT_MS = 1_500;
          const viewportWidth = width ?? 1280;
          const viewportHeight = height ?? 720;

          let browser;
          let timedOut = false;
          let hardTimer;
          let cleanupPromise = null;
          const abortController = new AbortController();

          const cleanup = async () => {
            abortController.abort();
            if (cleanupPromise) return cleanupPromise;

            cleanupPromise = (async () => {
              if (!browser) return;

              const browserToClose = browser;
              browser = null;

              try {
                const closeResult = await Promise.race([
                  browserToClose.close().then(() => 'closed'),
                  new Promise((resolve) => setTimeout(() => resolve('timed_out'), CLEANUP_TIMEOUT_MS)),
                ]);
                if (closeResult === 'timed_out') {
                  console.warn('[screenshot-mcp] browser.close() timed out during cleanup');
                }
              } catch (closeError) {
                console.warn('[screenshot-mcp] browser.close() failed during cleanup', closeError);
              }
            })();

            try {
              await cleanupPromise;
            } finally {
              cleanupPromise = null;
            }
          };

          const doScreenshot = async () => {
            const hostname = new URL(url).hostname;
            const isTrusted = sessionToken &&
              (hostname.endsWith('.camelai.app') || hostname.endsWith('.camelai.dev'));
            const pollHeaders = {};
            if (isTrusted) {
              pollHeaders.Cookie = `chiridion_run_session=${sessionToken}`;
            }
            const pollStart = Date.now();
            while (Date.now() - pollStart < 3_000) {
              if (timedOut) throw new Error('Screenshot timed out (10s limit)');
              try {
                const res = await fetch(url, {
                  method: 'HEAD',
                  redirect: 'manual',
                  headers: pollHeaders,
                  signal: abortController.signal,
                });
                if (res.ok) break;
              } catch (e) {
                if (e.name === 'AbortError') throw new Error('Screenshot timed out (10s limit)');
              }
              await new Promise(r => setTimeout(r, 500));
            }

            if (timedOut) throw new Error('Screenshot timed out (10s limit)');
            const { chromium } = await import('playwright');
            browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu'] });
            if (timedOut) { await cleanup(); throw new Error('Screenshot timed out (10s limit)'); }

            const context = await browser.newContext({
              viewport: { width: viewportWidth, height: viewportHeight },
              deviceScaleFactor: 1.5,
            });

            if (isTrusted) {
              await context.addCookies([{
                name: 'chiridion_run_session',
                value: sessionToken,
                domain: hostname,
                path: '/',
                httpOnly: true,
              }]);
            }

            const page = await context.newPage();
            await page.goto(url, { waitUntil: 'load', timeout: 5_000 }).catch(() =>
              page.goto(url, { waitUntil: 'domcontentloaded', timeout: 5_000 })
            );

            const buffer = await page.screenshot({
              type: 'jpeg',
              quality: 80,
              clip: { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
            });

            return {
              content: [{ type: 'image', data: buffer.toString('base64'), mimeType: 'image/jpeg' }],
            };
          };

          try {
            return await Promise.race([
              doScreenshot(),
              new Promise((_, reject) => {
                hardTimer = setTimeout(() => {
                  timedOut = true;
                  void cleanup().catch(() => {});
                  reject(new Error('Screenshot timed out (10s limit)'));
                }, HARD_TIMEOUT_MS);
              }),
            ]);
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Screenshot failed: ${err.message}` }],
              isError: true,
            };
          } finally {
            clearTimeout(hardTimer);
            await cleanup();
          }
        }
      ),
    ],
  });
}

const transport = new StdioServerTransport();
const server = createScreenshotMcpServer(process.env.CHIRIDION_APP_SESSION || '');

await server.instance.server.connect(transport);

