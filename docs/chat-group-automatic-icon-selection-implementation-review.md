# Automatic Chat-Group Icon Selection: Implementation Review

**Reviewed:** 2026-07-14

**Scope:** `origin/main...c42954cf7`, with extra attention to the implementation commit `e3cadb476..c42954cf7` and to the report that chats from an earlier local run appeared to disappear.

## Verdict

No blocking correctness findings. The implementation follows the proposed production shape and is ready to keep. In particular, it uses the short generated title as the model's only semantic input, makes one bounded model call, translates ordinary pictogram phrases through version-pinned Lucide metadata, and validates the selected canonical name before persistence.

The reported missing chats do not appear to be caused by this branch. The relevant rows are still present in the local Durable Object state, and the branch does not modify the code or configuration that deletes, lists, scopes, or stores chats.

## Findings and follow-ups

### 1. Non-blocking: treat the live evaluator's single-run threshold as noisy

The live evaluator exits unsuccessfully when one 87-case run falls below 90% acceptable icons. Two recent runs produced 89.7% and 93.1% acceptable icons respectively, while both produced 100% non-default icons. `temperature: 0` improves repeatability but does not make a hosted model fully deterministic.

This is not a production-path defect. It matters only if the script becomes a release gate. Before using it that way, either:

- run each case more than once and gate on an aggregate plus a minimum bound; or
- keep the script as a directional, human-reviewed evaluation and do not treat a single run as CI-stable.

The latest saved run meets the proposed thresholds: 87 cases, 100% non-default, 93.1% acceptable, approximately 573 ms mean latency, and approximately 1.10 s p95 latency.

### 2. Low priority: update stale implementation wording

The plan header still says the production selector is unchanged, even though this branch now implements it. A few comments and test descriptions also still say “emoji” where the behavior is now a Lucide icon. The main examples are:

- `docs/chat-group-automatic-icon-selection-plan.md` status;
- the header comment in `src/lib/auxiliary-ai.server.ts`;
- the header comment and a few descriptions in `workers/main/src/chat-thread/metadata.ts` and `workers/main/tests/user-do-chat-groups.test.ts`.

The legacy database column `avatar_emoji_last_attempt_at` is different: retaining that name avoids an unnecessary schema migration, so it should not be renamed merely for terminology consistency.

`git diff --check origin/main...HEAD` also reports the two Markdown hard-break lines in the plan header as trailing whitespace. This is non-functional, but replacing those hard breaks with normal paragraph spacing would restore a clean diff check.

## Missing-chat persistence audit

### What changed

The branch's Durable Object edits are limited to avatar behavior:

- legacy emoji or unknown avatar content is rendered as the default Lucide chat icon;
- the generated-avatar setter now validates and stores a Lucide name instead of an emoji;
- icon-selection outcome observability was added;
- associated RPC typings and tests were renamed or extended.

The automatic-selection implementation commit itself changes only the icon-generation path and observability in the Durable Object layer.

### What did not change

The complete branch diff does not change:

- thread creation, deletion, or transcript persistence;
- chat-group membership deletion or pruning behavior;
- chat-group or thread list queries;
- route loaders or chat-group API routes;
- authentication identity selection;
- organization or workspace scoping;
- Durable Object schemas or migrations;
- Wrangler/Miniflare persistence configuration;
- the `dev` or `dev:local-auth` commands.

The existing `closeChatGroup`, `removeThreadMembership`, `pruneMissingThreads`, and empty-group cleanup methods still exist, but none was modified by this branch.

### Read-only local-state evidence

A read-only inspection of `.wrangler/state/v3/do` found:

- nine persisted chat groups and nine group memberships;
- those groups split across two user identities: six under a generated user ID and three under `local-dev-user`;
- eight initialized `ChatThreadDO` databases with nonzero model-side and rendered-message rows.

No message content was read. This shows that the local records were not erased. The split across identities is consistent with viewing the app once through a normal authenticated session and another time through `bun run dev:local-auth`, or otherwise changing the active local user/session. An organization/workspace switch can create the same visible symptom.

If this recurs, first compare the command used to start the app, the active user/org/workspace, and the workspace directory whose `.wrangler/state` is in use. Do not clear `.wrangler/state` while investigating.

## Implementation strengths confirmed

- Only the short title is passed to the selector; the first message is not added as context.
- The title is quoted as data and the prompt explicitly rejects instruction-following from it.
- Output is bounded to three short terms and parsed defensively.
- Search uses a generated Lucide 0.562.0 metadata snapshot and returns verified renderable canonical names.
- The generic `messages-square` default is excluded from successful metadata candidates.
- Ordered alternatives, ambiguity handling, stable tie-breaking, and modifier penalties are deterministic and covered by tests.
- A model or metadata failure uses the existing observable default path rather than hiding the failure behind a random icon.
- User edits still win a race with background generation.
- The live evaluator calls the production selector directly and does not add a diagnostic application endpoint.
- The metadata generator is a developer command; ordinary builds do not fetch Lucide metadata over the network.

Lucide 0.562.0 currently has no populated `use-cases` values in its icon metadata, so the generator's use of names, aliases, tags, and categories does not omit useful current data.

## Verification performed

- Focused source tests: 5 files, 109 tests passed.
- Focused Worker tests: 2 files, 24 tests passed.
- `bun run typecheck`: passed.
- `bun run lint`: passed with warnings denied.
- `bun run build`: passed, including the Pi Bedrock build check.
- Production build confirms that the generated metadata and dynamic Lucide rendering bundle successfully.

No production code was changed as part of this review; this file is the only review artifact.
