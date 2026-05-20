# BYOK 429 Rate Limit Error - Review Feedback R2

## Finding

### 1. WebSocket error fallback drops the current provider when the event has no provider metadata (Medium)

**Files:**
- `src/components/Chat.tsx` lines 1766-1770
- `src/components/Chat.tsx` lines 3027-3041

The second implementation pass correctly uses `data.provider` when the worker sends it. However, the handler now always passes `llmProvider: eventProvider ?? undefined` into `showChatError()`.

Because `normalizeChatError()` applies defaults first and then spreads `context`, that explicit `undefined` overwrites the component's current `llmProvider`. Any WebSocket error event without `provider` metadata loses the fallback provider context.

Impact:

- A BYOK 429 event with `billingSource: "byok"` but no `provider` renders as generic "Your API key is rate limited" with no provider label or link.
- A 429 event with no `billingSource` and no `provider` can be misclassified as hosted even when the current org/provider + thread harness clearly indicate BYOK.
- This is not covered by the new tests because the WebSocket test only emits `provider: "bedrock"`.

Recommended fix:

```ts
const context: Partial<ChatApiErrorContext> = { billingSource };
if (eventProvider) {
  context.llmProvider = eventProvider;
}
showChatError(errorPayload, context);
```

Alternatively, make `normalizeChatError()` merge with nullish coalescing instead of spreading raw context over defaults.

Suggested test:

```tsx
it("falls back to the current provider when websocket provider metadata is absent", async () => {
  render(
    <Chat
      threadId="thread-1"
      workspaceId="ws-1"
      initialMessages={[]}
      llmProvider="anthropic"
      threadProvider="claude"
    />,
  );

  const socket = getMainSocket();
  act(() => {
    socket.emitOpen();
    socket.emitMessage({
      type: "error",
      error: RATE_LIMIT_ERROR,
      billingSource: "byok",
    });
  });

  expect(
    await screen.findByText("Your Anthropic API key is rate limited"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /Open Anthropic API settings/ }),
  ).toHaveAttribute("href", BYOK_PROVIDERS.anthropic.getKeyUrl);
});
```

## Notes

The rest of the implementation looks good from this pass:

- All four providers now have central settings labels/links.
- BYOK provider labels and URLs are tested in `tests/chat-api-errors.test.ts`.
- Persisted transcript metadata is represented on `ErrorBlock`.
- Focused tests pass locally.

## Verification

Ran:

```bash
bun run test:run -- tests/chat-api-errors.test.ts tests/message-bubble-content-to-string.test.ts tests/chat-question-response-focus.test.tsx
bun run typecheck
```

Both passed.
