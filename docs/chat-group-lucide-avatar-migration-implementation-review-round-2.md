# Legacy Chat-Group Lucide Avatar Migration: Implementation Review, Round 2

**Reviewed:** 2026-07-14

**Scope:** The implementation at `1f7dfe5ef`, with particular attention to the two changes made in response to the first review: restart-safe V11 classification in `workers/main/src/identity/user-do.ts` and the real V10/retry regression fixture in `workers/main/tests/user-do-chat-groups.test.ts`.

## Verdict

Approved. I found no remaining blocking or non-blocking correctness issues in the review-response diff.

The agent resolved both prior findings:

- A partially converted legacy avatar now remains queued across any number of V11 retries instead of becoming a permanent generic icon.
- The Worker test now exercises the relevant V10 table shape, repeated migration retries, and the final claim boundary.

The migration is ready for a manual smoke test against real legacy local data. A disposable worktree with two genuine generated emoji avatars has been prepared for that purpose, but the app has deliberately not been started there yet.

## Findings

None.

## Prior findings resolved

### P1: V11 row conversion is now restart-safe

`workers/main/src/identity/user-do.ts:659-687` now reads `avatar_icon_generation_state` with each row. When the stored content is already a valid Lucide name, the migration only canonicalizes `avatar_content`; it no longer resets the generation state or clears claim fields.

That distinction covers both cases which previously looked identical on a retry:

- A genuine V10 `messages-square` default receives the new column's `idle` default and remains an intentional default.
- A legacy emoji converted by an interrupted V11 attempt is already `messages-square` plus `queued`, and remains queued and claimable on every retry.

Preserving claim fields is also the correct behavior if an unusual interruption leaves a row in `generating`: the existing claim lease and fencing logic, rather than schema migration, remains responsible for recovery. Invalid legacy values are still reset to default provenance and queued from the group name. Placeholder titles still remain idle.

The queued-row observability count also includes already queued rows on a retry. This does not affect migration behavior, but keeps retry telemetry representative.

### P2: The regression fixture now models the real upgrade boundary

`workers/main/tests/user-do-chat-groups.test.ts:143-216` removes all three V11 generation columns before recording schema version 10 and invoking the migration. It verifies that:

- the V11 columns are genuinely absent before the first upgrade;
- a generated legacy emoji becomes `messages-square` with public status `pending`;
- an original valid default remains `default` rather than being queued;
- restoring only schema version 10 and rerunning V11 twice leaves both classifications unchanged; and
- the batch claimer returns only the migrated legacy row.

This test reproduces the interruption window from the first review and protects both idempotence and downstream claimability.

## Additional audit notes

- The fix is intentionally narrow: it changes only migration classification and its regression coverage. The coordinator, selector prompt, bounded batching, rename fencing, polling, and rendering paths reviewed in round 1 are unchanged.
- The migration still passes only the short chat-group name to the icon selector.
- Migration does not update group recency, rename groups, reorder them, or touch membership/transcript data.
- Existing user-selected emojis are intentionally treated as legacy content and regenerated from the group name, matching the approved plan.
- Existing valid Lucide icons retain their provenance. A user-selected `messages-square` remains a user icon, while a genuine default `messages-square` remains idle.
- Failed or unavailable AI generation retains the existing finite/retryable behavior; this patch does not introduce a loader dependency on successful inference.

## Verification performed

On the feature worktree:

- Focused Worker suite: 2 files, 29 tests passed.
- Focused source suite: 7 files, 120 tests passed.
- `bun run typecheck`: passed.
- `bun run lint`: passed with warnings denied.
- `bun run build`: passed, including the Pi Bedrock build check.
- `git diff --check`: passed.

The same typecheck, focused suites, lint, and production build also passed after merging the feature into the disposable legacy-data branch described below. The live semantic selector evaluator was not repeated because the response diff does not change the already evaluated selector.

## Prepared real-data migration smoke test

The old `illianaa/chat-autoscroll-plan` worktree is a good migration fixture because its ignored local Durable Object state predates V11. The feature was merged into that branch and pushed normally, without force:

- Worktree: `/Users/illiana/conductor/workspaces/chiridion-app/port-moresby`
- Branch: `illianaa/chat-autoscroll-plan`
- Prepared/pushed commit: `d9d6818ac`
- Remote branch: `origin/illianaa/chat-autoscroll-plan`

The local UserDO contains these two real legacy rows:

| Chat-group name | Stored avatar | Stored source |
| --- | --- | --- |
| Event Rsvp And Waitlist System | `📅` | `generated` |
| Link In Bio Page Creator | `📄` | `generated` |

The database still has the V10 shape: none of the three V11 generation columns exists. I did not start the dev server or invoke the UserDO after preparing the branch, so the first product load remains the actual migration test.

The ignored local state is not part of the Git push. Run the smoke test from this exact worktree; checking out the branch in a different directory will not have the legacy records.

### How to run it

From the `port-moresby` worktree, run:

```bash
bun run dev
```

Use the normal browser session/auth flow which originally created these groups. Do not use `bun run dev:local-auth`: that bypass logs in as `local-dev-user`, while the legacy groups belong to the existing UUID-backed local user.

On the first load of the chat groups, verify:

1. Both groups are still present with the same names, membership, and ordering.
2. Their stored emojis are replaced through the pending/default state and settle on generated Lucide icons based on the short names. The pending state may be too brief to see.
3. The two results are sensible and preferably distinct rather than both remaining `messages-square`.
4. Refreshing the page preserves the generated icons and does not regenerate or reorder the groups.
5. Existing chats inside the groups remain available.

Exact icon names are deliberately not asserted: this smoke test checks migration integrity and production selector integration, while the deterministic Worker tests cover state transitions and fencing.

### Backup and repeatability

Before merging or running anything, I archived the entire ignored local Wrangler state:

- Backup: `/Users/illiana/conductor/workspaces/chiridion-app/port-moresby/.context/chat-autoscroll-plan-pre-lucide-state-2026-07-14.tgz`
- SHA-256: `16bcbfa888b920a48e3d6e4a9824a7d9b5a7625f51c2bcfa5d842c85d197e03f`

V11 is a one-way migration. To repeat the first-run test, stop the dev server completely and restore the backup from the `port-moresby` worktree:

```bash
mv .wrangler/state ".wrangler/state-after-avatar-smoke-$(date +%Y%m%d-%H%M%S)"
tar -xzf .context/chat-autoscroll-plan-pre-lucide-state-2026-07-14.tgz -C .
```

Moving rather than deleting the post-test state preserves it for comparison. Do not restore while a dev process has the SQLite files open.

## Recommendation

Run the prepared manual smoke once. If both groups survive and settle on sensible persistent Lucide icons, this implementation is ready to merge from a migration-correctness perspective.
