import { expect, test, type Page } from '@playwright/test';

async function loginWithNewAccount(page: Page): Promise<void> {
  const email = `chat-groups-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  await page.goto('/signup');
  const nameInput = page.locator('input#name');
  if (await nameInput.isVisible().catch(() => false)) {
    await nameInput.fill('Chat Groups Test');
  }
  await page.fill('input#email', email);
  await page.fill('input#password', 'password123');
  await page.fill('input#confirmPassword', 'password123');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/', { timeout: 10000 });
}

test.describe('Chat Groups', () => {
  test('loads the chat groups sidebar with a single workspace status socket', async ({ page }) => {
    const statusSocketUrls: string[] = [];
    page.on('websocket', (socket) => {
      if (/\/ws\/workspaces\/[^/]+\/status$/.test(socket.url())) {
        statusSocketUrls.push(socket.url());
      }
    });

    await loginWithNewAccount(page);
    await page.goto('/chat');

    await expect(page.getByText('Chat Groups')).toBeVisible();
    await page.waitForTimeout(1000);

    expect(statusSocketUrls.length).toBeLessThanOrEqual(1);
  });
});
