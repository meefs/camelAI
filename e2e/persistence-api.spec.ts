import { test, expect } from '@playwright/test';

test.describe('Message Persistence via WebSocket', () => {
  test('messages sent via WebSocket should persist after reload', async ({ page, request }) => {
    // Create account via API
    const email = `test-ws-${Date.now()}@example.com`;
    const signupResp = await request.post('/api/auth/signup', {
      data: { email, password: 'password123' }
    });
    expect(signupResp.ok()).toBeTruthy();
    console.log('Signup response status:', signupResp.status());

    // Get cookies from signup response
    const cookies = signupResp.headers()['set-cookie'];
    console.log('Got cookies:', cookies ? 'yes' : 'no');

    // Create a thread via API
    const threadResp = await request.post('/api/threads', {
      data: { title: 'WS Test Thread' }
    });
    expect(threadResp.ok()).toBeTruthy();
    const thread = await threadResp.json();
    console.log('Created thread:', thread.id);

    // Set up WebSocket listener before navigation
    page.on('websocket', ws => {
      console.log('WebSocket opened:', ws.url());
      ws.on('framereceived', frame => {
        const payload = frame.payload as string;
        if (payload.length < 500) {
          console.log('WS frame received:', payload.substring(0, 200));
        }
      });
      ws.on('close', () => console.log('WebSocket closed'));
    });

    // Navigate to the chat page (should use the cookies from request context)
    await page.goto(`/chat/${thread.id}`);

    // Check if we're redirected to login (auth issue)
    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);

    if (currentUrl.includes('/login')) {
      console.log('Redirected to login - auth issue');
      // Try to set cookie manually from the API context
      const storageState = await request.storageState();
      console.log('Storage state cookies:', storageState.cookies.length);
      await page.context().addCookies(storageState.cookies);
      await page.goto(`/chat/${thread.id}`);
    }

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
