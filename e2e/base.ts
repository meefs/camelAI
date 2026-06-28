import { test as base, expect } from '@playwright/test';

/**
 * Shared base for the local E2E specs. Holds the final frame for ~1s after each
 * test so the recorded videos don't cut off abruptly on the last action.
 */
export const test = base;

test.afterEach(async ({ page }) => {
  await page.waitForTimeout(1000).catch(() => {});
});

export { expect };
