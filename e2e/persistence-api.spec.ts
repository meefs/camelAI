import { test, expect, Page } from '@playwright/test';

const PASSWORD = 'password123';

const generateEmail = () =>
  `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

async function signup(page: Page, email = generateEmail()) {
  await page.goto('/signup');
  await page.fill('input#email', email);
  await page.fill('input#password', PASSWORD);
  await page.fill('input#confirmPassword', PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/', { timeout: 10000 });
  return email;
}

test.describe('Message Persistence via WebSocket', () => {
  test('messages sent via WebSocket should persist after reload', async ({ page }) => {
    // Create account via UI
    await signup(page);

    // Create a thread via API (uses session cookie from browser)
    const threadResp = await page.request.post('/api/threads', {
      data: { title: 'WS Test Thread' },
    });
    expect(threadResp.ok()).toBeTruthy();
    const thread = (await threadResp.json()) as { id: string };
    console.log('Created thread:', thread.id);

    // Set up WebSocket listener before navigation
    page.on('websocket', (ws) => {
      console.log('WebSocket opened:', ws.url());
      ws.on('framereceived', (frame) => {
        const payload = frame.payload as string;
        if (payload.length < 500) {
          console.log('WS frame received:', payload.substring(0, 200));
        }
      });
      ws.on('close', () => console.log('WebSocket closed'));
    });

    // Navigate to the chat page
    await page.goto(`/chat/${thread.id}`);

    // Wait for page to load
    await page.waitForLoadState('networkidle');
    console.log('Page loaded, URL:', page.url());

    // Wait for WebSocket to be ready (textarea should be enabled)
    const textarea = page.locator('textarea[placeholder="Type a message..."]');
    await expect(textarea).toBeVisible({ timeout: 15000 });
    console.log('Chat UI ready');

    // Wait a bit for WebSocket to fully establish
    await page.waitForTimeout(3000);

    // Send a message
    const testMessage = `WS Test Message ${Date.now()}`;
    await textarea.fill(testMessage);

    // Click the send button (arrow icon button)
    const sendButton = page.locator('button[type="submit"]');
    await sendButton.click();
    console.log('Sent message:', testMessage);

    // Wait for the message to appear and for streaming to complete
    await page.waitForTimeout(30000);

    // Check how many messages we have
    const messageCount = await page.locator('.rounded-2xl').count();
    console.log('Message count before reload:', messageCount);

    // Reload the page
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Check messages after reload
    const messageCountAfter = await page.locator('.rounded-2xl').count();
    console.log('Message count after reload:', messageCountAfter);

    // Verify messages persisted
    expect(messageCountAfter).toBeGreaterThan(0);
  });
});
