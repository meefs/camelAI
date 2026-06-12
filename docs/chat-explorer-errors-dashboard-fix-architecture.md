# Chat Explorer Errors Dashboard Fix Architecture

This note covers the three follow-up bugs identified after the first implementation pass. The goal is a small, durable fix that keeps the admin index fast while making the metadata trustworthy.

## 1. Model-History Repair Is Bypassed

### Problem

`AppIndexDatabase.getChatExplorerThreads()` turns a missing D1 `model_history` into `[row.model]`, and `hydrateMissingChatExplorerThreadMetadata()` repeats that fallback before deciding whether a row needs repair. Once the fallback exists, `shouldRepairChatExplorerRow()` no longer asks OrgDO or ChatThreadDO for the real history.

This makes stale rows look valid while showing only the current/latest model.

### Solution

Separate persisted data from display fallback.

`getChatExplorerThreads()` should return raw D1 state for `model_history`. If D1 has null, keep it null in the loader-facing row. The UI helper can still display `[model]` as a visual fallback, but fallback display must not masquerade as repaired data.

In `hydrateMissingChatExplorerThreadMetadata()`:

- decide repair targets from the raw D1 row before applying any fallback values;
- treat `model_history == null` as a repair target when `model` exists;
- also treat rows as "suspect" when `model_history` contains only the current model and `last_model_changed_at` is null, because those may be fallback-persisted rows from the broken path;
- query OrgDO first, because it is the authoritative source for selected model history;
- use ChatThreadDO only if OrgDO cannot repair the row, as a bounded page-level fallback.

Keep `[row.model]` fallback only at the rendering edge. If the fallback is used, do not persist it as a repaired history unless no better source exists and the implementation explicitly marks it as best-effort.

### Acceptance Tests

- A D1 row with `model_history = NULL` and an OrgDO thread history of `["sonnet","gpt-5.4-mini"]` returns both models after hydration.
- A D1 row with `model_history = ["gpt-5.4-mini"]`, `last_model_changed_at = NULL`, and a richer OrgDO history is repaired from OrgDO.
- The Chat Explorer UI still shows the current model when no durable history exists.

## 2. Direct Send/Enqueue Failures Bypass Error Recording

### Problem

`recordCurrentThreadError()` currently runs from `pushChatEvent()` only. Browser-visible send failures in `handleRunnerClientUserMessage()` use `sendDirect()` with `chatSendErrorPayload()` at the enqueue exception and non-accepted result branches, so those errors never increment `chat_error_count` or insert `chat_error_events`.

These are exactly the failures the dashboard needs to surface: sandbox send failures, blocked org sends, credit/billing failures, and command/message enqueue failures.

### Solution

Create one central helper for direct user-visible chat errors, for example:

```ts
private sendDirectChatError(
  ws: WebSocket,
  error: unknown,
  options: {
    status?: "busy" | "error" | string;
    fallbackMessage: string;
    source: "runner_enqueue" | "runner_send" | "chat_init";
  },
): void
```

The helper should:

1. Build the existing payload through `chatSendErrorPayload()` so browser behavior does not change.
2. Extract `error`, `status`, `errorType`, `provider`, and `model` from that payload.
3. Call `recordCurrentThreadError()` before sending.
4. Call `sendDirect(ws, payload)`.

Use this helper for the two `handleRunnerClientUserMessage()` failure branches. Do not automatically record every protocol/init error unless product wants that noise; start with user-message send failures because they represent failed user actions and map directly to the dashboard goal.

The existing short-window dedupe in `recordCurrentThreadError()` is enough to prevent duplicate records when a single failure is also later emitted through `pushChatEvent()`.

### Acceptance Tests

- A thrown enqueue failure records one thread error and sends the same WebSocket error payload as before.
- A non-accepted enqueue result records one thread error, including billing/credit metadata when present.
- Repeated identical failures in the dedupe window do not double-count.

## 3. Affected-Thread Query Can Duplicate Threads

### Problem

`getChatErrorThreads()` groups by `e.user_id` and `u.email` as well as `e.thread_id`. If two error events for the same thread have different attributed users, the side panel shows duplicate rows for one thread. That makes the panel disagree with `affected_thread_count`, which is based on `COUNT(DISTINCT thread_id)`.

### Solution

Make the affected-thread query one row per thread. Aggregate events by `thread_id` first, then join stable metadata.

Recommended shape:

```sql
WITH grouped AS (
  SELECT
    thread_id,
    MAX(created_at) AS last_seen_at,
    COUNT(*) AS count,
    MAX(org_id) AS org_id,
    MAX(workspace_id) AS workspace_id,
    (
      SELECT user_id
      FROM chat_error_events latest
      WHERE latest.fingerprint = ?
        AND latest.thread_id = e.thread_id
        AND latest.created_at >= ?
        AND latest.created_at < ?
      ORDER BY latest.created_at DESC
      LIMIT 1
    ) AS latest_user_id
  FROM chat_error_events e
  WHERE e.fingerprint = ?
    AND e.created_at >= ?
    AND e.created_at < ?
  GROUP BY thread_id
)
SELECT
  grouped.thread_id,
  t.title,
  COALESCE(t.org_id, grouped.org_id) AS org_id,
  o.name AS org_name,
  COALESCE(t.workspace_id, grouped.workspace_id) AS workspace_id,
  w.name AS workspace_name,
  COALESCE(t.created_by, grouped.latest_user_id) AS user_id,
  u.email AS user_email,
  grouped.last_seen_at,
  grouped.count
FROM grouped
LEFT JOIN threads t ON grouped.thread_id = t.id
LEFT JOIN orgs o ON o.id = COALESCE(t.org_id, grouped.org_id)
LEFT JOIN workspaces w ON w.id = COALESCE(t.workspace_id, grouped.workspace_id)
LEFT JOIN users u ON u.id = COALESCE(t.created_by, grouped.latest_user_id)
ORDER BY grouped.last_seen_at DESC, grouped.count DESC, grouped.thread_id ASC
LIMIT ? OFFSET ?
```

Using `t.created_by` as the primary user keeps the row stable and matches the rest of the admin thread views. `latest_user_id` is only a fallback for cases where the thread row is missing from the D1 index.

### Acceptance Tests

- Two events with the same fingerprint/thread but different `user_id` values return one affected-thread row with `count = 2`.
- The number of side-panel rows for a fingerprint never exceeds the number of distinct affected threads for the current page.
- Missing thread joins still return ids, counts, and links.

## Implementation Order

1. Fix model-history repair by preserving raw D1 `model_history` through the loader and moving `[model]` fallback to the UI/display layer.
2. Add direct-send error recording through a central helper and replace the two user-message send failure branches.
3. Rewrite `getChatErrorThreads()` around a grouped-by-thread CTE.
4. Add focused regression tests for each bug before broad cleanup.
