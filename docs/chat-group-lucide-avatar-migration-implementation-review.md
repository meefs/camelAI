# Legacy Chat-Group Lucide Avatar Migration: Implementation Review

**Reviewed:** 2026-07-14

**Scope:** The uncommitted implementation diff on top of `45eedaf52`, reviewed against `docs/chat-group-lucide-avatar-migration-plan.md`

## Verdict

The implementation has the right production architecture, and the normal migration path works end to end. A disposable V10 fixture successfully moved from a stored emoji to `pending`, passed only the short group name through the existing selector, and completed with a verified generated Lucide icon.

There is one P1 restart-safety defect to fix before shipping. If V11 is interrupted after converting a row but before persisting schema version 11, the next migration attempt can turn that row into a permanent default icon. I found no other blocking correctness issue.

## Findings

### [P1] Make the V11 row conversion restart-safe

**Location:** `workers/main/src/identity/user-do.ts:668-679`

The valid-icon branch unconditionally sets `avatar_icon_generation_state = 'idle'`. That is correct for an original V10 row containing a valid Lucide icon, but it is not idempotent for a row already converted by a partially completed V11 migration:

1. The first attempt sees a legacy emoji and writes `messages-square`, source `default`, and state `queued`.
2. The Durable Object is interrupted before `schemaVersion` is advanced to 11.
3. The next activation runs V11 again. `messages-square` is now a valid Lucide name, so the valid-icon branch resets the row from `queued` to `idle`.
4. The background batch only claims `queued` or stale `generating` rows. The row now exposes public status `default`, polling stops, and an inactive group can remain on the generic chat bubble permanently.

I reproduced this in an isolated Worker fixture by running V11 once, restoring the schema version to 10 to model interruption before the version write, and rerunning it. The expected `pending` assertion failed because the actual status was `default`.

Make the conversion idempotent even if the migration is also wrapped in a synchronous transaction. In particular, a V11 retry must preserve evidence that a `messages-square`/`default` row was already queued, while a genuinely valid V10 default `messages-square` row must remain idle. If Cloudflare storage supports atomically committing the DDL, classification, and KV version bump together, use that as an additional safeguard; do not rely on transaction scope alone without a restart regression test.

Required regression coverage:

- simulate interruption after an invalid row has been converted but before version 11 is recorded;
- rerun the migration and verify the row remains `pending`/claimable;
- verify an original valid `messages-square` row still remains idle;
- run the migration a third time to establish idempotence.

### [P2] Commit a truly V10-shaped upgrade fixture

**Location:** `workers/main/tests/user-do-chat-groups.test.ts:32-107`

The current test named “classifies V10 avatar rows” creates its groups after the current V11 constructor has already added all three generation columns. It mutates avatar values, sets the version back to 10, and calls `migrate()`, so it tests classification but not the actual V10-to-V11 schema upgrade.

I ran a disposable fixture that removed all three V11 columns, inserted a generated emoji row, set schema version 10, and invoked the migration. It passed: the columns were recreated and the row became `messages-square`/`pending`. Please commit an equivalent fixture so the upgrade path remains protected after this review. It can live alongside the restart regression above.

## Behavior confirmed

- Generated and user-selected legacy emojis are reset to default provenance and queued from the current group name.
- Existing generated/user Lucide icons, including an intentional user `messages-square`, are preserved.
- Placeholder names remain idle; usable names become pending without changing `updated_at`.
- Batch work is scoped by org/workspace, ordered by recency, limited to three concurrent claims and thirty items per drain, and scheduled without awaiting AI in the loader.
- The coordinator gives the selector only `claim.name`; no first message or transcript content is added.
- Missing AI leaves rows queued, model failures settle finitely, and ambiguous completion writes are left for lease recovery.
- Claim IDs fence duplicate work, stale leases, old-name results, and user edits.
- Name-only rename requests omit the avatar, invalidate old claims, and do not persist the generic icon as a user selection.
- Existing pending rendering, polling, and bounded fallback behavior cover the migration without a new endpoint or client channel.

## Disposable legacy-row experiments

The review did not need any existing local legacy chat data and did not modify the user's real groups.

1. **Actual V10 table shape:** removed the V11 columns, stored a generated `🚀`, ran V11, and observed `messages-square` with status `pending` — passed.
2. **End-to-end migration:** started with that legacy row named “Deploy API to Staging”; the production selector received only the JSON-quoted short name and resolved the deterministic model response to `rocket`; the final row was `rocket` with status `generated` — passed.
3. **Restart safety:** reran V11 after conversion while the recorded version was still 10; the row changed from `pending` to `default` — failed as described in P1.

All temporary probe files were removed after execution.

## Verification performed

- Focused source suite: 7 files, 120 tests passed.
- Focused Worker suite: 2 files, 28 tests passed.
- Full Worker suite: 127 files and 1,468 tests passed; 16 files/22 tests skipped. Three unrelated deploy-action tests in `chat-thread-pi-turn.test.ts` failed because their Cloudflare script-details mock returned no version id in this local environment. The focused avatar/metadata suites remained green.
- `bun run typecheck`: passed.
- `bun run lint`: passed with warnings denied.
- `bun run build`: passed, including the Pi Bedrock build check.
- `git diff --check`: passed.

The live semantic evaluator was not repeated because this implementation reuses the already-evaluated selector unchanged. No production code was changed during this review; this Markdown file is the only retained review artifact.
