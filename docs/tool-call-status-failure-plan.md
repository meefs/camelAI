# Tool Call Failure Status Plan

**Date:** June 16, 2026  
**Scope:** chat tool-call status dots for Pi/Codex runtime tool events

## Objective

Tool calls in chat must show:

- running: blue pulsing dot
- succeeded: solid green dot
- failed: solid red dot

The running state already works. The bug is that failed tool calls can render as green because the live runtime event path preserves failure only as text like `[status: failed]`, not as `ToolResultBlock` failure metadata.

## Smoking Gun

The backend already knows the Pi tool failed. In `workers/main/src/chat-thread-do.ts`, `tool_execution_end` maps `event.isError` to `status: "failed"` before emitting the live runtime item:

- `workers/main/src/chat-thread-do.ts:13121` computes `const status = event.isError ? "failed" : "completed";`
- `workers/main/src/chat-thread-do.ts:13134-13137` puts that status on the `commandExecution` runtime item.

The frontend then loses that failure signal:

- `src/lib/runtime-message-state.ts:1098-1112` formats the runtime item status into display text, producing output like `[status: failed]`.
- `src/lib/runtime-message-state.ts:1471-1500` returns only a string from `buildToolResultFromCodexItem()`.
- `src/lib/runtime-message-state.ts:814-828` creates a `tool_result` block without `is_error` or `status`.
- `src/components/tool-call/tool-status.ts:35` and `:42` only treat `is_error` as failed. They ignore the already-defined `ToolResultBlock.status?: "succeeded" | "failed"` field from `src/types.ts`.

So a failed Pi runtime event becomes:

```ts
{
  type: "tool_result",
  tool_use_id: "...",
  content: "...[status: failed]"
}
```

instead of:

```ts
{
  type: "tool_result",
  tool_use_id: "...",
  content: "...[status: failed]",
  is_error: true,
  status: "failed"
}
```

`getToolStatus()` sees a result block with no error metadata and returns `complete`, which renders the green dot.

## Current Data Paths

There are two paths to keep aligned:

1. **Persisted Pi transcript path:** `workers/main/src/chat-thread-do.ts:7635-7652`
   - `attachPiToolResultToParsedMessages()` already creates `ToolResultBlock` with both `is_error` and `status`.
   - Keep this behavior unchanged and covered by the frontend status helper.

2. **Live runtime event path:** `workers/main/src/chat-thread-do.ts:13116-13147` -> `src/lib/runtime-message-state.ts`
   - This is the bug path for the live chat indicator.
   - `item/completed` carries `status: "failed"`, but `runtime-message-state.ts` turns it into result text only.

## Implementation Plan

## Phase 1: Normalize The Runtime Event Contract (P0)

File: `workers/main/src/chat-thread-do.ts`

Update the Pi `tool_execution_end` runtime item payload so completed tool items carry an explicit boolean failure flag in addition to the existing string status.

In the branch at `workers/main/src/chat-thread-do.ts:13116-13147`:

1. Keep `status` as `"failed"` when `event.isError` is true and `"completed"` otherwise.
2. Add `isError: event.isError === true` to every `item` object emitted through `item/completed`.
3. For `bash`/`commandExecution`, preserve the existing `command`, `cwd`, `description`, `aggregatedOutput`, and `result` fields.
4. For non-bash `dynamicToolCall`, preserve the existing `tool`, `arguments`, `contentItems`, and `result` fields.

After this phase, live runtime items have a durable status contract:

```ts
{
  id: toolCallId,
  type: "commandExecution" | "dynamicToolCall",
  status: "failed" | "completed",
  isError: boolean,
  ...
}
```

## Phase 2: Make Tool Status Derivation Honor Result Metadata (P0)

File: `src/components/tool-call/tool-status.ts`

Add a small helper:

```ts
function isFailedToolResult(result?: ToolResultBlock): boolean {
  return Boolean(
    result &&
      (result.is_error === true ||
        (result as { status?: unknown }).status === "failed")
  );
}
```

Then use it in both places inside `getToolStatus()`:

- sub-agent final result branch
- normal tool result branch

This keeps persisted transcript results and live runtime results aligned. The UI status helper must recognize both failure fields because both exist in the repository's `ToolResultBlock` type.

Do not parse result content text such as `[status: failed]` in this helper. That would hide upstream contract bugs and risk false positives.

## Phase 3: Preserve Failure Metadata in Live Runtime Results (P0)

File: `src/lib/runtime-message-state.ts`

Change the result-building flow so runtime item status becomes `ToolResultBlock` metadata.

Use this local type:

```ts
type RuntimeToolResult = {
  content: string | ContentBlock[];
  isError: boolean;
};
```

Add a helper:

```ts
function isFailedRuntimeItem(item: CodexThreadItem): boolean {
  const status = typeof item.status === "string" ? item.status : "";
  return (
    item.isError === true ||
    status === "failed" ||
    status === "error" ||
    item.success === false ||
    (item.type === "commandExecution" &&
      typeof item.exitCode === "number" &&
      item.exitCode !== 0)
  );
}
```

Then update:

1. `buildToolResultFromCodexItem()`
   - Return `RuntimeToolResult | null` instead of `string | null`.
   - Keep existing formatter output as `content`.
   - Set `isError` from `isFailedRuntimeItem(item)`.

2. `upsertToolResultBlock()`
   - Accept failure metadata:

```ts
function upsertToolResultBlock(
  blocks: ContentBlock[],
  itemId: string,
  content: string | ContentBlock[],
  itemKind: string,
  options: { isError?: boolean } = {},
): ContentBlock[] { ... }
```

   - When `options.isError === true`, include:

```ts
is_error: true,
status: "failed",
```

   - When `options.isError !== true`, include `status: "succeeded"`.

3. `applyCodexItemCompleted()`
   - Pass the `isError` metadata from `buildToolResultFromCodexItem()` into `upsertToolResultBlock()`.

4. `appendToolResultText()`
   - Add the same failure metadata support so updates can mark an existing result as failed without replacing output.
   - In the AgentOS `tool_call_update` branch around `src/lib/runtime-message-state.ts:988-1027`, if `status === "failed"` and text is present, append the text and mark the result failed in the same update.

Important: keep all existing content formatting. The output text can still include `[status: failed]`; it must no longer be the only failure signal.

## Phase 4: Keep Existing Persisted Pi Transcript Behavior Stable (P1)

File: `workers/main/src/chat-thread-do.ts`

Do not change `attachPiToolResultToParsedMessages()`. It already emits the correct `ToolResultBlock` shape:

```ts
{
  type: "tool_result",
  tool_use_id: toolCallId,
  content,
  is_error: isError,
  status: isError ? "failed" : "succeeded",
}
```

The implementation must preserve this persisted/reload behavior while fixing the live runtime path.

## Tests

Add focused tests with the fix.

## Unit Tests

File: `tests/tool-status.test.ts`

Add:

1. `getToolStatus()` returns `error` for `{ status: "failed" }` even when `is_error` is absent.
2. Sub-agent final result with `{ status: "failed" }` returns `error`.
3. A succeeded result still returns `complete`.

File: `tests/runtime-tool-status.test.ts`

Add runtime event tests:

1. `commandExecution` live event:
   - Start item with `status: "running"`.
   - Complete item with `status: "failed"` and `aggregatedOutput` similar to the reported validation failure.
   - Assert the resulting `tool_result` block has `is_error: true` and `status: "failed"`.

2. `dynamicToolCall` live event:
   - Complete item with `status: "failed"` or `success: false`.
   - Assert the same failed metadata.

3. AgentOS `tool_call_update`:
   - Send an update with both text output and `status: "failed"`.
   - Assert the existing/created `tool_result` is marked failed.

File: `tests/tool-call-status-rendering.test.tsx`

Add a component test:

- Render `ToolCall` with a failed result and assert the dot gets the red class (`bg-red-500`).
- Render `ToolCall` with a succeeded result and assert the dot gets the green class (`bg-green-500`).

## Verification Commands

```bash
bun run test:run -- tests/tool-status.test.ts tests/runtime-tool-status.test.ts tests/tool-call-status-rendering.test.tsx
bun run typecheck
```

## Manual QA

1. In a local chat turn, trigger a tool that fails before or during execution.
2. Confirm the row is blue while running.
3. Confirm the same row becomes red when the result arrives.
4. Confirm a successful tool call still becomes green.
5. Reload the chat and confirm the persisted transcript still shows the failed row as red.

Useful failure cases:

- a command that exits non-zero
- a Pi validation failure like the reported `bash` call with unsupported extra arguments
- a dynamic tool call that returns `status: "failed"` or `success: false`

## Acceptance Criteria

1. Live failed Pi tool calls render a red status dot immediately when the failed result arrives.
2. Reloaded/historical failed tool calls still render red.
3. Running and successful tool-call states are unchanged.
4. No UI code scrapes `[status: failed]` from display text to determine state.
5. Runtime `item/completed` payloads include both `status` and `isError`.
6. `ToolResultBlock` instances created from live runtime events include `is_error` and `status`.
7. Tests cover the UI status helper, runtime-event normalization path, and rendered dot color.

## Risk Notes

- The largest risk is marking ambiguous statuses as failures. Keep `isFailedRuntimeItem()` conservative: `failed`, `error`, explicit `success: false`, and non-zero command exit codes.
- Do not change `agentContinued` fallback behavior in `getToolStatus()`. It exists for orphaned/finalized tool rows and is not the root cause here.
- Be careful when updating `appendToolResultText()` so streamed output deltas remain appended rather than replaced.
