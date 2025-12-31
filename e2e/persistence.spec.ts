import { test, expect, Page, WebSocket as PlaywrightWebSocket } from '@playwright/test';

// Helper to create account and login with better error handling
async function loginWithNewAccount(page: Page): Promise<string> {
  const email = `test-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;
  const password = 'testpassword123';

  await page.goto('/signup');
  await page.waitForLoadState('networkidle');

  await page.fill('input#email', email);
  await page.fill('input#password', password);
  await page.fill('input#confirmPassword', password);

  // Wait for button to be enabled and click
  const submitBtn = page.locator('button[type="submit"]');
  await expect(submitBtn).toBeEnabled();
  await submitBtn.click();

  // Wait a moment for response
  await page.waitForTimeout(2000);

  // Check for error alert
  const alert = page.locator('[role="alert"]');
  if (await alert.count() > 0) {
    const alertText = await alert.textContent();
    console.log('Alert/Error:', alertText);
  }

  // Check current URL
  const currentUrl = page.url();
  console.log('URL after submit:', currentUrl);

  // If redirected to login, try logging in instead
  if (currentUrl.includes('/login')) {
    console.log('Redirected to login, attempting to log in...');
    await page.fill('input#email', email);
    await page.fill('input#password', password);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
  }

  // Wait for redirect away from auth pages
  try {
    await page.waitForURL(url => !url.pathname.includes('signup') && !url.pathname.includes('login'), { timeout: 10000 });
  } catch (e) {
    console.log('Final URL:', page.url());
    // Log any visible text that might be an error
    const bodyText = await page.locator('body').innerText();
    console.log('Page body text (first 500 chars):', bodyText.substring(0, 500));
    throw e;
  }

  console.log('Signed up as:', email);
  console.log('Current URL after signup:', page.url());

  return email;
}

test.describe('Message Persistence', () => {
  test('messages persist after page reload', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    // Navigate to home and create new chat
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Click new chat
    await page.click('button:has-text("New Chat")');
    await page.waitForURL(/\/chat\/.+/, { timeout: 10000 });

    // Capture the chat URL
    const chatUrl = page.url();
    console.log('Chat URL:', chatUrl);

    // Wait for WebSocket connection
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 15000 });
    console.log('WebSocket connected');

    // Send a message
    const testMessage = `Test message ${Date.now()}`;
    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill(testMessage);
    await page.click('button:has-text("Send")');
    console.log('Sent message:', testMessage);

    // Wait for user message to appear
    await expect(page.locator('.rounded-2xl').first()).toBeVisible({ timeout: 10000 });

    // Wait for assistant response (streaming)
    await page.waitForTimeout(15000);

    // Count messages before reload
    const messagesBefore = await page.locator('.rounded-2xl').count();
    console.log('Messages before reload:', messagesBefore);

    // Get the text content of messages
    const userMessageBefore = await page.locator('.rounded-2xl').first().textContent();
    console.log('User message content:', userMessageBefore?.substring(0, 100));

    // Reload the page
    console.log('Reloading page...');
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Wait for messages to load from API
    await page.waitForTimeout(3000);

    // Count messages after reload
    const messagesAfter = await page.locator('.rounded-2xl').count();
    console.log('Messages after reload:', messagesAfter);

    // Messages should persist
    if (messagesAfter === 0) {
      // Debug: Check if there's any content
      const pageContent = await page.content();
      console.log('Page has chat elements:', pageContent.includes('rounded-2xl'));

      // Check for error messages
      const errorText = await page.locator('text=error').count();
      console.log('Error elements on page:', errorText);
    }

    expect(messagesAfter).toBeGreaterThan(0);
    expect(messagesAfter).toBe(messagesBefore);

    // Verify user message content is the same
    const userMessageAfter = await page.locator('.rounded-2xl').first().textContent();
    console.log('User message after reload:', userMessageAfter?.substring(0, 100));

    expect(userMessageAfter).toContain(testMessage);
  });

  test('tool_use and tool_result blocks persist with correct styling after reload', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.click('button:has-text("New Chat")');
    await page.waitForURL(/\/chat\/.+/);

    // Wait for WebSocket to be ready
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 15000 });

    // Ask something that requires tool use (Bash command)
    const textarea = page.locator('textarea[placeholder="Type a message..."]');
    await textarea.fill('Run the command: echo "test-persistence-123"');

    const sendButton = page.locator('button[type="submit"]');
    await sendButton.click();
    console.log('Sent tool use message');

    // Wait for tool_use block (amber background) to appear
    const toolUseBlock = page.locator('.bg-amber-500\\/10');
    await expect(toolUseBlock.first()).toBeVisible({ timeout: 60000 });
    console.log('Tool use block appeared');

    // Should show tool name
    await expect(toolUseBlock.first().locator('text=Bash')).toBeVisible();
    console.log('Bash tool name visible');

    // Wait for tool_result block (green background) to appear
    const toolResultBlock = page.locator('.bg-green-500\\/10');
    await expect(toolResultBlock.first()).toBeVisible({ timeout: 60000 });
    console.log('Tool result block appeared');

    // Result should contain our echo output
    await expect(toolResultBlock.first().locator('text=test-persistence-123')).toBeVisible();
    console.log('Echo output visible in result');

    // Wait a bit for persistence to complete
    await page.waitForTimeout(3000);

    // Count tool blocks before reload
    const toolUseCountBefore = await toolUseBlock.count();
    const toolResultCountBefore = await toolResultBlock.count();
    console.log(`Before reload: ${toolUseCountBefore} tool_use, ${toolResultCountBefore} tool_result blocks`);

    // Reload the page
    console.log('Reloading page...');
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Verify tool_use blocks still render with correct styling (not as strings!)
    const toolUseAfter = page.locator('.bg-amber-500\\/10');
    const toolResultAfter = page.locator('.bg-green-500\\/10');

    // Tool blocks should still have amber/green styling
    const toolUseCountAfter = await toolUseAfter.count();
    const toolResultCountAfter = await toolResultAfter.count();
    console.log(`After reload: ${toolUseCountAfter} tool_use, ${toolResultCountAfter} tool_result blocks`);

    // Critical: Tool blocks should NOT be rendered as plain text strings
    // If they were strings, they would show up as "[object Object]" or raw JSON
    expect(toolUseCountAfter).toBeGreaterThan(0);
    expect(toolResultCountAfter).toBeGreaterThan(0);

    // Verify the content is still properly rendered
    await expect(toolUseAfter.first().locator('text=Bash')).toBeVisible();
    await expect(toolResultAfter.first().locator('text=test-persistence-123')).toBeVisible();

    // Make sure we don't see stringified JSON or [object Object]
    const pageContent = await page.content();
    expect(pageContent).not.toContain('[object Object]');
    // Raw JSON array should not appear in rendered content
    expect(pageContent).not.toContain('"type":"tool_use"');
  });

  test('messages do not duplicate on WebSocket reconnect', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    // Track WebSocket messages for debugging
    const wsMessages: string[] = [];
    page.on('websocket', ws => {
      ws.on('framereceived', frame => {
        if (typeof frame.payload === 'string') {
          wsMessages.push(frame.payload.substring(0, 200));
        }
      });
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.click('button:has-text("New Chat")');
    await page.waitForURL(/\/chat\/.+/);

    // Capture the chat URL for reconnection
    const chatUrl = page.url();
    console.log('Chat URL:', chatUrl);

    // Wait for WebSocket to be ready
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 15000 });

    // Send a simple message
    const testMessage = `Unique message ${Date.now()}`;
    const textarea = page.locator('textarea[placeholder="Type a message..."]');
    await textarea.fill(testMessage);
    await page.locator('button[type="submit"]').click();
    console.log('Sent message:', testMessage);

    // Wait for assistant response
    await page.waitForTimeout(20000);

    // Count messages before reconnect
    const messagesBefore = await page.locator('[class*="rounded"]').filter({ hasText: testMessage }).count();
    console.log('User messages with our text before reconnect:', messagesBefore);

    // Get all assistant messages for comparison
    const assistantMessagesBefore = await page.locator('.max-w-none').count();
    console.log('Assistant message areas before reconnect:', assistantMessagesBefore);

    // Navigate away and back to trigger WebSocket reconnection
    console.log('Navigating away to trigger reconnect...');
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Navigate back to the same chat
    console.log('Navigating back to chat...');
    await page.goto(chatUrl);
    await page.waitForLoadState('networkidle');

    // Wait for WebSocket to reconnect
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    // Count messages after reconnect
    const messagesAfter = await page.locator('[class*="rounded"]').filter({ hasText: testMessage }).count();
    console.log('User messages with our text after reconnect:', messagesAfter);

    const assistantMessagesAfter = await page.locator('.max-w-none').count();
    console.log('Assistant message areas after reconnect:', assistantMessagesAfter);

    // Critical: No duplicates should appear
    expect(messagesAfter).toBe(messagesBefore);
    // Allow for some variance in assistant message count due to streaming states
    // but should be roughly the same (within 1)
    expect(Math.abs(assistantMessagesAfter - assistantMessagesBefore)).toBeLessThanOrEqual(1);

    // Reload one more time to ensure persistence is stable
    console.log('Final reload...');
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    const messagesFinal = await page.locator('[class*="rounded"]').filter({ hasText: testMessage }).count();
    console.log('User messages with our text after final reload:', messagesFinal);
    expect(messagesFinal).toBe(messagesBefore);
  });
});
