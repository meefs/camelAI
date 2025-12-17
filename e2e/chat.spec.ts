import { test, expect, Page } from '@playwright/test';

// Helper to create account and login
async function loginWithNewAccount(page: Page): Promise<string> {
  const email = `test-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;

  await page.goto('/signup');
  await page.fill('input#email', email);
  await page.fill('input#password', 'password123');
  await page.fill('input#confirmPassword', 'password123');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/', { timeout: 10000 });

  return email;
}

test.describe('Chat E2E', () => {
  test('basic chat flow', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    await page.goto('/');
    await page.click('button:has-text("New Chat")');
    await page.waitForURL(/\/chat\/.+/);
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10000 });

    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('Say hello');
    await page.click('button:has-text("Send")');

    // Wait for response
    await page.waitForTimeout(20000);

    // Should have user message and assistant response
    const messages = page.locator('.rounded-2xl');
    await expect(messages).toHaveCount(2, { timeout: 30000 });
  });

  test('streaming text shows incremental updates', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    const streamDeltas: { text: string; timestamp: number }[] = [];

    // Set up listener BEFORE any navigation
    page.on('websocket', ws => {
      console.log('WebSocket connected:', ws.url());
      ws.on('framereceived', frame => {
        try {
          const data = JSON.parse(frame.payload as string);
          if (data.type === 'sdk_event' && data.event?.type === 'stream_event') {
            const evt = data.event.event;
            if (evt?.type === 'content_block_delta' && evt.delta?.text) {
              streamDeltas.push({ text: evt.delta.text, timestamp: Date.now() });
            }
          }
        } catch {}
      });
    });

    await page.goto('/');
    await page.click('button:has-text("New Chat")');
    await page.waitForURL(/\/chat\/.+/);
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10000 });

    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('Write a haiku about coding');
    await page.click('button:has-text("Send")');

    await page.waitForTimeout(25000);

    console.log('Stream deltas:', streamDeltas.length);
    console.log('Full text:', streamDeltas.map(d => d.text).join(''));

    // Verify we got multiple deltas
    expect(streamDeltas.length).toBeGreaterThan(1);

    // Verify deltas are spread over time (not all at once)
    if (streamDeltas.length > 2) {
      const firstTimestamp = streamDeltas[0].timestamp;
      const lastTimestamp = streamDeltas[streamDeltas.length - 1].timestamp;
      const timespanMs = lastTimestamp - firstTimestamp;

      console.log('Timespan between first and last delta:', timespanMs, 'ms');
      console.log('Delta timestamps:', streamDeltas.map(d => d.timestamp - firstTimestamp));

      // Deltas should be spread over at least 100ms (not all at once)
      expect(timespanMs).toBeGreaterThan(100);
    }
  });

  test('tool use - describe the computer', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    const allEvents: any[] = [];

    // Set up listener BEFORE any navigation
    page.on('websocket', ws => {
      console.log('WebSocket connected:', ws.url());
      ws.on('framereceived', frame => {
        try {
          const data = JSON.parse(frame.payload as string);
          if (data.type === 'sdk_event') {
            allEvents.push(data.event);
          }
        } catch {}
      });
    });

    await page.goto('/');
    await page.click('button:has-text("New Chat")');
    await page.waitForURL(/\/chat\/.+/);
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10000 });

    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('Tell me about the computer you are running on');
    await page.click('button:has-text("Send")');

    // Wait for tool use to complete
    await page.waitForTimeout(60000);

    console.log('Total events:', allEvents.length);
    console.log('Event types:', allEvents.map(e => e.type));

    // Should have tool use events
    const hasToolUse = allEvents.some(e =>
      (e.type === 'assistant' && e.message?.content?.some((c: any) => c.type === 'tool_use')) ||
      (e.type === 'stream_event' && e.event?.type === 'content_block_start' && e.event?.content_block?.type === 'tool_use')
    );

    const hasToolResult = allEvents.some(e =>
      e.type === 'user' && e.message?.content?.some((c: any) => c.type === 'tool_result')
    );

    console.log('Has tool_use:', hasToolUse);
    console.log('Has tool_result:', hasToolResult);

    // Look for tool use block in UI
    const toolUseBlock = page.locator('.bg-amber-950\\/50');
    const toolResultBlock = page.locator('.bg-green-950\\/50');

    // At least one should be visible (tool was used)
    const toolUseVisible = await toolUseBlock.count() > 0;
    const toolResultVisible = await toolResultBlock.count() > 0;

    console.log('UI - Tool use visible:', toolUseVisible);
    console.log('UI - Tool result visible:', toolResultVisible);

    expect(hasToolUse || hasToolResult || toolUseVisible || toolResultVisible).toBe(true);
  });
});
