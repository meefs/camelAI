# Recent Chats on Welcome Screen — Implementation Notes

## Status

Completed.

The `/chat` welcome screen now includes a **Your recent chats** section, and `first_user_message` is populated for both:
- New threads created from the welcome composer
- Existing threads (lazy backfill when a thread is opened)

## What shipped

- Added a recent-chats row to the welcome screen.
- Renamed the apps section heading from **Pick up where you left off** to **Continue building an app**.
- Added `first_user_message` support to thread data.
- Added lazy backfill so old threads gradually gain preview text.

## Key behavior

### New threads

1. User submits the first prompt from the welcome screen.
2. `/chat` index action sends `firstMessage` into `chatDO.createThread(...)`.
3. `OrgDO.createThread(...)` stores `first_user_message` (trimmed to 500 chars).

### Existing threads (lazy backfill)

1. User opens `/chat/:id`.
2. Loader fetches parsed JSONL messages.
3. If thread has no `first_user_message`, we extract the first valid user message:
   - ignore meta/compact-summary messages
   - strip `<camelai system message>...</camelai system message>` tags
   - strip `[Name (email)]:` / `[Name]:` author prefixes
   - trim and truncate to 500 chars
4. Loader schedules `setThreadFirstUserMessage(...)` with `waitUntil`.
5. `OrgDO.setThreadFirstUserMessage(...)` writes only when field is null/empty and does not change `updated_at`.

## Files changed

| File | Change |
|------|--------|
| `workers/main/src/auth.ts` | V14 migration added `threads.first_user_message`; `createThread` accepts/stores `firstUserMessage`; added `setThreadFirstUserMessage()` (null/empty only, no `updated_at` mutation). |
| `src/types.ts` | `Thread` now includes optional `first_user_message?: string \| null`. |
| `src/lib/chat-do.server.ts` | Maps `first_user_message`; passes through on `createThread`; added `getRecentThreads()` and `setThreadFirstUserMessage()`. |
| `src/lib/thread-preview.ts` | New shared utility for extracting normalized first-user-message text from parsed messages. |
| `src/routes/_app.chat._index.tsx` | Loader fetches `recentThreads`; action passes `firstMessage` into `createThread`. |
| `src/routes/_app.chat.$id.tsx` | Added lazy backfill on thread open using `getFirstThreadPreviewUserMessage(...)` + `waitUntil(...)`. |
| `src/components/Chat.tsx` | `welcomeData` now carries `recentThreads`. |
| `src/components/welcome-screen/index.tsx` | Added recent-chats section + heading rename for apps section. |
| `src/components/welcome-screen/recent-chat-card.tsx` | New card component (title, preview text, relative time). |
| `src/components/welcome-screen/recent-chats-row.tsx` | New horizontal row component for recent chats. |

## Notes

- Backfill is gradual by design (on access), not a one-time global migration.
- Recent-chat cards still work if preview text is missing; title + timestamp remain visible.
