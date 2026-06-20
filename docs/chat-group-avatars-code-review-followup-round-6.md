# Chat Group Avatars Code Review - Follow-up Round 6

Date: 2026-06-20

Scope: review of the latest diff against `origin/main` after the round 5 follow-up implementation.

## Findings

### 1. Low: Chat group rename/avatar Save has no success notification

`src/routes/_app.chat.$id.tsx:1381-1400`  
`src/routes/_app.chat._index.tsx:989-1008`

The user/workspace avatar modal now confirms a successful immediate save with `"Avatar updated"`, and the duplicate-toast issue appears fixed. The chat group rename/avatar modal still silently closes and revalidates after a successful `PATCH /api/chat-groups/:id`.

This is not hard to implement. Both chat route modules already have a single `renameGroup(...)` handler with a `response.ok` branch. Add `toast.success("Chat group updated")` in that branch, and preferably `toast.error("Failed to update chat group")` when the request fails. Both files will need `toast` imported from `sonner`.

Recommended tests:

- Successful chat group rename dispatches the avatar local event, revalidates, and shows one `"Chat group updated"` toast.
- Failed chat group rename does not dispatch the local avatar event and shows an error toast.

I would keep the message generic (`"Chat group updated"`) because the same modal can change name, avatar, or both.

## Confirmed Improved

- The user/workspace avatar save flow now processes each fetcher result once, avoiding the repeated `"Avatar updated"` toast/revalidation loop.
- The main profile/workspace form success effects also now guard against repeated handling of the same action data.
- The pending chat group avatar reconciliation test is now green.
- The local/server pending-avatar lifecycle still has a fallback path for long-running pending states.

## Checks Run

- `bun run test:run tests/settings-avatar-save-ui.test.tsx tests/settings-avatar-actions.test.ts tests/avatar.test.ts tests/chat-groups-routes.test.ts tests/chat-groups-ui.test.tsx tests/chat-group-avatar-generation.test.ts` - passed, 109 tests.
- `bun run test:workers -- workers/main/tests/user-do-chat-groups.test.ts workers/main/tests/chat-thread-title-generation.test.ts workers/main/tests/chat-thread-agent-eval.test.ts workers/main/tests/chat-thread-completion-summary.test.ts workers/main/tests/admin-api-chat-errors.test.ts workers/main/tests/admin-index-chat-errors.test.ts` - passed, 37 tests.
- `bun run typecheck` - passed.
