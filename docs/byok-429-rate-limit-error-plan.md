# BYOK 429 Rate Limit Messaging Plan

## Problem

Users are seeing raw Anthropic provider errors in chat, for example:

```text
Assistant error 429 {"error":{"type":"rate_limit_error","message":"Type 2b rate limited. Please try again later."}}
```

`Type 2b` is an Anthropic-internal label and should not be shown as the primary user-facing explanation. When the current chat turn is routed through the user's own API key, the right guidance is:

- This is controlled by the API provider, not camelAI.
- Increase the provider-side rate limits or reduce current usage.
- Or wait 60 seconds and try again.

When the current chat turn is not routed through a user-provided API key, do not blame the user or tell them to adjust provider limits. In that case camelAI's hosted provider path is being rate limited, so the message should say to wait and retry, with support escalation if it persists.

## Current Error Audit

### Live WebSocket error path

The main chat client receives realtime errors in [src/components/Chat.tsx](../src/components/Chat.tsx):

```text
ChatThreadDO
  pushChatEvent({ type: "error", error })
        |
        v
Chat.tsx WebSocket data.type === "error"
        |
        v
normalizeChatErrorMessage(data.error)
        |
        v
<ChatErrorNotice error={error} />
```

Relevant code:

- [workers/main/src/durable-objects.ts](../workers/main/src/durable-objects.ts) emits `type: "error"` from several places:
  - Pi prompt catch: `sendRunnerCommand()` catches `piSession.prompt()` failures and pushes `type: "error"`.
  - Runner error events: `handleRunnerEvent()` handles `eventType === "error"` and resolves the pending external turn.
  - Direct connection/setup failures: missing thread id, sandbox not connected, thread mismatch.
- [src/components/Chat.tsx](../src/components/Chat.tsx) handles `data.type === "error"` by calling `setError(normalizeChatErrorMessage(data.error))`.
- `normalizeChatErrorMessage()` currently:
  - Extracts only `{ error: string }` JSON payloads.
  - Maps hosted-credit exhaustion to `Message not sent - top up credits or add an API key to continue.`
  - For any text containing `429` or `rate limit`, appends:
    `Wait a minute and try again. If this is from hosted model spend limits, check Settings -> Billing.`

That 429 fallback is too generic for BYOK and can point users at camelAI billing even when Anthropic is rate limiting their own key.

### Persisted assistant error path

The raw error can also become part of the assistant transcript, not just the transient `ChatErrorNotice`:

```text
Pi Agent assistant message
  errorMessage: "429 {...rate_limit_error...}"
        |
        v
piAssistantContentToChatContent()
        |
        v
{ type: "error", title: "Assistant error", error: rawMessage }
        |
        v
MessageBubble renders a destructive "Assistant error" card
```

Relevant code:

- [workers/main/src/durable-objects.ts](../workers/main/src/durable-objects.ts) converts Pi assistant `errorMessage` into a content block with title `"Assistant error"`.
- [src/components/message-bubble.tsx](../src/components/message-bubble.tsx) renders every `ContentBlock` with `type === "error"` as a destructive card and prints `block.title || "Error"` plus `block.error`.
- In the Pi `agent_end` fallback, if no normal assistant text exists but an `errorMessage` does exist, the DO can also push a runtime `agentMessage` item whose text is the raw error.

The implementation must cover both:

1. The live `ChatErrorNotice` shown after a failed turn.
2. Transcript error blocks so users do not reload into a raw `Assistant error 429 ...` card.

### Hosted credit and billing errors already have special handling

Hosted-credit errors are already differentiated:

- [workers/main/src/durable-objects.ts](../workers/main/src/durable-objects.ts) `checkHostedPiModelAccess()` throws explicit billing/credit messages.
- [src/components/Chat.tsx](../src/components/Chat.tsx) maps hosted-credit exhaustion to `CREDIT_SEND_BLOCKED_MESSAGE`.
- [src/lib/chat-credit-status.ts](../src/lib/chat-credit-status.ts) builds low/exhausted credit state.
- [src/routes/dev.chat-credit-states.tsx](../src/routes/dev.chat-credit-states.tsx) previews credit banners and the inline send failure.

Do not route provider 429s through the hosted-credit copy. Provider 429s need separate classification.

### BYOK routing state already exists

The chat routes already load and pass the org's LLM provider config:

- Existing-thread route: [src/routes/_app.chat.$id.tsx](../src/routes/_app.chat.$id.tsx)
- New-chat route: [src/routes/_app.chat._index.tsx](../src/routes/_app.chat._index.tsx)
- Chat prop: `llmProvider?: LlmProvider | null` in [src/components/Chat.tsx](../src/components/Chat.tsx)

The routing policy lives in [src/lib/llm-provider-config.ts](../src/lib/llm-provider-config.ts):

- `getChatHarnessesForLlmProvider("anthropic") -> ["claude"]`
- `getChatHarnessesForLlmProvider("bedrock") -> ["claude"]`
- `getChatHarnessesForLlmProvider("openai") -> ["codex"]`
- `getChatHarnessesForLlmProvider("openrouter") -> ["codex", "claude"]`

The Durable Object has even stronger runtime knowledge in `resolvePiRequestConfig()`:

- `billingSource: "byok"` when the selected model is actually using user credentials.
- `billingSource: "hosted"` when camelAI hosted credentials are used.

Implementation should prefer server-provided `billingSource` metadata on new error events, then fall back to the client-side `llmProvider + threadProvider` check for old events and initial route state.

## Desired Decision Tree

```text
Incoming chat/provider error
        |
        v
Parse status/type/message from raw error
        |
        +-- not a 429/rate_limit_error/rate-limited message
        |       |
        |       v
        |   Existing generic handling
        |
        +-- rate limit
                |
                v
        Was this turn using BYOK credentials?
                |
        +-------+--------+
        |                |
       yes               no
        |                |
        v                v
  User provider      camelAI hosted
  responsibility     provider issue
        |                |
        v                v
  "Your Anthropic    "The model provider is
   API key is         temporarily rate limiting
   rate limited..."   camelAI..."
```

Important nuance: "an API key exists" is necessary but not always sufficient. If an org has an OpenAI key but the current thread is using a Claude model, that turn is hosted, not BYOK. Use `billingSource` when available; otherwise use `getChatHarnessesForLlmProvider(llmProvider).includes(threadProvider)`.

## UX Copy

### BYOK rate limit

Use provider labels from [src/lib/byok-providers.ts](../src/lib/byok-providers.ts), falling back to `"your API provider"`.

```text
Title: Your Anthropic API key is rate limited

Body: Anthropic rejected this request because your account hit an API rate limit.
This limit is controlled by Anthropic, not camelAI. Increase your limits in
Anthropic, reduce current usage, or wait 60 seconds and try again.
```

For providers with awkward labels:

- OpenRouter: `Your OpenRouter API key is rate limited`
- OpenAI: `Your OpenAI API key is rate limited`
- Bedrock: `Your Bedrock API key is rate limited`
- Unknown configured provider: `Your API key is rate limited`

Do not show the raw `Type 2b` message as primary copy. It can remain in `console.error` and observability.

### Hosted rate limit

```text
Title: The model provider is temporarily rate limiting camelAI

Body: Wait 60 seconds and try again. If this keeps happening, contact support.
Your workspace is saved.
```

Do not tell hosted users to adjust Anthropic/OpenAI/OpenRouter limits. They do not control camelAI's provider account.

### Existing hosted-credit exhaustion

Leave the existing credit-exhaustion copy and `BillingCreditNotice` behavior alone. That is a different condition from provider rate limiting.

## ASCII Design

Render the BYOK rate-limit message as a compact non-destructive alert in the same place as `ChatErrorNotice` and inside transcript error blocks.

```text
+----------------------------------------------------------------------+
|  [clock] Your Anthropic API key is rate limited                  [x] |
|          Anthropic rejected this request because your account hit an  |
|          API rate limit. This limit is controlled by Anthropic, not   |
|          camelAI. Increase your limits in Anthropic, reduce current   |
|          usage, or wait 60 seconds and try again.                    |
+----------------------------------------------------------------------+
```

Hosted fallback:

```text
+----------------------------------------------------------------------+
|  [clock] The model provider is temporarily rate limiting camelAI [x] |
|          Wait 60 seconds and try again. If this keeps happening,      |
|          contact support. Your workspace is saved.                   |
+----------------------------------------------------------------------+
```

Suggested visual treatment:

- Use shadcn `Alert` or the same token style as `ChatErrorNotice`, but do not use `variant="destructive"` for rate limits.
- Icon: `Clock3` or `Gauge` from `lucide-react`.
- Container: `rounded-lg border bg-card px-3 py-2 text-sm`.
- Title: `text-sm font-medium`.
- Body: `text-xs text-muted-foreground` or `text-sm text-muted-foreground` depending on final density.
- Dismiss button stays available for live chat errors. Transcript error blocks do not need dismiss.

## Implementation Plan

### 1. Add a pure provider-error classifier

Create [src/lib/chat-api-errors.ts](../src/lib/chat-api-errors.ts).

Suggested API:

```ts
export interface ChatApiErrorDetails {
  rawMessage: string;
  status: number | null;
  providerErrorType: string | null;
  providerMessage: string | null;
  isRateLimit: boolean;
}

export interface ChatApiErrorContext {
  billingSource?: "byok" | "hosted" | null;
  llmProvider?: LlmProvider | null;
  threadProvider?: ChatHarness | null;
}

export type ChatApiErrorPresentation =
  | {
      kind: "byok_rate_limit";
      title: string;
      message: string;
      providerLabel: string | null;
    }
  | {
      kind: "hosted_rate_limit";
      title: string;
      message: string;
    }
  | {
      kind: "generic";
      title?: string;
      message: string;
    };
```

Parsing requirements:

- Accept `unknown`, `Error`, strings, and already-parsed objects.
- Extract a status from strings like:
  - `429 {"error":{"type":"rate_limit_error","message":"Type 2b rate limited. Please try again later."}}`
  - `API Error: 429 {...}`
  - `Error: 429 {...}`
  - `Bedrock request failed with HTTP 429: ...`
- Parse a JSON object embedded inside a larger string when possible.
- Support both Anthropic-style error objects and simpler strings:
  - `{ "error": { "type": "rate_limit_error", "message": "..." } }`
  - `{ "error": "Usage limit exceeded..." }`
  - `{ "message": "..." }`
- Treat as rate limit if:
  - status is `429`, or
  - provider error type is `rate_limit_error`, or
  - normalized text includes `rate limit`, `rate-limited`, or `rate limited`.

Classification requirements:

- `isCurrentTurnByok` is true when:
  - `context.billingSource === "byok"`, or
  - no `billingSource` exists and `llmProvider` is configured and `threadProvider` is included in `getChatHarnessesForLlmProvider(llmProvider)`.
- If `context.billingSource === "hosted"`, always classify a 429 as hosted even if an org has some API key configured.
- BYOK classification uses `getByokProviderLabel(llmProvider)` for copy.
- Generic classification should preserve the current message behavior, except the broad 429 fallback must be removed from `normalizeChatErrorMessage()` and delegated to this classifier.

Add focused unit tests in [tests/chat-api-errors.test.ts](../tests/chat-api-errors.test.ts):

- Anthropic `rate_limit_error` JSON with `billingSource: "byok"` produces BYOK copy and does not include `Type 2b`.
- Same raw error with `billingSource: "hosted"` produces hosted copy.
- Same raw error with `llmProvider: "anthropic"` and `threadProvider: "claude"` produces BYOK copy.
- Same raw error with `llmProvider: "openai"` and `threadProvider: "claude"` produces hosted copy.
- Non-429 generic errors preserve the existing message.
- JSON `{ error: "..." }` still extracts string errors.

### 2. Replace chat error normalization in `Chat.tsx`

Update [src/components/Chat.tsx](../src/components/Chat.tsx):

- Replace the current `normalizeChatErrorMessage(error: unknown): string` shape with either:
  - `normalizeChatErrorPresentation(error, context): ChatApiErrorPresentation`, or
  - keep `error` state as a string for generic errors and add a parallel `errorPresentation` derivation.
- At every `setError(normalizeChatErrorMessage(...))` call, pass context:
  - `llmProvider`
  - active `threadProvider` or `initialThreadProvider`
  - `billingSource` if present on the WebSocket error event.
- For `data.type === "error"`, read optional metadata:
  - `data.billingSource`
  - `data.provider`
  - `data.errorType`
  - `data.status`
- Render a new rate-limit notice when the presentation kind is `byok_rate_limit` or `hosted_rate_limit`.

Avoid introducing a second normalization path. Initial route errors, new-chat action errors, websocket errors, and local catch handlers should all use the same helper.

### 3. Add server metadata to new DO error events

Update [workers/main/src/durable-objects.ts](../workers/main/src/durable-objects.ts) so new Pi provider errors include enough metadata for the client to make a reliable decision:

```ts
this.pushChatEvent({
  type: "error",
  error: rawErrorMessage,
  source: "chat_thread_do_pi",
  billingSource: this.piCurrentBillingSource,
  provider: this.piCurrentUsageProvider,
});
```

Do this in the Pi prompt catch in `sendRunnerCommand()`. If there are other provider-error emission points where `piCurrentBillingSource` is available, include it there too.

Do not add secrets, API keys, request bodies, or provider response bodies beyond the existing error string.

### 4. Normalize persisted assistant error blocks

Update the transcript path so old and new assistant error blocks also get humanized:

- In [src/components/message-bubble.tsx](../src/components/message-bubble.tsx), when rendering `block.type === "error"`, classify `block.error`.
- Pass enough context into `MessageBubble` or `ContentBlockRenderer`:
  - `llmProvider`
  - `threadProvider`
  - optional `billingSource` if the content block is extended later.
- If the block is a BYOK or hosted rate limit, render the same non-destructive rate-limit notice and suppress the `"Assistant error"` title.
- Otherwise keep the existing destructive generic error card.

This protects users who reload after the failed turn and see a persisted Pi `errorMessage`.

Implementation note: threading `llmProvider` and `threadProvider` from `Chat` -> `ChatMessagesView` -> `MessageBubble` is a small prop change. Keep it explicit rather than using global state.

### 5. Avoid raw runtime provider-error text

In [workers/main/src/durable-objects.ts](../workers/main/src/durable-objects.ts), the Pi `agent_end` fallback can push an `item/completed` runtime event with `text: finalText` where `finalText` is actually an error message.

Update this fallback so provider rate-limit errors do not become normal assistant text:

- Prefer pushing a chat `type: "error"` event with metadata.
- If a transcript message must be persisted, persist it as an error block/message that the client can classify, not a normal assistant text block.
- Do not stream `Type 2b` as a normal assistant response.

### 6. Extend the local preview route

Use the existing local playground at [src/routes/dev.chat-credit-states.tsx](../src/routes/dev.chat-credit-states.tsx). Keep the route path `/dev/chat-credit-states` to avoid churn, but expand the page title and state list to include provider rate-limit previews.

Add preview states:

- `byok-anthropic-429`
- `byok-openrouter-429`
- `hosted-429`
- `generic-error`

The preview should render:

- The live chat error notice variant.
- A transcript-style assistant error block variant, so both surfaces are visible.

Sample raw error fixture:

```ts
const ANTHROPIC_2B_RATE_LIMIT =
  '429 {"error":{"type":"rate_limit_error","message":"Type 2b rate limited. Please try again later."}}';
```

Preview expectations:

- BYOK states show provider-account copy and no raw `Type 2b`.
- Hosted state says camelAI's model provider is temporarily rate limiting requests.
- Generic state still shows the destructive generic error surface.

### 7. Optional: improve AI provider test errors

[src/routes/api/orgs.$id.llm-provider.ts](../src/routes/api/orgs.$id.llm-provider.ts) currently returns strings like `API returned 429: ...` when testing a saved key.

This is not the reported chat error path, so treat it as optional unless scope is small. If touched, reuse the same parser and copy for `testProvider` so a rate-limited Anthropic validation call says to wait 60 seconds or adjust provider limits.

## Files to Modify

| File | Change |
| --- | --- |
| [src/lib/chat-api-errors.ts](../src/lib/chat-api-errors.ts) | New pure parser/classifier for provider API errors and rate-limit presentations. |
| [src/components/Chat.tsx](../src/components/Chat.tsx) | Replace broad string-only 429 handling with classifier-backed rendering. Pass BYOK/thread context into normalization. |
| [src/components/message-bubble.tsx](../src/components/message-bubble.tsx) | Classify and render persisted `type: "error"` blocks with the same rate-limit messaging. |
| [src/lib/runtime-message-state.ts](../src/lib/runtime-message-state.ts) | Only if needed to prevent provider errors from becoming normal assistant text. |
| [workers/main/src/durable-objects.ts](../workers/main/src/durable-objects.ts) | Add `billingSource`/provider metadata to Pi error events and avoid streaming raw provider errors as normal assistant text. |
| [src/routes/dev.chat-credit-states.tsx](../src/routes/dev.chat-credit-states.tsx) | Add 429/BYOK/hosted preview states. |
| [tests/chat-api-errors.test.ts](../tests/chat-api-errors.test.ts) | New parser/classifier tests. |
| Existing component tests near `message-bubble` / `Chat` | Add rendering coverage for BYOK 429, hosted 429, and generic error fallback. |

## Acceptance Criteria

- A BYOK Anthropic 429 with `rate_limit_error` shows:
  - `Your Anthropic API key is rate limited`
  - `controlled by Anthropic, not camelAI`
  - `wait 60 seconds and try again`
- The user-facing BYOK 429 UI does not show `Type 2b` or raw JSON.
- A hosted 429 does not tell the user to adjust Anthropic/OpenAI/OpenRouter limits.
- Hosted-credit exhaustion still shows the existing credit/top-up messaging.
- Reloading a thread after a BYOK 429 does not show a raw `Assistant error 429 ...` card.
- The local preview route can show BYOK 429, hosted 429, and generic error states without triggering real provider calls.
- No API keys, request bodies, auth headers, or chat transcript contents are added to observability.

## Test Plan

Run:

```bash
bun run test:run -- tests/chat-api-errors.test.ts tests/message-bubble-content-to-string.test.ts tests/message-bubble-parsers.test.ts
bun run typecheck
```

If component coverage is added in a new or existing test file, include that file in the targeted `bun run test:run` command.

Manual checks:

1. Start `bun run dev`.
2. Open `/dev/chat-credit-states`.
3. Verify BYOK Anthropic/OpenRouter 429 states use provider-account copy and hide raw `Type 2b`.
4. Verify hosted 429 state says camelAI is temporarily rate limited by the model provider.
5. Verify generic errors still render as generic errors.
6. Verify the real chat route still handles `?devCreditState=exhausted&devChatError=out-of-credits` exactly as before.

## Out of Scope

- Explaining what Anthropic `Type 2b` means. It is internal and undocumented.
- Automatically retrying failed turns after 60 seconds.
- Changing provider rate limits from camelAI.
- Changing hosted-credit thresholds or billing enforcement.
- Adding provider-limit documentation links unless a stable provider-specific URL is added to `BYOK_PROVIDERS` in the same change.
