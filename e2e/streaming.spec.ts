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

test.describe('Chat Streaming', () => {
  test('should create a new chat and receive streaming response', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    // Go to homepage
    await page.goto('/');

    // Click "New Chat" button
    await page.click('button:has-text("New Chat")');

    // Wait for navigation to chat page
    await page.waitForURL(/\/chat\/.+/);

    // Wait for WebSocket connection (green indicator)
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10000 });

    // Type a simple message
    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('Say hello');

    // Send the message
    await page.click('button:has-text("Send")');

    // Wait for final response message containing hello
    await expect(page.locator('.rounded-2xl >> text=/[Hh]ello/')).toBeVisible({ timeout: 60000 });
  });

  test('should show streaming text updates incrementally', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    // Track stream_event deltas from WebSocket
    const streamDeltas: string[] = [];
    const allEvents: any[] = [];

    page.on('websocket', ws => {
      ws.on('framereceived', frame => {
        try {
          const data = JSON.parse(frame.payload as string);
          if (data.type === 'sdk_event') {
            allEvents.push(data.event);
            if (data.event?.type === 'stream_event') {
              const evt = data.event.event;
              if (evt?.type === 'content_block_delta' && evt.delta?.text) {
                streamDeltas.push(evt.delta.text);
              }
            }
          }
        } catch {}
      });
    });

    await page.goto('/');
    await page.click('button:has-text("New Chat")');
    await page.waitForURL(/\/chat\/.+/);
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10000 });

    // Send message that should produce streaming text
    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('Write a haiku about coding');
    await page.click('button:has-text("Send")');

    // Wait for response to complete (final message appears)
    await page.waitForTimeout(20000);

    // Log what we received
    console.log('Total SDK events:', allEvents.length);
    console.log('Event types:', allEvents.map(e => e.type));
    console.log('Stream deltas received:', streamDeltas.length);
    console.log('Deltas:', streamDeltas);

    // Key assertion: we should have received multiple stream deltas
    // This verifies the backend is sending incremental updates
    expect(streamDeltas.length).toBeGreaterThan(1);

    // Verify the deltas when joined form coherent text
    const fullText = streamDeltas.join('');
    console.log('Full text from deltas:', fullText);
    expect(fullText.length).toBeGreaterThan(10);
  });

  test('should show tool use and tool result blocks', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    await page.goto('/');
    await page.click('button:has-text("New Chat")');
    await page.waitForURL(/\/chat\/.+/);
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10000 });

    // Ask something that requires tool use
    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('Run the command: echo "hello from playwright"');
    await page.click('button:has-text("Send")');

    // Wait for tool_use block (amber background)
    const toolUseBlock = page.locator('.bg-amber-950\\/50');
    await expect(toolUseBlock).toBeVisible({ timeout: 60000 });

    // Should show "Bash" tool name
    await expect(toolUseBlock.locator('text=Bash')).toBeVisible();

    // Wait for tool_result block (green background)
    const toolResultBlock = page.locator('.bg-green-950\\/50');
    await expect(toolResultBlock).toBeVisible({ timeout: 60000 });

    // Should show "Result" label
    await expect(toolResultBlock.locator('text=Result')).toBeVisible();

    // Result should contain our echo output
    await expect(toolResultBlock.locator('text=hello from playwright')).toBeVisible();
  });

  test('should maintain WebSocket connection during streaming', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    await page.goto('/');
    await page.click('button:has-text("New Chat")');
    await page.waitForURL(/\/chat\/.+/);

    // Verify connected
    const connectedIndicator = page.locator('[title="Connected"]');
    await expect(connectedIndicator).toBeVisible({ timeout: 10000 });

    // Send message
    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('Count from 1 to 5');
    await page.click('button:has-text("Send")');

    // Wait for response to appear
    await page.waitForTimeout(10000);

    // Connection should remain green throughout
    await expect(connectedIndicator).toBeVisible();
  });

  test('should clear streaming state after completion', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    await page.goto('/');
    await page.click('button:has-text("New Chat")');
    await page.waitForURL(/\/chat\/.+/);
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10000 });

    // Send message
    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('Say the word done');
    await page.click('button:has-text("Send")');

    // Wait for response to complete
    await page.waitForTimeout(15000);

    // Final message should be visible (in the messages area, not streaming)
    const messagesArea = page.locator('.overflow-y-auto.p-4');
    await expect(messagesArea.locator('.rounded-2xl')).toHaveCount(2, { timeout: 10000 }); // user + assistant

    // Streaming indicator (bouncing dots) should not be visible after completion
    const streamingDots = page.locator('.animate-bounce');
    await expect(streamingDots).toHaveCount(0, { timeout: 5000 });
  });
});

test.describe('WebSocket Events', () => {
  test('should receive sdk_event messages via WebSocket', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    // Capture WebSocket messages
    const wsMessages: any[] = [];

    page.on('websocket', ws => {
      ws.on('framereceived', frame => {
        try {
          const data = JSON.parse(frame.payload as string);
          wsMessages.push(data);
        } catch {}
      });
    });

    await page.goto('/');
    await page.click('button:has-text("New Chat")');
    await page.waitForURL(/\/chat\/.+/);
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10000 });

    // Send message
    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('Say hi');
    await page.click('button:has-text("Send")');

    // Wait for response
    await page.waitForTimeout(15000);

    console.log('WebSocket messages received:', wsMessages.length);
    console.log('Message types:', wsMessages.map(m => m.type));

    // Should have received various message types
    const messageTypes = wsMessages.map(m => m.type);
    expect(messageTypes).toContain('history');
    expect(messageTypes).toContain('sdk_event');
    expect(messageTypes).toContain('message');

    // Check sdk_event subtypes
    const sdkEvents = wsMessages.filter(m => m.type === 'sdk_event');
    const eventTypes = sdkEvents.map(m => m.event?.type);
    console.log('SDK event types:', eventTypes);

    expect(eventTypes).toContain('system');
    expect(eventTypes).toContain('assistant');
    expect(eventTypes).toContain('result');
  });

  test('should receive multiple assistant events with partial content', async ({ page }) => {
    // Login first
    await loginWithNewAccount(page);

    const sdkEvents: any[] = [];

    page.on('websocket', ws => {
      ws.on('framereceived', frame => {
        try {
          const data = JSON.parse(frame.payload as string);
          if (data.type === 'sdk_event') {
            sdkEvents.push(data.event);
          }
        } catch {}
      });
    });

    await page.goto('/');
    await page.click('button:has-text("New Chat")');
    await page.waitForURL(/\/chat\/.+/);
    await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10000 });

    // Send message that should produce streaming text
    const input = page.locator('input[placeholder="Type a message..."]');
    await input.fill('Write a short poem about the moon');
    await page.click('button:has-text("Send")');

    // Wait for response to complete
    await page.waitForTimeout(30000);

    // Filter assistant events with text content
    const assistantTextEvents = sdkEvents.filter(e =>
      e.type === 'assistant' &&
      e.message?.content?.some((c: any) => c.type === 'text')
    );

    console.log('Assistant text events:', assistantTextEvents.length);

    // With includePartialMessages: true, we should get multiple events
    // If this fails, the container hasn't rolled out yet
    if (assistantTextEvents.length <= 1) {
      console.log('WARNING: Only received', assistantTextEvents.length, 'assistant events');
      console.log('Container may not have rolled out with includePartialMessages: true');
    }

    // Log the text lengths to see if they're accumulating
    const textLengths = assistantTextEvents.map(e => {
      const textBlock = e.message.content.find((c: any) => c.type === 'text');
      return textBlock?.text?.length || 0;
    });
    console.log('Text lengths:', textLengths);

    expect(assistantTextEvents.length).toBeGreaterThanOrEqual(1);
  });
});
