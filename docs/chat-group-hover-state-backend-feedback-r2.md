# Chat Group Hover State Backend Review Feedback

## Findings

### High: Summary generation needs an explicit pending/failed state

Completed-thread hover data still exposes only `last_assistant_summary: string | null`, so the client cannot distinguish these cases:

- summary generation has not finished yet
- summary generation failed or returned empty
- no summary exists because there was no usable source text

Relevant code:

- `workers/main/src/auth.ts:421` and `workers/main/src/auth.ts:422` add only `last_assistant_completed_at` and `last_assistant_summary`.
- `workers/main/src/chat-thread-do.ts:4391` persists completion with `summary = null`, then `workers/main/src/chat-thread-do.ts:4401` starts summary generation.
- `workers/main/src/chat-thread-do.ts:4447` returns on an empty generated summary without writing any terminal state.
- `workers/main/src/chat-thread-do.ts:4456` catches generator failures but also leaves persistence at `summary = null`.
- `src/lib/chat-groups.server.ts:130` through `src/lib/chat-groups.server.ts:132` exposes only the timestamp and nullable summary to the hover model.
- `src/types.ts:55` through `src/types.ts:57` has no summary status field.

This directly leaves the UI with the current behavior: a completed row appears without subheader content, then grows when the summary arrives. It also prevents a non-indefinite loading state because failure is indistinguishable from pending.

Recommended backend shape:

- Add persisted state such as `last_assistant_summary_status: "pending" | "ready" | "failed" | null`.
- Optionally add `last_assistant_summary_requested_at`, `last_assistant_summary_updated_at`, and internal-only failure metadata for diagnosis.
- On turn completion, persist `last_assistant_completed_at`, clear old summary text, and set summary status to `pending` before kicking off the summarizer.
- On generated non-empty summary, persist the text and set status to `ready`.
- On generator failure or empty output, set status to `failed` so the UI can stop showing the reserved loading state.
- Expose that status in `Thread`, `ChatGroupThreadSummary`, and `hydrateChatGroups`.
- Add worker tests for pending, ready, failed, and empty-summary transitions.

I would not hold the thread out of the Completed section while the summary is pending. Completion and summary readiness are separate states, and the thread should still be unread/completed even when the summarizer fails.

### High: The summary source extractor misses actual Pi tool-result messages

The implementation is trying to scan the tail of the completed message list, which is the right direction. The extractor currently accepts `role === "assistant"` or `role === "tool"`:

- `src/lib/thread-completion-summary-generation.server.ts:94` through `src/lib/thread-completion-summary-generation.server.ts:100`

But Pi tool results in this codebase use `role: "toolResult"`:

- `workers/main/src/chat-thread-do.ts:6564`
- `workers/main/src/pi-message-history.ts:64`

The unit test currently uses `role: "tool"` at `workers/main/tests/thread-completion-summary-generation.test.ts:57`, so it does not cover the real Pi shape. In the case the user called out, where the useful final conclusion is the tail tool/result record from the JSONL/runtime stream, the summarizer can miss the source and fall back to less useful text or no summary.

Recommended fix:

- Treat `role === "toolResult"` as an eligible tail message.
- Keep `role === "tool"` only if another provider actually emits that shape.
- Add a test fixture using the real Pi `toolResult` shape with `content: [{ type: "text", text: "..." }]`.
- Include a regression test where the last assistant message is a tool call and the following `toolResult` contains the summary-worthy conclusion.

### Medium: Summary readiness uses a coarse group metadata refresh path

The backend emits a second workspace `thread_status` event after summary generation solely to make clients revalidate:

- `workers/main/src/chat-thread-do.ts:4448` through `workers/main/src/chat-thread-do.ts:4455`
- `workers/main/src/workspace.ts:353` through `workers/main/src/workspace.ts:357`

On the client, this currently reaches the sidebar through the same broad status revalidation path:

- `src/hooks/use-chat-groups.tsx:553` through `src/hooks/use-chat-groups.tsx:555`

That revalidation hydrates all chat groups by loading each thread one by one:

- `src/lib/chat-groups.server.ts:64` through `src/lib/chat-groups.server.ts:78`
- each call goes through `src/lib/chat-do.server.ts:406` through `src/lib/chat-do.server.ts:417`, which re-fetches workspace/org context and then one thread

This is not the P0 app-wide slowdown root cause, and it should not be treated as evidence that the hover popover caused that issue. It is still avoidable backend/data-flow work and will cost more as group counts grow. A single summary-ready transition can cause a sidebar data refresh across every group/thread even though only one thread's summary state changed.

Recommended backend/data-flow fix:

- Add a batch thread metadata read path on `OrgDO`, for example `getThreadsByIds(workspaceId, threadIds)`, and use it from `hydrateChatGroups` instead of per-thread `getThread` RPCs.
- Once summary status exists, either include a narrow summary-state revision in the workspace status event or add a targeted refresh path so summary completion does not require reloading every group. If the separate P0 performance branch removes broad active-route revalidation for status updates, this item can be narrowed to just the remaining group-metadata hydration cost.
- Dedupe no-op status frames so the same `status + completedAt + summaryState` does not schedule another full loader pass.

## Verification

I ran:

- `bun run test:run -- tests/thread-preview.test.ts tests/chat-group-hover-time.test.ts tests/chat-group-hover-card.test.tsx tests/chat-groups-ui.test.tsx`
- `bun run test:workers -- workers/main/tests/chat-thread-completion-summary.test.ts workers/main/tests/thread-completion-summary-generation.test.ts workers/main/tests/auth-do.test.ts`
- `bun run typecheck`

All passed.
