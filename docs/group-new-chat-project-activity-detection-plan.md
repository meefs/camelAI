# Active Chat Group New-Chat: Project Activity Detection Plan

**Date:** 2026-07-15
**Status:** Ready for implementation
**Surface:** `/chat?group=<group-id>` — the new-chat screen for an active chat group

This plan amends the mention-only project sourcing in
[`docs/group-new-chat-screen-plan.md`](./group-new-chat-screen-plan.md); the shipped
group-new-chat interaction and payload remain the baseline.

## Objective

Populate **Recently used in this group** with a project when any eligible sibling chat:

1. references the project through an explicit user `@project` mention (existing behavior),
2. successfully calls `create_project` for the project, or
3. successfully calls `deploy_project` for the project.

The motivating case is a user asking the agent to build an app from scratch. The agent creates and deploys the project, but the user never knows the eventual project name and therefore never types an `@project` mention. Starting another chat in the same group should still offer that project as reusable context.

This is a detection/data-flow change only. Keep the existing recent-project pill, hover card, click-to-insert behavior, composer behavior, and `GroupNewChatRecentItems` client payload unchanged.

## Current behavior and root cause

The group welcome route already does a bounded, deferred scan:

- [`src/routes/_app.chat._index.tsx`](../src/routes/_app.chat._index.tsx) selects at most eight completed open sibling threads and calls `chatDO.getPiCoreMessages()` for each.
- [`src/lib/group-new-chat-recent-items.ts`](../src/lib/group-new-chat-recent-items.ts) inspects only non-meta user messages.
- It recognizes stable mention annotation ids first, then falls back to parsing visible `@slug` text.
- The resulting project ids flow through `GroupNewChatRecentItems.recentlyUsed.projectIds` to [`src/components/welcome-screen/recently-used-in-group.tsx`](../src/components/welcome-screen/recently-used-in-group.tsx).

That extractor intentionally ignores assistant messages and tool work. A project created entirely by the agent has no user-authored mention to find.

Reading assistant prose is not a reliable fix. In particular, `deploy_project` normally runs inside `js_exec`: the durable Pi transcript sees a top-level `js_exec` call containing arbitrary JavaScript, not a structured nested `deploy_project` event. Parsing that source would confuse attempted and successful deploys, miss dynamic values, and couple product behavior to model-generated code formatting.

## Architecture decision

Record a compact, structured project-activity rollup on the owning `ChatThreadDO` when project lifecycle tools finish successfully. Merge that rollup with the existing mention scan when the active-group new-chat page loads.

```text
User @project mention ───────────────► persisted pi_core user message ──────┐
                                                                           │
create_project / deploy_project                                            │
  top-level or inside js_exec                                              │
            │                                                              │
            ▼                                                              │
CodeModeToolsBinding.callTool                                              │
            │ successful qualifying result                                │
            ▼                                                              │
ChatThreadDO bounded project-activity KV rollup ───────────────────────────┤
                                                                           ▼
group new-chat deferred scan ─► merge by stable project id ─► existing pills
```

Why this shape:

- `CodeModeToolsBinding.callTool()` is the common execution boundary for top-level passthrough tools and tools invoked from `js_exec`; one recorder covers both paths.
- `env.PROJECTS.create()` delegates to the same raw `create_project` tool, so it does not need a second integration path.
- `Agent`/`Explore` children receive tool definitions built from the same chat context, so lifecycle work delegated by the parent agent retains the owning `threadId` and reaches the same recorder.
- The recorder sees the real tool result, so a `{ success: false }` deploy is not treated as a deployment.
- The stored key is the stable workspace project id, so project display-name changes do not break the association.
- Thread-local storage moves naturally with a thread when the user moves that thread between chat groups.
- The existing recent-items scan already fans out to the selected thread DOs, so the activity can be returned with the transcript without introducing a new global index or client request.

Do **not** infer project use from assistant text, tool-result text, app URLs, preview state, project `updatedAt`, or regexes over `js_exec` source.

## 1. Shared activity contract

Add a small shared leaf type, for example [`src/lib/thread-project-activity.ts`](../src/lib/thread-project-activity.ts):

```ts
export type ThreadProjectActivityType = "created" | "deployed";

export interface ThreadProjectActivity {
  projectId: string;
  activityType: ThreadProjectActivityType;
  lastUsedAt: number;
}
```

Contract rules:

- Store project ids, never project names, as identity.
- One rollup entry per project per thread is sufficient. A later event replaces the prior `activityType` and `lastUsedAt` for that project.
- `lastUsedAt` is the time the successful project operation completed, not the parent user-message timestamp.
- The activity type is diagnostic/ordering metadata. The current UI continues to receive only project ids.
- Treat this module as a data-contract leaf; it must not import React, route code, DO classes, or tool implementations.

## 2. Bounded `ChatThreadDO` storage

Create a focused collaborator such as [`workers/main/src/chat-thread/project-activity.ts`](../workers/main/src/chat-thread/project-activity.ts), following the existing collaborator pattern used by `chat-thread/code-mode-artifacts.ts` and `chat-thread/metadata.ts`.

Use synchronous Durable Object KV, not a module-level cache and not legacy async storage:

```text
key: threadProjectActivity:v1
value: ThreadProjectActivity[]
```

Lock these storage semantics:

- Normalize every read; ignore malformed rows rather than returning them.
- Trim and require a non-empty `projectId`.
- Accept only `created` and `deployed` activity types.
- Require a finite positive timestamp.
- Upsert by `projectId`, sort newest-first, and cap the stored rollup at **32 projects per thread**.
- Return a fresh normalized array from the read method.
- No schema migration is needed; absent KV means no recorded activity.

Expose thin methods on [`workers/main/src/chat-thread-do.ts`](../workers/main/src/chat-thread-do.ts):

```ts
recordProjectActivity(input: {
  projectId: string;
  activityType: ThreadProjectActivityType;
}): Promise<void>;

listProjectActivity(): Promise<ThreadProjectActivity[]>;
```

`ChatThreadDO` should assign `lastUsedAt = Date.now()` itself. Callers supply identity and event type, not arbitrary timestamps.

## 3. Record successful project lifecycle operations

Extend [`workers/main/src/code-mode-tools.ts`](../workers/main/src/code-mode-tools.ts) at the shared `callToolWithArtifactCapture()` post-execution seam. A helper such as `recordProjectActivityBestEffort(name, args, result)` should run after the underlying tool returns and alongside the existing artifact bookkeeping.

### Classification

Record only these cases:

| Tool | Success rule | Project-name source | Activity type |
| --- | --- | --- | --- |
| `create_project` | The tool returned normally | returned `name`, falling back to `args.name` | `created` |
| `deploy_project` | Returned object has `success === true` | returned `project`, falling back to `args.project` | `deployed` |

All other tools are ignored for this feature, including project reads/writes, `build_project`, `set_preview`, `list_projects`, `rollback_deploy`, and `delete_project`.

Important details:

- Check for `ctx.props.threadId` first. Automation/non-chat tool bindings have no owning chat and must no-op.
- Resolve the returned project name through `WorkspaceFilesystemDO.getProjectByName()` and send the resolved stable `project.id` to the thread DO. Do not copy the project-name normalization logic into the recorder.
- Treat a missing project after a nominally successful result as a recorder failure: emit the diagnostic described below and leave the original tool result untouched.
- `deploy_project` reports build/deploy failures as completed tool results with `{ success: false, ... }`; those must not record `deployed` activity.
- A thrown `create_project` does not record activity. The recorder runs only after a successful tool return.
- Do not require `parentToolUseId`. Top-level `create_project` has thread scope but no `js_exec` parent id.
- Await the small bookkeeping call before returning the tool result so a user who immediately opens a group new-chat page does not race the record. Swallow/log recorder failures so bookkeeping can never convert successful project work into a failed agent tool.
- Record a structured error through the existing observability helper (plus the local error log if useful) with component/operation, workspace id, thread id, tool name, and error metadata. Never log JavaScript source, tool arguments, tool results, chat content, or credentials.

This seam is what makes the solution work for both forms without source parsing:

```text
Pi top-level create_project ────────┐
env.PROJECTS.create() ──────────────├─► CodeModeToolsBinding.callTool() ─► recorder
js_exec tools.deploy_project() ──────┤
delegated Agent lifecycle call ──────┘
```

## 4. Return transcript and activity in one thread read

The group loader currently performs one `getPiCoreMessages()` RPC for each of at most eight sibling thread DOs. Do not double that fan-out with a second app-side RPC per thread.

Add one combined `ChatThreadDO` read method (for example `getGroupNewChatRecentSource(threadId)`) that returns:

```ts
{
  messages: AgentEvalParsedMessage[];
  projectActivity: ThreadProjectActivity[];
}
```

Implementation requirements:

- Reuse `getPiCoreParsedMessages(threadId)` for the message half; do not create another Pi message parser.
- Read the bounded activity rollup from the new collaborator.
- This is a read-only snapshot; it must not mutate or backfill storage.
- Add a typed server wrapper in [`src/lib/chat-do.server.ts`](../src/lib/chat-do.server.ts), mirroring `getPiCoreMessages()` binding validation and empty-array normalization.

Then update `loadGroupNewChatRecentItems()` in [`src/routes/_app.chat._index.tsx`](../src/routes/_app.chat._index.tsx):

- Request the combined source for each existing candidate thread.
- Pass both `messages` and `projectActivity` to the pure extractor.
- Preserve per-thread isolation: if one DO read fails, log it and substitute `{ messages: [], projectActivity: [] }` for only that thread.
- Keep the whole recent-items promise deferred. Project activity must not delay the group header, composer, or transcript-card metadata.
- Rename the current `Failed to scan group thread mentions` diagnostic to describe the broader recent-items source.

No new HTTP endpoint, loader payload field, or browser fetch is needed.

## 5. Merge project activity with mention evidence

Extend `GroupRecentItemsThread` in [`src/lib/group-new-chat-recent-items.ts`](../src/lib/group-new-chat-recent-items.ts) with an optional/default-empty activity array:

```ts
projectActivity?: ThreadProjectActivity[];
```

Keep these invariants:

- User-authored mention detection remains exactly as today: exclude meta/compact-summary messages, prefer stable annotation ids, and fall back to `parseMentions()` for unannotated current slugs.
- Attachments continue to come only from user upload references. Project activity must not affect attachment extraction.
- Activity is accepted only when `projectId` exists in the current `MentionableProject[]` supplied by the route. Deleted projects, stale ids, and clones excluded from mentionability silently disappear.
- De-duplicate a project mentioned and created/deployed in the same or different sibling chats into one pill.

### Ordering

Replace the project ids' first-hit-only accumulator with a small recency accumulator:

```ts
Map<projectId, { lastUsedAt: number; firstSeenOrder: number }>
```

- A user mention contributes the user message's `created_at`.
- A recorded create/deploy contributes `lastUsedAt`.
- Keep the maximum valid timestamp for each project.
- Emit project ids newest-first.
- Use `firstSeenOrder` as the deterministic tie-breaker so equal timestamps do not cause render-order churn.

Connections can keep their existing behavior. This change is specifically about project evidence; do not invent connection activity tracking here.

The public result remains:

```ts
{
  recentlyUsed: {
    projectIds: string[];
    connectionIds: string[];
  };
  attachmentCards: GroupNewChatAttachmentCard[];
}
```

Because [`src/components/welcome-screen/recently-used-in-group.tsx`](../src/components/welcome-screen/recently-used-in-group.tsx) already resolves ids against the live project list and filters projects already present in the composer, no component change should be necessary.

## 6. Rollout and historical threads

This plan intentionally does not fabricate a historical nested-tool index.

- Threads created before this change have no activity KV entry, so they continue to use the existing user-mention evidence.
- New successful `create_project` and `deploy_project` operations begin populating the rollup as soon as the worker ships.
- Do not regex old `js_exec` source as a fallback. Historical code can use variables, aliases, loops, conditionals, bracket access, or caught failures; the transcript does not retain an authoritative structured record of each nested sub-call and outcome.
- Do not infer deploy ownership from the current app record. App records retain `project_id` but not the originating thread id, and later deploys can overwrite app metadata.

If retroactive nested-tool recovery becomes a separate product requirement, first add an authoritative per-sub-call audit source and then backfill from that source. It should not be approximated inside this UI feature.

## 7. File-by-file implementation map

| File | Change |
| --- | --- |
| `src/lib/thread-project-activity.ts` (new) | Shared serializable activity type. |
| `workers/main/src/chat-thread/project-activity.ts` (new) | Normalize, upsert, sort, cap, and read the per-thread KV rollup. |
| `workers/main/src/chat-thread-do.ts` | Construct the collaborator; expose record/list methods and the combined group-recent read RPC. |
| `workers/main/src/code-mode-tools.ts` | Classify successful `create_project` / `deploy_project` results, resolve stable ids, and record best-effort activity at the common tool boundary. |
| `src/lib/chat-do.server.ts` | Add the typed combined-source RPC wrapper. |
| `src/routes/_app.chat._index.tsx` | Use the combined thread source in the existing deferred, bounded loader scan. |
| `src/lib/group-new-chat-recent-items.ts` | Merge recorded project activity with existing user-mention evidence and order project ids by latest evidence. |
| `tests/group-new-chat-recent-items.test.ts` | Pure merge, filtering, de-dupe, and ordering coverage. |
| `workers/main/tests/chat-thread-project-activity.test.ts` (new) | Bounded DO collaborator/RPC persistence coverage. |
| `workers/main/tests/chat-thread-pi-turn.test.ts` | Focused `CodeModeToolsBinding` recording and failure-isolation cases, following its existing fake-binding patterns. |

Avoid changes to `src/types.ts`, `GroupNewChatRecentItems`, `GroupNewChatPayload`, and the welcome-screen components unless type inference exposes an unavoidable compile-only adjustment.

## 8. Tests

### Pure recent-items extraction

Add cases proving:

1. A project with no user mention appears from `activityType: "created"`.
2. A project with no user mention appears from `activityType: "deployed"`.
3. A mention plus create/deploy activity for the same id produces one project id.
4. The latest evidence timestamp determines project ordering, regardless of whether that evidence came from a mention or an activity record.
5. Equal timestamps retain deterministic first-seen order.
6. An activity id absent from the current mentionable-project list is ignored.
7. Existing connection mention and attachment extraction assertions remain unchanged.

### Thread activity storage

Add worker tests proving:

1. Record then read returns a normalized activity row.
2. A second event for the same project updates rather than duplicates it.
3. Rows are newest-first and capped at 32.
4. Malformed stored values are ignored safely.
5. The combined read RPC returns both parsed Pi messages and activity.

### Tool execution seam

Using the existing `Object.create(CodeModeToolsBinding.prototype)` fake pattern, prove:

1. Successful top-level `create_project` resolves the project and calls `recordProjectActivity({ projectId, activityType: "created" })` even without `parentToolUseId`.
2. Successful `deploy_project` records `deployed`.
3. `{ success: false }` deploy results do not record.
4. An unrelated project tool does not record.
5. A binding without `threadId` does not record.
6. A failed activity RPC is reported but the successful original tool result is still returned.

No new visual test is required because the browser still receives the same `recentlyUsed.projectIds` shape. Keep the existing `RecentlyUsedInGroup` component test in the focused regression run.

Suggested commands:

```bash
bun run test:run -- tests/group-new-chat-recent-items.test.ts tests/recently-used-in-group.test.tsx
bun run test:workers -- chat-thread-project-activity chat-thread-pi-turn
bun run typecheck
bun run lint
```

## 9. Acceptance criteria

- A user asks the agent to create an app without naming or mentioning a project; after a successful `create_project`, a new chat in the same active group offers that project under **Recently used in this group**.
- A sibling chat successfully deploys an existing mentionable project without a user `@project`; the group new-chat page offers that project.
- The same behavior works whether the lifecycle tool was top-level or invoked from `js_exec`.
- A failed build/deploy does not create `deployed` activity.
- Explicit user project mentions continue to work.
- A project found through both sources appears once, ordered by its newest evidence.
- Deleted projects, stale project ids, and non-mentionable clones do not render.
- Clicking the pill still inserts the existing `@project` chip; removing that mention makes the pill return.
- Failure to write or read activity does not block project work, the composer, group metadata, transcript cards, connections, or attachments.
- The scan remains capped to the existing eight eligible open sibling threads and remains deferred from initial interactive rendering.

## 10. Out of scope

- Tracking generic project reads, writes, builds, previews, notebook runs, dependency installs, commits, reverts, or rollbacks as recent-project evidence.
- A workspace-wide or org-wide recent-project index.
- Changing which group threads are candidates (open threads only, completed-assistant requirement, eight-thread cap).
- Making clones mentionable.
- Changing the standard non-group `/chat` welcome screen.
- Changing recent-project pill visuals, hover content, composer insertion, or draft behavior.
- Retrofactively guessing nested tool calls from historical `js_exec` source or assistant prose.
