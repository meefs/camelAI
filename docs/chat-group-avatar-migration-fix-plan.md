# Chat Group Avatar Access Backfill Plan

**Date:** 2026-06-20  
**Target branch:** `main`  
**Context:** Follow-up to PR #881 (`[codex] Add chat group avatars`)

## Objective

Simplify chat group avatar backfill so it works like the existing chat thread naming flow:

- no migration of all historical threads;
- no attempt to eagerly generate emojis for every chat group in a workspace;
- no sidebar-wide generation batch;
- no loader `waitUntil`;
- no separate backfill API route;
- no LLM work in `UserDO.migrate()`;
- when a user accesses a thread whose chat group still needs an emoji, `ChatThreadDO` generates and persists that group's emoji.

This means avatar backfill is lazy and per accessed thread. The first access to an old thread may show a pending avatar briefly, then `ChatThreadDO` broadcasts the final generated/fallback avatar through the existing chat event/local patch path.

## Non-Goals

- Do not scan or migrate all historical threads.
- Do not enqueue workspace-wide or user-wide avatar jobs.
- Do not generate emojis for closed/old groups until one of their threads is accessed.
- Do not make the sidebar list loader responsible for generation.

## Current Problems

The current route-loader backfill path is the wrong place for this:

- it tries to infer migration work from the sidebar list;
- it only claims a small visible batch;
- it can show unclaimed migrated groups as final `💬` fallback;
- background generation failure is hard to observe;
- staging has already produced generic `fallback` rows that need a repair attempt.

There is also a real generation bug:

- `CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS = 8` can truncate verbose model output before the emoji appears;
- `sanitizeGeneratedChatGroupEmoji(...)` rejects common one-emoji outputs such as `Use 🌊`, `Emoji: 🧠`, or JSON-ish wrappers.

## Product Semantics

- Backfill runs when accessing a thread, not when merely listing sidebar groups.
- If the accessed thread's group has `avatar_content_source = "default"`, it is eligible.
- Generic failed-rollout fallback rows are also eligible once: `fallback` + `💬` + no post-fix final attempt marker.
- User-set avatars and already-generated avatars are terminal and must never be overwritten.
- Final fallback should mean the generation attempt actually ran and produced no usable single emoji or threw.
- Missing AI binding should log and leave the group retryable; it should not permanently write fallback.

## Proposed Flow

### 1. Add a ChatThreadDO access-time avatar check

In `workers/main/src/chat-thread-do.ts`, add a method near `generateThreadTitleFromMessage(...)`:

```ts
private async maybeGenerateChatGroupAvatarForAccessedThread(threadId: string): Promise<void>
```

Call it from `onConnect(...)` after `captureChatContextFromRequest(...)` and after the initial live state has been sent to the connecting browser.

Recommended call placement:

```ts
this.captureChatContextFromRequest(url, ctx.request, connection);
// existing state sync/sendLiveOverlay...
await this.maybeGenerateChatGroupAvatarForAccessedThread(this.chatContext.threadId);
```

The method should:

- require `chatContext.orgId`, `workspaceId`, `threadId`, and `userId`;
- get the current `UserDO` stub;
- claim emoji generation work for the thread's chat group;
- broadcast a `chat_group_avatar_updated` event with the pending avatar;
- run emoji generation;
- persist generated/fallback avatar;
- broadcast the final avatar.

Do not add sidebar loader `waitUntil` or a route-level background task. If the method is called during `onConnect`, it can be awaited as part of the ChatThreadDO access flow. If this proves too slow for connection setup, call it after initial state is sent, but keep the operation owned by `ChatThreadDO`, not the sidebar loader.

### 2. Reuse the existing title-flow avatar generation shape

The implementation should look like the current title-flow block:

```ts
const claim = await userStub.claimChatGroupEmojiGenerationForThread(threadId);
if (!claim) return;

this.broadcastChat({
  type: "chat_group_avatar_updated",
  threadId,
  groupId: claim.id,
  avatar: { ...claim.avatar, status: "pending" },
});

const generatedEmoji = await generateChatGroupEmojiWithOpenAI(...);
const avatar = generatedEmoji
  ? await userStub.setGeneratedChatGroupEmoji(claim.id, generatedEmoji)
  : await userStub.setChatGroupAvatarFallback(claim.id);

if (avatar) {
  this.broadcastChat({
    type: "chat_group_avatar_updated",
    threadId,
    groupId: claim.id,
    avatar,
  });
}
```

Refactor the duplicated body into a private helper if useful:

```ts
private async generateClaimedChatGroupAvatar(
  threadId: string,
  claim: { id: string; name: string; avatar: ChatGroupAvatar },
): Promise<void>
```

Then both:

- `generateThreadTitleFromMessage(...)`, after the group title is generated; and
- `maybeGenerateChatGroupAvatarForAccessedThread(...)`, when an old thread is opened

use the same helper.

### 3. Update UserDO claim semantics for accessed threads

In `workers/main/src/identity/user-do.ts`, extend `claimChatGroupEmojiGenerationForThread(...)`.

It should claim the group for a thread when:

- the group exists;
- the group has a non-empty, non-placeholder name;
- the avatar is still `default`; or
- the avatar is a suspect failed-rollout fallback:
  - `avatar_content_source = "fallback"`;
  - `avatar_content = DEFAULT_CHAT_GROUP_EMOJI`;
  - no post-fix final attempt marker exists.

Keep the existing protections:

- do not claim `user` avatars;
- do not claim already `generated` avatars;
- do not claim placeholder titles such as `New Chat`.

For the title-flow-created groups, keep the current single-thread guard if that is still needed for title naming semantics. For access-time backfill, the group may contain multiple threads; generation should be based on the group name and should not require exactly one member. If the existing `claimChatGroupEmojiGenerationForThread(...)` cannot safely support both, split it:

```ts
claimChatGroupEmojiGenerationForThreadTitleFlow(threadId)
claimChatGroupEmojiBackfillForAccessedThread(threadId)
```

Prefer one method only if its rules stay clear.

### 4. Persist final fallback as a real post-fix attempt

`setGeneratedChatGroupEmoji(...)` and `setChatGroupAvatarFallback(...)` should allow writes for:

- `avatar_content_source = "default"`;
- suspect/claimed generic fallback rows from the broken rollout.

They must not write over:

- `avatar_content_source = "user"`;
- `avatar_content_source = "generated"`.

When writing final fallback after a post-fix failed attempt, persist a non-null `avatar_emoji_last_attempt_at` or another existing-marker equivalent. This prevents generic fallback rows from being retried on every thread access.

### 5. Remove or disable sidebar-list generation

Update `src/lib/chat-groups.server.ts` so `listGroupsForWorkspace(...)` and `getGroupForWorkspace(...)` no longer schedule emoji generation.

Options:

- remove `maybeBackfillChatGroupEmojis(...)`; or
- reduce it to a pure status helper if needed.

The sidebar list may still render `fallback` for old untouched groups until the user opens a thread in that group. That is the intended tradeoff of the simplified access-driven flow.

### 6. Fix generation robustness

Update `src/lib/chat-group-avatar-generation.server.ts`.

Increase token budget:

```ts
const CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS = 24; // or 32
```

Make sanitization tolerant:

- accept `🌊`;
- accept `"🧠"`;
- accept `` `🚀` ``;
- accept `Use 🌊`;
- accept `Emoji: 🧠`;
- accept `{ "emoji": "🛠️" }`;
- reject no emoji;
- reject multiple emoji.

Implementation shape:

1. Trim and strip obvious wrappers.
2. If the cleaned value is exactly one emoji, return it.
3. Otherwise use `emoji-regex` to collect emoji matches.
4. If there is exactly one match and it passes `isEmoji(...)`, return it.
5. Otherwise return `null`.

Add structured diagnostics for failures:

- `ai_error`;
- `empty_output`;
- `no_emoji`;
- `multiple_emoji`;
- `write_skipped`.

Do not log raw model output or group names.

## Files To Change

- `workers/main/src/chat-thread-do.ts`
  - add access-time avatar generation from `onConnect`;
  - share helper with the title-flow avatar generation block;
  - broadcast pending and final `chat_group_avatar_updated` events.
- `workers/main/src/identity/user-do.ts`
  - extend or split thread-based claim method;
  - support one repair attempt for generic failed-rollout fallback rows;
  - prevent overwrites of user/generated avatars;
  - mark final fallback attempts durably.
- `src/lib/chat-groups.server.ts`
  - remove sidebar-list `waitUntil`/AI generation.
- `src/lib/chat-group-avatar-generation.server.ts`
  - larger token budget;
  - tolerant one-emoji sanitizer;
  - optional parse reason helper.
- `src/hooks/use-chat-groups.tsx`
  - keep existing `camelai:chat-group-avatar` local patch handling;
  - no new sidebar backfill fetcher is needed.

## Tests

### Worker: UserDO

File: `workers/main/tests/user-do-chat-groups.test.ts`

- Access-time claim returns a default-source group for a thread with a real name.
- Access-time claim returns a suspect fallback group once.
- Access-time claim allows multi-thread groups if the group name is usable.
- Placeholder names are skipped.
- User/generated avatars are skipped.
- Final fallback gets a durable marker and does not loop on repeated access.
- Suspect fallback can be upgraded to generated.

### Worker: ChatThreadDO

File: `workers/main/tests/chat-thread-title-generation.test.ts` or a new focused test.

- `onConnect` or the new private method claims an eligible accessed thread group.
- It broadcasts pending first.
- It persists and broadcasts generated on success.
- It persists and broadcasts fallback after generation failure.
- Missing AI logs/skips without writing fallback.
- It does not run when no user/org/workspace context exists.
- Existing title-generation tests still pass and use the shared helper.

### Generation

File: `tests/chat-group-avatar-generation.test.ts`

- Accept exact emoji, quoted emoji, markdown-wrapped emoji, prose with one emoji, and JSON-ish one-emoji output.
- Reject empty output, plain text, and multiple emoji.
- Verify the AI call uses the larger max token budget.

### UI/provider

File: `tests/chat-groups-ui.test.tsx`

- Existing `chat_group_avatar_updated` local patch tests cover pending and final avatar updates.
- Add coverage if needed that an accessed thread's avatar update changes the sidebar group avatar without requiring a full page reload.

## Verification Commands

```bash
bun run test:run tests/chat-group-avatar-generation.test.ts tests/chat-groups-ui.test.tsx
bun run test:workers -- workers/main/tests/user-do-chat-groups.test.ts workers/main/tests/chat-thread-title-generation.test.ts
bun run typecheck
```

Run broader suites if shared ChatThreadDO behavior changes:

```bash
bun run test:workers
```

## Done Criteria

- Opening/accessing a thread whose group needs an emoji triggers ChatThreadDO avatar generation.
- No sidebar-list emoji generation or backfill API route is added.
- Pending and final avatar updates flow through existing chat event/local patch handling.
- Generic fallback rows from the broken rollout get one repair attempt when their thread is accessed.
- User and generated avatars are never overwritten.
- Emoji generation no longer fails just because the model returned one emoji with surrounding text.
