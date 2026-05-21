import { expect, test } from '@playwright/test';
import react from '@vitejs/plugin-react';
import type { AddressInfo } from 'node:net';
import { createServer, type ViteDevServer } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

declare global {
  interface Window {
    previewMessages?: Record<'active' | 'inactive', number>;
    previewBoots?: Record<'active' | 'inactive', number>;
    previewTicks?: Record<'active' | 'inactive', number>;
  }
}

let server: ViteDevServer | null = null;
let baseURL = '';

test.beforeAll(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    envFile: false,
    logLevel: 'error',
    plugins: [react(), tsconfigPaths()],
    optimizeDeps: {
      entries: ['e2e/fixtures/html-preview-harness.html'],
    },
    server: {
      host: '127.0.0.1',
      port: 0,
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to start HTML preview harness server');
  }
  baseURL = `http://127.0.0.1:${(address as AddressInfo).port}`;
});

test.afterAll(async () => {
  await server?.close();
});

test('real HTML preview iframes run only while their tab is active', async ({ page }) => {
  await page.goto(`${baseURL}/e2e/fixtures/html-preview-harness.html`);

  await expect(page.locator('iframe')).toHaveCount(1);
  await expect(page.locator('iframe[title="active.html"]')).toHaveCount(1);
  await expect(page.locator('iframe[title="inactive.html"]')).toHaveCount(0);

  await expect
    .poll(() => page.evaluate(() => window.previewMessages?.active ?? 0))
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => window.previewMessages?.inactive ?? 0))
    .toBe(0);

  await page.getByRole('tab').filter({ hasText: 'inactive.html' }).click();

  await expect(page.locator('iframe')).toHaveCount(1);
  await expect(page.locator('iframe[title="active.html"]')).toHaveCount(0);
  await expect(page.locator('iframe[title="inactive.html"]')).toHaveCount(1);

  await expect
    .poll(() => page.evaluate(() => window.previewMessages?.inactive ?? 0))
    .toBeGreaterThan(0);

  await page.waitForTimeout(100);
  const activeMessagesAfterUnmount = await page.evaluate(
    () => window.previewMessages?.active ?? 0,
  );
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.previewMessages?.active ?? 0)).toBe(
    activeMessagesAfterUnmount,
  );
});

test('active HTML preview survives automatic refresh churn until manual refresh', async ({ page }) => {
  await page.goto(`${baseURL}/e2e/fixtures/html-preview-harness.html`);

  const activeFrame = page.locator('iframe[title="active.html"]');
  await expect(activeFrame).toHaveCount(1);
  await expect(activeFrame).toHaveAttribute(
    'src',
    /html-preview-active\.html\?v=0$/,
  );

  await expect
    .poll(() => page.evaluate(() => window.previewBoots?.active ?? 0))
    .toBe(1);

  const tickBeforeChurn = await page.evaluate(
    () => window.previewTicks?.active ?? 0,
  );
  for (let i = 0; i < 3; i += 1) {
    await page.getByRole('button', { name: 'Simulate auto refresh' }).click();
  }

  await expect(activeFrame).toHaveAttribute(
    'src',
    /html-preview-active\.html\?v=0$/,
  );
  expect(await page.evaluate(() => window.previewBoots?.active ?? 0)).toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.previewTicks?.active ?? 0))
    .toBeGreaterThan(tickBeforeChurn);

  await page.getByRole('button', { name: 'Manual refresh' }).click();

  await expect(activeFrame).toHaveAttribute(
    'src',
    /html-preview-active\.html\?v=1$/,
  );
  await expect
    .poll(() => page.evaluate(() => window.previewBoots?.active ?? 0))
    .toBe(2);
});
