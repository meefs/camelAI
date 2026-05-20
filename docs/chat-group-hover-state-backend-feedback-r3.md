# Chat Group Hover State Backend Review Feedback R3

## New Feature Request

We need to change the in-progress chat-row subheader from "the latest user message" to "the latest running activity in this thread."

Desired user-visible behavior:

- Immediately after the user sends a message, the in-progress subheader can show that user message.
- Once the agent starts working, replace that subheader with the most recent meaningful agent activity.
- Examples of valid activity text:
  - `Thinking`
  - `Read settings.ts`
  - `Running typecheck...`
  - `The phrase "HTML renderer" maps to two likely paths here:...`
- This is not an AI-generated summary. It should be deterministic text derived from the live turn events.
- It should be a short plain-text string. The UI will clip it to one line with ellipsis, but the backend should still cap and normalize it so payloads stay small.

Prescriptive backend direction:

- Do not overload `latest_user_message`; keep it as a user-message preview.
- Add a separate running-only field such as `running_activity_text`.
- Do not read JSONL/transcript files to compute this.
- Do not call a model.
- Derive the value at event time from the runtime events that already pass through `ChatThreadDO`.
- Store the latest value in `WorkspaceDO` as ephemeral running-thread metadata so reconnects and route hydration can recover it.
- Broadcast changes through the existing workspace status socket with throttling/dedupe.

## Findings

### High: Running rows still only model the latest user message

The current backend/data model cannot support this new in-progress subheader yet. It exposes `latest_user_message`, not "latest activity":

- `src/types.ts:56` has `latest_user_message`, but no running/latest activity field.
- `src/hooks/use-chat-groups.tsx:33` through `src/hooks/use-chat-groups.tsx:39` tracks `latestUserMessage`, but no activity text.
- `src/components/sidebar/chat-group-hover-card.tsx:174` through `src/components/sidebar/chat-group-hover-card.tsx:177` renders that user-message field in the running row.
- `src/components/Chat.tsx:230` through `src/components/Chat.tsx:239` and `src/components/Chat.tsx:3892` through `src/components/Chat.tsx:3895` only optimistically publish the user's just-sent text.

That is correct for the old spec, but it will not show `"Thinking"`, `"Read <file>"`, or intermediate assistant text. Treat this as a new backend feature, not as a styling change. The rest of this doc describes the expected data model and event pipeline.

### Medium: Running status snapshots only include ids

The initial workspace status snapshot currently sends only `runningThreadIds`:

- `workers/main/src/workspace.ts:422` through `workers/main/src/workspace.ts:428`

The route-side group hydration also only asks WorkspaceDO for ids:

- `src/lib/chat-groups.server.ts:40` through `src/lib/chat-groups.server.ts:50`
- `src/lib/chat-groups.server.ts:88` through `src/lib/chat-groups.server.ts:100`

If latest running activity is only sent as transient socket frames, reconnects and route loads will lose it. The WorkspaceDO streaming table already has the right ownership boundary, but it needs to store lightweight running metadata, not just the fact that a thread is running.

### Medium: Summary-ready state is now mostly live-event dependent

The latest implementation fixed the coarse summary revalidation path by carrying summary status/text over the workspace status socket. That is directionally good. The tradeoff is that a client that misses the summary-ready socket frame can keep showing pending state until some other loader refresh happens.

This is not a blocker for the in-progress activity change, but the same metadata-snapshot design below can also make reconnect behavior more robust for summary state if needed.

## Efficient Plan For Latest In-Progress Activity

### 1. Add an explicit running activity field

Add a field separate from `latest_user_message`, for example:

- `running_activity_text: string | null`
- optionally `running_activity_at: number | null`

Wire it through:

- `ChatGroupThreadSummary`
- `LiveThreadMetadata`
- workspace `thread_status` socket payload
- local optimistic `camelai:thread-status` event

Expected fallback behavior:

- On send, local optimistic state should set both `latest_user_message` and initial `running_activity_text` to the normalized user message.
- While a thread is running, the hover row should prefer `running_activity_text`.
- If no running activity exists yet, fall back to `latest_user_message`.
- When the thread stops running, clear the running activity from WorkspaceDO. Do not persist it on the long-lived `OrgDO` thread record.

### 2. Store ephemeral running metadata in WorkspaceDO

Extend `thread_streaming_status` with:

- `latest_activity_text TEXT`
- `latest_activity_at INTEGER`

Add a new WorkspaceDO read shape, for example:

```ts
type WorkspaceRunningThreadStatus = {
  threadId: string;
  startedAt: number;
  updatedAt: number;
  latestActivityText: string | null;
  latestActivityAt: number | null;
};
```

Keep `runningThreadIds` in the socket snapshot for backward compatibility, but add `runningThreads` with the richer metadata. Update `hydrateChatGroups` to consume this richer snapshot so first render and reconnects do not depend on a transient live frame.

Implementation details:

- Add a schema migration in `WorkspaceDO` for the two new columns.
- Keep `listStreamingThreadIds()` for existing callers.
- Add `listStreamingThreadStatuses()` or similar for richer callers.
- Update `sendThreadStatusSnapshot()` to include both `runningThreadIds` and `runningThreads`.
- Update `getStreamingThreadIds()` / `hydrateChatGroups()` to use the richer method and map `latestActivityText` into `ChatGroupThreadSummary.running_activity_text`.

### 3. Derive activity at event time in ChatThreadDO

`ChatThreadDO` already sees the right event stream:

- `workers/main/src/chat-thread-do.ts:6463` through `workers/main/src/chat-thread-do.ts:6725` handles Pi session activity.
- `workers/main/src/chat-thread-do.ts:6527` through `workers/main/src/chat-thread-do.ts:6550` sees thinking events.
- `workers/main/src/chat-thread-do.ts:6552` through `workers/main/src/chat-thread-do.ts:6563` sees assistant text deltas.
- `workers/main/src/chat-thread-do.ts:6565` through `workers/main/src/chat-thread-do.ts:6587` sees tool-call starts.
- `workers/main/src/chat-thread-do.ts:6626` through `workers/main/src/chat-thread-do.ts:6676` sees tool execution start/update/end.

Use those events to publish activity:

- User sends message: optimistic `running_activity_text` is the normalized user message.
- Reasoning starts: `"Thinking"`.
- Tool starts: running tool label, e.g. `"Reading <file>"`.
- Tool completes: completed tool label, e.g. `"Read <file>"`.
- Assistant text deltas: normalized current assistant text snippet.

The text should be raw deterministic output, not an AI summary. Normalize whitespace, strip system wrappers/annotations, and cap the stored string server-side, for example at 240 characters. The UI can still clip to one line.

Be specific about when to publish:

- On `agent_start`, initialize per-turn activity state and publish the optimistic user-message text only if the client provided one.
- On `thinking_start`, publish `Thinking` immediately.
- On `toolcall_start` / `tool_execution_start`, publish a running tool label immediately.
- On `tool_execution_end`, publish a completed or failed tool label immediately.
- On assistant text delta, maintain a rolling text snippet and publish it only through the throttled path.
- On `agent_end` / completion, stop publishing running activity and let the completed-summary flow take over.

### 4. Reuse one pure formatter for tool labels

The UI already has tool-label logic in `src/components/tool-call/tool-summary.ts`. That file is mostly pure, but it lives under `components`. Move the pure parts into a shared backend-safe module such as `src/lib/tool-activity-summary.ts`, then let both the UI and `ChatThreadDO` use it.

This avoids divergent labels where the active chat says one thing and the group hover says another.

### 5. Throttle and dedupe activity broadcasts

This is the main cost-control requirement.

In `ChatThreadDO`, keep small per-turn state:

- last activity text sent
- last activity sent timestamp
- current assistant text snippet
- pending throttled activity timer, if needed

Broadcast immediately for discrete state changes like thinking start, tool start, and tool completion. For assistant text deltas, broadcast at most once every 750-1000ms, or when a sentence/line boundary arrives. Do not broadcast every token.

In `WorkspaceDO`, include activity text in the existing dedupe key:

- current dedupe is at `workers/main/src/workspace.ts:392` through `workers/main/src/workspace.ts:411`
- add activity text/activity timestamp to that key

Persist/update activity only for running threads. Clear it when the thread leaves running state.

Suggested helper shape:

```ts
private publishRunningActivity(
  context: ChatContextState,
  activityText: string | null,
  options?: { immediate?: boolean },
): void
```

The helper should normalize/cap text, compare with the last sent value, enforce throttle for text deltas, and call `recordWorkspaceThreadStreaming(..., true, { activityText, activityAt })`.

### 6. Do not add a route fetch or model call

This should not require:

- reading the JSONL file
- hydrating full chat messages
- route revalidation
- per-hover API calls
- AI-generated summaries

The activity string is a live byproduct of events the system already processes.

## Cost Assessment

This should be cheap if implemented as above.

Expected incremental cost:

- one small string in low-volume workspace status events
- one small SQLite row update in WorkspaceDO per throttled meaningful activity change
- no LLM calls
- no transcript scans
- no additional OrgDO thread reads

The expensive version would be broadcasting text deltas every token, scanning persisted messages on hover, or using route revalidation to refresh the subheader. Avoid those and this should be power efficient.

## Suggested Tests

- WorkspaceDO stores `latest_activity_text` for running threads and includes it in the status snapshot.
- WorkspaceDO clears activity when the thread stops running.
- WorkspaceDO dedupes repeated activity payloads.
- ChatThreadDO publishes `"Thinking"` on reasoning start.
- ChatThreadDO publishes tool labels on tool start/end.
- ChatThreadDO throttles assistant text delta activity.
- `hydrateChatGroups` carries running activity from the WorkspaceDO snapshot into `ChatGroupThreadSummary`.
- Local optimistic status uses the user's just-sent message until server activity replaces it.
