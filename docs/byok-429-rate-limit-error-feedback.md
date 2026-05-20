# BYOK 429 Rate Limit Error - Implementation Feedback

## Overall

The implementation is on the right path: API error parsing is centralized in `src/lib/chat-api-errors.ts`, the visible copy hides Anthropic's internal `Type 2b` wording, and the current live WebSocket path now receives `billingSource` from `ChatThreadDO`.

There are a few changes I would make before shipping. The biggest gaps are provider link support, using the provider value already sent by the worker, and making persisted transcript errors carry enough metadata to avoid misclassifying old errors.

## Issues

### 1. Add the provider API link from the central BYOK metadata (Medium)

**Files:**
- `src/lib/chat-api-errors.ts` lines 22-38 and 225-238
- `src/components/chat-api-error-notice.tsx` lines 27-33
- `src/lib/byok-providers.ts` lines 25-93
- `src/components/byok/byok-provider-info-card.tsx` lines 26-34

The new BYOK rate-limit message says to increase limits in the provider, but it does not include a clickable provider link yet. The central provider metadata already exists in `BYOK_PROVIDERS` and includes both `getKeyUrl` and `getKeyLinkLabel` for OpenRouter, Anthropic, OpenAI, and Bedrock.

Use that same central metadata rather than hardcoding links in the alert. A good shape is:

```ts
type ChatApiErrorPresentation =
  | {
      kind: "byok_rate_limit";
      title: string;
      message: string;
      providerLabel: string | null;
      providerUrl: string | null;
      providerLinkLabel: string | null;
    }
```

Then render an anchor in `ChatRateLimitNotice` only when `providerUrl` is present. Reuse the visual pattern from `ByokProviderInfoCard`: external link, `target="_blank"`, `rel="noreferrer"`, and a small icon if desired.

Suggested copy:

```text
Open Anthropic API settings
Open OpenAI API settings
Open OpenRouter API settings
Open the AWS Bedrock console
```

The last label can come directly from `BYOK_PROVIDERS.bedrock.getKeyLinkLabel`; the other providers can either reuse `getKeyLinkLabel` or add a second centralized label if "Get a key" feels too onboarding-specific for this alert.

### 2. Use the provider sent by the worker on live error events (Medium)

**Files:**
- `workers/main/src/durable-objects.ts` lines 9373-9377
- `src/components/Chat.tsx` lines 3022-3036
- `src/lib/chat-api-errors.ts` lines 216-238

`ChatThreadDO.piProviderErrorEvent()` now sends both `billingSource` and `provider`, but the client only reads `billingSource`. In the common path, `llmProvider` will usually still make Anthropic, OpenRouter, OpenAI, and Bedrock display correctly. However, the event provider is more authoritative for the failed request.

This matters when:

- `billingSource` is `byok` but `llmProvider` is null or stale.
- The current org provider differs from the provider actually used for the failed request.
- We add the provider URL, because a stale provider would send the user to the wrong console.

Validate `data.provider` against the BYOK provider set and pass it into classification:

```ts
const eventProvider = parseByokProvider(data.provider);
showChatError(errorPayload, {
  billingSource,
  llmProvider: eventProvider ?? llmProvider,
});
```

This also answers the provider-name question: the current helper can label all four providers, but the live error path should prefer the worker's provider value so OpenAI and Bedrock are treated as well as Anthropic and OpenRouter.

### 3. Persisted transcript error blocks infer BYOK from current settings (Medium)

**Files:**
- `workers/main/src/durable-objects.ts` lines 5398-5402
- `src/components/message-bubble.tsx` lines 415-421
- `src/lib/chat-api-errors.ts` lines 216-223
- `src/types.ts` lines 140-148

Persisted assistant error blocks only contain `title` and `error`. The renderer classifies a persisted 429 using the current `llmProvider` and `threadProvider`, not the billing source/provider that were true when the error happened.

That can mislead users in historical transcripts. For example, a hosted-model 429 from before a user added an Anthropic key can later render as "Your Anthropic API key is rate limited" because the org now has an Anthropic provider configured.

Extend `ErrorBlock` with optional metadata and write it when creating Pi provider error blocks:

```ts
interface ErrorBlock {
  type: "error";
  error: string;
  title?: string;
  billingSource?: "byok" | "hosted";
  provider?: LlmProvider;
  status?: number;
  errorType?: string;
}
```

Then pass those fields into `getChatApiErrorPresentation()` from `ContentBlockRenderer`. For older blocks without metadata, prefer the current fallback behavior or a conservative hosted/generic fallback, but new errors should not rely only on current org settings.

### 4. Add OpenAI and Bedrock preview states (Low)

**File:** `src/routes/dev.chat-credit-states.tsx` lines 10-49

The playground currently adds Anthropic, OpenRouter, hosted, and generic error states. Add BYOK OpenAI and BYOK Bedrock cases so local reviewers can quickly verify labels and links for all supported providers.

Suggested states:

```text
byok-openai-429
byok-bedrock-429
```

## Provider Names

OpenAI and Bedrock can be labeled correctly because `getByokProviderLabel()` reads from `BYOK_PROVIDERS`, which includes:

- `OpenRouter`
- `Anthropic`
- `OpenAI`
- `Bedrock`

The current implementation should display those names when `context.llmProvider` is set to that provider. The improvement above is to prefer the request-time provider from the worker event, then fall back to the org-level provider.

## Suggested Flow

```text
Provider error
     |
     v
Worker event: error + billingSource + provider
     |
     v
Client parser: status/type/message
     |
     v
Classifier
  |-- billingSource=byok
  |     |
  |     v
  |   BYOK_PROVIDERS[provider] -> label + central URL + user-owned copy
  |
  |-- billingSource=hosted
        |
        v
      camelAI/provider outage copy, no provider API link
```

## Test Audit

Current coverage is useful but not thorough enough for the provider-specific behavior.

Existing good coverage:

- `tests/chat-api-errors.test.ts` covers Anthropic BYOK copy, hosted override, harness fallback, generic errors, and embedded JSON parsing.
- `tests/message-bubble-content-to-string.test.ts` covers persisted BYOK rendering, persisted hosted rendering, and generic destructive rendering.
- Focused tests pass locally: `bun run test:run -- tests/chat-api-errors.test.ts tests/message-bubble-content-to-string.test.ts`.
- Typecheck passes locally: `bun run typecheck`.

Missing tests to add:

1. `tests/chat-api-errors.test.ts`
   - Parameterized BYOK 429 cases for `anthropic`, `openrouter`, `openai`, and `bedrock`.
   - Assert each case includes the correct provider label.
   - After adding link metadata, assert each case includes the URL from `BYOK_PROVIDERS[provider].getKeyUrl`.
   - Assert hosted 429 never includes a provider URL.

2. `tests/message-bubble-content-to-string.test.ts` or a focused component test for `ChatRateLimitNotice`
   - Render a BYOK rate-limit notice and assert the link is present, clickable, and points to the central URL.
   - Render a hosted rate-limit notice and assert no provider link is shown.
   - Render Bedrock specifically, because its link label differs from the other providers.

3. A Chat WebSocket handling test, likely near existing chat UI socket tests
   - Emit `{ type: "error", error: RATE_LIMIT, billingSource: "byok", provider: "bedrock" }`.
   - Assert the visible notice says "Your Bedrock API key is rate limited".
   - Assert the link points to `BYOK_PROVIDERS.bedrock.getKeyUrl`.
   - This test should fail with the current code if `llmProvider` is null and only the event provider is available.

4. A persisted transcript metadata test
   - Render an error block with `billingSource: "hosted"` while the current org provider is `anthropic`.
   - Assert it still renders hosted copy, not Anthropic BYOK copy.
   - Render an error block with `billingSource: "byok", provider: "openai"` and assert OpenAI BYOK copy.

## Non-Blocking Notes

- The hosted copy is appropriately different from BYOK copy and does not blame the user.
- The parser correctly suppresses the raw `Type 2b` text in the specialized rate-limit presentations.
- Consider renaming `llmProvider` inside the classifier context to `provider` or `requestProvider` once event metadata is used. The current name makes it easy to accidentally pass org-level configuration when request-level provider is what the copy needs.
