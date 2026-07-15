# Graceful Migration of Legacy Chat-Group Avatars

**Date:** 2026-07-14

**Status:** Proposed implementation architecture; ready for product review

**Scope:** Existing per-user `chat_groups` rows whose stored avatar content is an emoji or another value that is not a renderable Lucide icon

**Supersedes for this task:** The emoji-era access-backfill design in `docs/chat-group-avatar-migration-fix-plan.md`. Do not add this working plan to `docs/README.md`.

## Objective

Replace every legacy emoji chat-group avatar with a relevant, verified Lucide icon chosen from the chat-group name. This includes both formerly generated emojis and user-selected emojis; preserving the old emoji choice is explicitly not required.

The migration should feel like the icon was always there:

- already-valid Lucide avatars remain unchanged;
- legacy rows briefly render the existing pending skeleton, not a permanent generic bubble;
- icon generation happens in the background and never blocks the app loader;
- the existing title-only production selector chooses the replacement;
- a user icon edit or name change made during migration wins safely;
- inactive groups are migrated without requiring the user to open every thread;
- a crash cannot permanently strand a row or let stale work overwrite newer work;
- group recency and ordering do not change.

## Current failure

`UserDO.toChatGroup(...)` converts an unrecognized stored value to `messages-square` at read time while preserving `avatar_content_source` as `generated` or `user`. `claimChatGroupAvatarGenerationForThread(...)` then rejects those terminal sources. As a result, every legacy generated or user emoji appears as the same generic icon and can never enter generation again.

Changing only the read-time status check is not sufficient. It would introduce duplicate calls and races, migrate only groups whose threads are opened, and still have no durable distinction between queued, running, failed, and completed migration work.

## Decision

Use a lazy, durable migration owned by each user's `UserDO` and triggered when that user's workspace groups are loaded.

```text
first UserDO access after deploy
        |
        v
schema V11 classifies stored avatar content
        |
        +-- valid Lucide ----------------------> preserve exactly
        |
        +-- invalid + usable group name ------> source=default, state=queued
        |                                           |
        |                                           v
        |                                  sidebar renders pending
        |                                           |
        |                                           v
        |                               bounded background batch claims row
        |                                           |
        |                                           v
        |                         existing title-only Lucide selector runs
        |                                           |
        |                            +--------------+--------------+
        |                            |                             |
        |                            v                             v
        |                       generated                       failed
        |                    verified Lucide                generic fallback
        |
        +-- invalid + placeholder name ---------> source=default, state=idle
                                                    (normal title/rename flow
                                                     queues it once named)
```

This avoids a global user enumeration job, a permanent admin migration endpoint, AI calls during schema initialization, and a second icon-selection implementation. Because users and groups are currently limited, migration on next workspace access provides sufficient coverage with much less operational machinery. Production observability will show if an explicit admin sweep is ever needed.

## 1. Add generation state without overloading provenance

Keep `avatar_content_source` as provenance only:

- `default` — no final choice exists;
- `generated` — the selector produced the stored Lucide icon;
- `user` — the user explicitly selected the stored Lucide icon.

Add the following columns in UserDO schema V11:

```sql
avatar_icon_generation_state TEXT NOT NULL DEFAULT 'idle'
avatar_icon_generation_claim_id TEXT
avatar_icon_generation_claimed_at INTEGER
```

Use four internal state values:

| State | Meaning | Public avatar status |
| --- | --- | --- |
| `idle` | No migration work is queued or a final icon exists | Derived from source |
| `queued` | A named legacy row needs selection | `pending` |
| `generating` | A worker owns a leased claim | `pending` |
| `failed` | This migration version made a real attempt but produced no final icon | `default` |

Do not encode these states in `avatar_content_source`. The current bug is partly a consequence of asking one field to describe both provenance and work eligibility.

Retain `avatar_emoji_last_attempt_at` for schema compatibility, but stop using it for new icon-generation decisions. Do not rebuild the table merely to rename or remove the legacy column.

No index is necessary initially: each database belongs to one user and the row counts are small. Add one only if measured query cost warrants it.

## 2. UserDO schema V11 data migration

`UserDO.migrate()` must remain local and synchronous. It may inspect and rewrite rows, but it must not invoke Workers AI or another Durable Object.

After adding the columns, iterate existing `chat_groups` rows and classify the raw stored `avatar_content` with `normalizeChatGroupIconName(...)`. Keep the normalized return value so lightly malformed but resolvable values can be canonicalized without invoking AI.

For a valid installed Lucide name:

- preserve an already-canonical `avatar_content` exactly; if normalization only changes casing/separators, store the returned canonical name;
- preserve `avatar_content_source`;
- leave generation state `idle`;
- do not regenerate it, including a valid user-selected `messages-square`.

For an emoji or any other invalid value:

- set `avatar_content = DEFAULT_CHAT_GROUP_ICON`;
- set `avatar_content_source = 'default'`, even when the old source was `user` or `generated`;
- clear claim id/time;
- set state to `queued` when the persisted group name is non-empty and not a placeholder;
- otherwise set state to `idle` so the normal title or rename path can queue it once it has a usable name.

Never update `chat_groups.updated_at` in this migration or in icon completion. That timestamp controls sidebar recency; decoration must not reorder work.

Bump `CURRENT_SCHEMA_VERSION` from 10 to 11 and update the schema-version assertion.

## 3. Use atomic, fenced claims

Both normal first-title generation and migration batches must use the same internal claim protocol.

Recommended internal claim shape:

```ts
interface ChatGroupIconGenerationClaim {
  id: string;
  name: string;
  avatar: ChatGroupAvatar;
  claimId: string;
  claimedAt: number;
  trigger: "first_title" | "legacy_migration";
}
```

Create a private UserDO helper that performs the eligibility check and state update in one synchronous transaction. A claim must:

1. verify that the source is still `default`;
2. verify that the group has a usable, non-placeholder name;
3. accept `idle` for the existing first-title flow;
4. accept `queued` for legacy migration;
5. accept `generating` only when its lease is stale;
6. generate a new `crypto.randomUUID()` claim id;
7. persist `generating`, the claim id, and `claimedAt` before returning the name.

Use a conservative stale-claim lease, initially two minutes. The measured p95 model duration is about 1.3 seconds, so two minutes is long enough to avoid duplicate work during a slow request while still recovering an isolate termination on a later load.

Every completion RPC must include the exact claim id. Its SQL update must require all of:

```text
id matches
source = default
state = generating
claim_id matches
```

The claim id is a fencing token. It prevents:

- two tabs from producing duplicate final writes;
- an attempt that outlived its lease from overwriting a newer attempt;
- a result generated for an old group name from winning after a rename;
- migration from overwriting an icon selected by the user while AI was running.

Do not rely on an in-memory flag or module-level cache. Durable state is the authority across isolates and restarts.

## 4. Make completion, failure, and edits explicit state transitions

### Successful generation

`setGeneratedChatGroupIcon(...)` should accept the claim id and verified icon. In one transaction:

- validate the icon again with `normalizeChatGroupIconName(...)`;
- conditionally write only when the claim predicate still matches;
- set source to `generated`;
- set state to `idle`;
- clear claim id/time;
- return the row's actual current avatar.

Returning the actual row preserves the existing race behavior: if the user's edit won, callers receive and broadcast the user avatar rather than the stale generated result.

### Completed attempt with no icon

Replace the old emoji-attempt semantics with a claim-aware failure method. When the matching claim is still current:

- set state to `failed`;
- keep source `default` and content `messages-square`;
- clear the claim id;
- retain the claim time if useful for diagnostics;
- return the actual current avatar.

`failed` is terminal for schema/migration version 11. The manual icon picker remains the escape hatch. If measured failures justify another automatic pass, a future schema version can deliberately requeue only `failed` rows; do not create an unbounded retry loop now.

If the AI binding is missing, do not claim work and leave the row queued. Log one structured warning. A configured deployment can then resume later without having consumed an attempt.

If a completion RPC itself fails ambiguously, leave the row `generating`. The lease handles recovery. The write may have succeeded even though the caller did not receive the response, so blindly marking it failed would be unsafe.

### Explicit user icon edit

When an avatar is included in `updateChatGroup(...)`:

- validate and store it as source `user`;
- set state to `idle`;
- clear claim id/time.

Any in-flight completion then fails its claim predicate and cannot overwrite the edit.

### Name-only edit

A name change without an icon must not accidentally turn `messages-square` into a permanent user selection.

When source is `default` and a usable name is saved:

- set the new name;
- set state to `queued`, including rows currently `idle`, `generating`, or `failed`;
- clear claim id/time so any old-name completion is fenced out.

When the new name is empty/placeholder, use `idle` instead of `queued`.

Do not regenerate an already-valid `generated` or `user` icon merely because its group is renamed. Those final icons remain stable unless the user picks another one.

## 5. Fix the rename client contract

The current dialog always submits an avatar, even when the user changed only the name. For a migrated pending row, that would submit the normalized default icon and persist it as a user choice.

Change the contract to:

```ts
type ChatGroupRenameInput = {
  name: string;
  avatar?: Avatar;
};
```

`RenameChatGroupDialog` should include `avatar` only when the selected icon actually differs from the normalized initial icon. The PATCH route already accepts name and avatar independently.

`saveChatGroupRename(...)` should dispatch `camelai:chat-group-avatar` only when `avatar` was present. A name-only save should revalidate without applying a local `status: "user"` avatar patch.

Required race test:

1. claim migration for name A;
2. rename to name B without selecting an icon;
3. complete the old claim and verify it is rejected;
4. claim again and verify the selector receives only name B.

## 6. Add a bounded background migration runner

Add a server-only coordinator, suggested location:

```text
src/lib/chat-group-avatar-migration.server.ts
```

It should use the same `generateChatGroupIconWithOpenAI(...)` production selector. Do not introduce a migration prompt, direct-title metadata search, emoji mapping, or manual icon catalog.

Add a UserDO method such as:

```ts
claimChatGroupAvatarMigrationBatch(
  orgId: string,
  workspaceId: string,
  limit: number,
): ChatGroupIconGenerationClaim[]
```

The batch claim should select only:

- `queued` rows in the requested org/workspace; and
- stale `generating` rows whose lease expired.

It must not claim ordinary `idle` rows; new groups remain owned by the existing first-title/access flow. Order migration candidates by `updated_at DESC, id ASC` so currently visible groups settle first without changing their stored recency.

Processing rules:

- claim and run at most three icons concurrently;
- use `Promise.allSettled` so one bad group does not abort the batch;
- after a batch settles, claim the next batch;
- cap one background drain at 30 groups (ten batches) so a request cannot create unbounded work;
- if more remain, the next app load continues from durable state;
- pass only `claim.name` to the selector;
- attach existing org/workspace/group metadata and strategy name to observability;
- never log group names, raw model output, prompts, or chat content.

Three concurrent calls are evidence-based: the migration experiment processed nine real local group names in 1.715 seconds with no errors or defaults. Ten sequential batches should stay comfortably bounded for the expected row counts while keeping per-user model concurrency small.

## 7. Trigger migration from normal workspace loading

In `listGroupsForWorkspace(...)`, schedule the bounded drain with Cloudflare `waitUntil(...)` after obtaining the authenticated user/org/workspace context. Catch and log the task at the boundary.

Do not await Workers AI before returning the loader data. The only synchronous additions to the loader path should be the existing UserDO activation/schema migration and small local SQL reads.

The V11 state conversion happens before `listChatGroups(...)` returns. Update `toChatGroup(...)` so `queued` and `generating` map to public `status: "pending"`. The existing `useChatGroups` behavior already:

- renders pending avatars as skeletons;
- revalidates every two seconds;
- stops after a final `generated`, `user`, or `default` status;
- bounds pending polling at twenty seconds.

This is the refresh channel for background migration. No new endpoint, websocket message, client fetcher, or migration screen is needed.

The existing accessed-thread flow remains useful: if a user opens a queued group before the workspace batch reaches it, `claimChatGroupAvatarGenerationForThread(...)` can win the same atomic claim and broadcast pending/final updates immediately. The batch then skips that claimed row.

## 8. Observability

Continue using the existing `chat_group_icon_generation` event and strategy identifier, adding a trigger/operation distinction for `legacy_migration` versus `first_title` where the current schema permits it.

Record only identifiers, counts, state, duration, model, and outcome. Useful migration outcomes are:

- `queued` count from V11;
- `claimed`;
- `metadata_match`;
- `ambiguous_fallback`;
- `unparseable_output`;
- `no_metadata_match`;
- `ai_error`;
- `write_error`;
- `claim_lost` (user edit, rename, or newer lease won);
- `failed`;
- `drain_partial` when the 30-group cap is reached with work remaining.

Do not treat `claim_lost` as an error; it is the expected race-safe outcome.

No permanent admin route is required. If production analytics show queued rows remaining after active users have returned, add a separate, reviewed one-off admin sweep rather than expanding this migration preemptively.

## Experiments performed

All temporary state-machine and concurrency scripts were removed after use. The live evaluator output is retained only in `.context/chat-group-icon-migration-live.json` and is gitignored.

### Production selector on the 87-title semantic corpus

A fresh run of the exact production selector produced:

| Metric | Result |
| --- | ---: |
| Cases | 87 |
| Non-default icons | 100% |
| Acceptable icons | 94.25% |
| Unparseable outputs | 0% |
| AI errors | 0% |
| Mean duration | 595 ms |
| p95 duration | 1,288 ms |

The five subjective misses still produced real, non-generic Lucide icons. They do not undermine the migration architecture, but they remain useful quality fixtures.

### Concurrency-three run on actual local group names

The selector processed all nine names in 1.715 seconds with zero errors and zero defaults:

| Group name | Selected icon |
| --- | --- |
| Sudoku Game With Timer Features | `clock` |
| Wedding Venue Quote Generator | `building` |
| Good Morning Chat | `coffee` |
| Food Chat Discussion | `utensils` |
| Hello Message | `hand` |
| Sun Icon Creation Request | `sun` |
| Restaurant Menu HTML File | `utensils` |
| Sweet Treat Chat Room | `ice-cream-cone` |

`Hello Message` existed under both local identities and consistently selected `hand`.

### State and fencing prototypes

An in-memory SQLite prototype verified:

- invalid generated, user, default, and unknown values are queued;
- already-valid generated/user Lucide rows are preserved;
- a fresh valid default row is not mistaken for legacy migration work;
- the conversion does not change `updated_at`;
- an immediate duplicate claim is rejected;
- a user icon edit wins over an in-flight completion;
- an explicit failure is terminal;
- an abandoned generating claim is reclaimable after its lease;
- a stale completion is rejected after a newer lease wins;
- a name-only rename invalidates the old claim;
- the replacement claim reads the new name.

## Tests the coding agent must add or update

### UserDO migration and state machine

In `workers/main/tests/user-do-chat-groups.test.ts`:

- schema version is 11;
- V10 generated emoji becomes default icon + queued;
- V10 user emoji becomes default icon + queued;
- legacy default/fallback emoji becomes queued;
- unknown content becomes queued;
- valid generated and user Lucide names are unchanged;
- a valid intentional `messages-square` is unchanged;
- placeholder/empty legacy names become default + idle;
- migration never changes `updated_at`;
- queued/generating expose public pending status;
- failed exposes public default status;
- migration batch claims only queued/stale rows in the requested workspace;
- claim batch ordering and size limits are deterministic;
- two claims cannot own the same row;
- an accessed thread can claim a queued migration row;
- completion requires the current claim id;
- stale completion after lease replacement is rejected;
- generated completion stores a verified Lucide name and clears claim state;
- failure settles the current claim without looping;
- user icon edit invalidates a claim and wins;
- name-only edit requeues and invalidates a claim;
- rename of a final generated/user icon does not regenerate it.

### Migration coordinator

Add a focused server test, suggested file:

```text
tests/chat-group-avatar-migration.test.ts
```

Cover:

- the runner calls the existing production selector with the group name only;
- no first message or thread content is supplied;
- at most three calls are active concurrently;
- it continues after one rejected item;
- it drains successive batches but stops at 30;
- success completes with the matching claim id;
- null/unparseable/AI failure settles through the failure path;
- ambiguous write errors are left for lease recovery;
- missing AI does not consume claims;
- logs/observability do not contain names or model output.

### Existing ChatThread flow

In `workers/main/tests/chat-thread-title-generation.test.ts`:

- update mocks for claim IDs/state;
- retain pending-before-final broadcast assertions;
- prove an accessed queued migration row uses the same claim protocol;
- prove a lost claim broadcasts/persists the actual current user avatar rather than stale output.

### Rename client and UI

In the existing rename/UI tests:

- a name-only save omits `avatar` from PATCH;
- a name-only save does not dispatch a local user-avatar patch;
- an actual icon change still sends the avatar and patches immediately;
- a persisted queued/generating avatar renders pending;
- existing pending polling revalidates and resolves to the generated icon;
- the twenty-second pending fallback remains bounded.

## Likely files to change

- `workers/main/src/identity/user-do.ts`
  - V11 columns and row classification;
  - internal state constants;
  - public status derivation;
  - atomic thread and batch claims;
  - claim-aware success/failure/edit transitions.
- `workers/main/tests/user-do-chat-groups.test.ts`
  - migration fixtures and state/race coverage.
- `src/lib/chat-group-avatar-migration.server.ts` (new)
  - bounded background drain using the production selector.
- `src/lib/chat-groups.server.ts`
  - `waitUntil` trigger from authenticated workspace loading.
- `workers/main/src/chat-thread/metadata.ts`
  - pass claim ids to success/failure and handle lost claims.
- `workers/main/tests/chat-thread-title-generation.test.ts`
  - update lifecycle mocks/assertions.
- `src/components/avatar/rename-chat-group-dialog.tsx`
  - optional avatar submission.
- `src/components/chat-tab-bar.tsx`
  - optional avatar type propagation.
- `src/lib/chat-group-rename.client.ts`
  - optional avatar payload and conditional local event.
- relevant rename/UI tests in `tests/`.

`src/hooks/use-chat-groups.tsx` should not need production behavior changes; its existing persisted-pending polling should be verified with tests first. Do not add migration code to the generated Lucide metadata or selector modules.

## Implementation sequence

1. Add V11 state columns, constants, classification, and migration tests.
2. Implement the shared atomic claim helper and claim-fenced completion/failure transitions.
3. Update the existing first-title/accessed-thread path to use claim IDs; get all old tests green before adding batch execution.
4. Fix name-only rename semantics and add the rename/claim race tests.
5. Add the server migration coordinator and batch-claim RPC.
6. Trigger the bounded drain from `listGroupsForWorkspace(...)` with `waitUntil`.
7. Verify the existing pending UI handles persisted queued/generating rows; change UI code only if a failing test proves a gap.
8. Run focused tests, typecheck, lint, build, and the live semantic evaluator.
9. Deploy, watch migration outcome counts, and inspect any `failed` cases before considering a retry version or admin sweep.

## Verification commands

```bash
bun run test:run -- tests/chat-group-avatar-generation.test.ts tests/chat-group-avatar-migration.test.ts tests/chat-groups-ui.test.tsx tests/avatar.test.ts
bun run test:workers -- workers/main/tests/user-do-chat-groups.test.ts workers/main/tests/chat-thread-title-generation.test.ts
bun run typecheck
bun run lint
bun run build
EVAL_OUTPUT=.context/chat-group-icon-migration-post-implementation.json bun run eval:chat-group-icons:live
git diff --check
```

Run the broader Worker suite if the shared claim protocol changes any ChatThreadDO surface beyond the focused tests:

```bash
bun run test:workers
```

## Done criteria

- Every invalid legacy avatar with a usable group name is queued once, with at most one valid claim owner at a time.
- Both old generated emojis and old user emojis are replaced based on the current group name.
- Existing valid Lucide icons are byte-for-byte preserved.
- Initial app/group loader responses are not delayed by Workers AI.
- Visible migrating groups show pending rather than a permanent generic icon.
- Background migration reaches inactive groups in bounded batches.
- Successful writes always store an installed, verified Lucide name.
- Duplicate, stale, renamed, and user-edited claims cannot overwrite newer state.
- Name-only rename does not persist `messages-square` as a user choice.
- Avatar work never changes group recency/order.
- Failures are finite, visible in observability, and manually recoverable.
- No migration-only diagnostic endpoint, manual synonym catalog, emoji mapping, or dead experiment code ships.
