# Text Input Field Persistence

## Status

March 14, 2026 — Draft v2

## Problem

When a user refreshes the page or navigates between threads, the chat composer loses all unsent text and attachment references. If a user drafts a message in Thread A, switches to Thread B, and returns to Thread A, their draft is gone. The same applies to the "New Chat" welcome screen. This causes frustration and lost work.

## Goal

Each thread and the "New Chat" screen act as independent persistent drafts. Text and completed attachment metadata survive page refreshes, tab closures, and thread-to-thread navigation. Drafts update in real time as the user edits (including clearing naturally when the user deletes all text and attachments). On send, the draft is kept in localStorage as a safety net until the server confirms receipt — only then is it removed.

---

## Design

### Storage Model

Use `localStorage` keyed per workspace + thread (or `"new"` for the welcome screen). This survives page refreshes and tab closures without any server round-trips.

```
Key format:
  draft:{workspaceId}:{threadId}    → thread-specific draft
  draft:{workspaceId}:new           → welcome screen (new chat) draft

Value (JSON):
  {
    "text": "the user's unsent message",
    "attachments": [
      {
        "id": "abc123",
        "name": "data.csv",
        "path": "/mnt/user-uploads/data.csv",
        "size": 1024,
        "contentType": "text/csv",
        "status": "complete"
      }
    ],
    "savedAt": 1710400000000
  }
```

**What is persisted:**
- Draft text (`input` / `welcomeInput`)
- Completed attachments only (`status === 'complete'`) — in-progress uploads cannot be resumed
- `previewUrl` is excluded (blob URLs are not valid across page loads)

**What is NOT persisted:**
- In-progress uploads (`status === 'uploading'`)
- Failed uploads (`status === 'error'`)
- Blob preview URLs (regenerated as needed — see note below)

**Image preview URLs:** Completed image attachments that were persisted will not have `previewUrl` on restore. This is acceptable because the `AttachmentList` component already falls back to `FileCard` rendering when `previewUrl` is absent. No changes needed to `AttachmentList`.

### Lifecycle

```
User types / adds attachment
        │
        ▼
  ┌──────────────┐
  │  Debounced    │──── 500ms ────▶ localStorage.setItem(key, draft)
  │  save         │
  └──────────────┘
        │
        │ (on unmount / navigation: flush synchronously instead of cancelling)
        ▼

Component mounts (thread change / page load)
        │
        ▼
  ┌──────────────┐
  │  Load draft   │──── localStorage.getItem(key) ────▶ setInput() + setAttachments()
  └──────────────┘

User sends message
        │
        ├── UI state cleared optimistically (existing behavior, unchanged)
        │   Draft stays in localStorage as a safety net
        │
        ▼
  ┌──────────────────────────────────────────────────────┐
  │  Wait for confirmation                               │
  │                                                      │
  │  In-thread: WebSocket `result` event (line 2331)     │──▶ clearDraft()
  │  New chat:  createThreadFetcher success (line 3039)  │──▶ clearDraft()
  │                                                      │
  │  On failure:                                         │
  │  `error` event (line 2389)                           │──▶ restore draft → input
  │  Reconnect exhaustion (line 2446)                    │──▶ restore draft → input
  │  Thread creation error (line 3059)                   │──▶ restore draft → welcomeInput
  └──────────────────────────────────────────────────────┘
```

### Eviction

To prevent unbounded localStorage growth, apply a simple eviction policy:

- On save, if total draft keys (`draft:*`) exceed **50**, delete the oldest by `savedAt`.
- This is a generous limit and only exists as a safety net.

---

## Implementation

### Step 1: Create `useDraftPersistence` Hook

**File to create:** `src/hooks/use-draft-persistence.ts`

This hook encapsulates all draft read/write/clear logic. It is the only file that touches localStorage for drafts.

```typescript
import { useEffect, useRef, useCallback } from 'react';
import type { Attachment } from '@/components/attachment-list';

interface DraftData {
  text: string;
  attachments: SerializedAttachment[];
  savedAt: number;
}

// Attachment without transient fields (previewUrl, progress, error)
interface SerializedAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  contentType?: string;
  originalName?: string;
  status: 'complete';
}

function draftKey(workspaceId: string, threadId: string | null): string {
  return `draft:${workspaceId}:${threadId ?? 'new'}`;
}

function serializeAttachments(attachments: Attachment[]): SerializedAttachment[] {
  return attachments
    .filter((a) => a.status === 'complete')
    .map(({ id, name, path, size, contentType, originalName }) => ({
      id,
      name,
      path,
      size,
      contentType,
      originalName,
      status: 'complete' as const,
    }));
}

function evictOldDrafts(maxDrafts: number) {
  const draftEntries: { key: string; savedAt: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('draft:')) {
      try {
        const val = JSON.parse(localStorage.getItem(key)!);
        draftEntries.push({ key, savedAt: val.savedAt ?? 0 });
      } catch {
        // Malformed — remove it
        localStorage.removeItem(key!);
      }
    }
  }
  if (draftEntries.length > maxDrafts) {
    draftEntries.sort((a, b) => a.savedAt - b.savedAt);
    const toRemove = draftEntries.length - maxDrafts;
    for (let i = 0; i < toRemove; i++) {
      localStorage.removeItem(draftEntries[i].key);
    }
  }
}

export function loadDraft(
  workspaceId: string,
  threadId: string | null
): { text: string; attachments: Attachment[] } | null {
  try {
    const raw = localStorage.getItem(draftKey(workspaceId, threadId));
    if (!raw) return null;
    const data: DraftData = JSON.parse(raw);
    return {
      text: data.text ?? '',
      attachments: (data.attachments ?? []).map((a) => ({
        ...a,
        status: 'complete' as const,
      })),
    };
  } catch {
    return null;
  }
}

/**
 * Immediately write draft state to localStorage (no debounce).
 * Used by flushDraft and clearDraft — both need synchronous guarantees.
 */
export function writeDraft(
  workspaceId: string,
  threadId: string | null,
  text: string,
  attachments: Attachment[]
) {
  const serialized = serializeAttachments(attachments);
  if (!text.trim() && serialized.length === 0) {
    localStorage.removeItem(draftKey(workspaceId, threadId));
    return;
  }
  const data: DraftData = {
    text,
    attachments: serialized,
    savedAt: Date.now(),
  };
  localStorage.setItem(draftKey(workspaceId, threadId), JSON.stringify(data));
  evictOldDrafts(50);
}

export function removeDraft(workspaceId: string, threadId: string | null) {
  localStorage.removeItem(draftKey(workspaceId, threadId));
}

export function useDraftPersistence(
  workspaceId: string | undefined,
  threadId: string | null
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep a ref to the latest draft state so the unmount cleanup can flush it.
  const latestRef = useRef<{ text: string; attachments: Attachment[] } | null>(null);

  const saveDraft = useCallback(
    (text: string, attachments: Attachment[]) => {
      if (!workspaceId) return;

      // Always update the ref so unmount flush has the latest state.
      latestRef.current = { text, attachments };

      if (timerRef.current) clearTimeout(timerRef.current);

      timerRef.current = setTimeout(() => {
        writeDraft(workspaceId, threadId, text, attachments);
        timerRef.current = null;
      }, 500);
    },
    [workspaceId, threadId]
  );

  const clearDraft = useCallback(() => {
    if (!workspaceId) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    latestRef.current = null;
    removeDraft(workspaceId, threadId);
  }, [workspaceId, threadId]);

  // On unmount: if a debounced write is still pending, flush it synchronously
  // so that type-then-navigate-immediately doesn't lose the draft.
  useEffect(() => {
    return () => {
      if (timerRef.current && latestRef.current && workspaceId) {
        clearTimeout(timerRef.current);
        writeDraft(
          workspaceId,
          threadId,
          latestRef.current.text,
          latestRef.current.attachments
        );
      }
    };
  }, [workspaceId, threadId]);

  return { saveDraft, clearDraft };
}
```

**Key decisions:**
- `loadDraft` is a standalone function (not part of the hook) so it can be called during `useState` initialization without violating hook rules
- Save is debounced at 500ms to avoid thrashing localStorage on every keystroke
- **Flush on unmount:** The cleanup effect flushes the latest pending state synchronously instead of cancelling it, so type-then-navigate within 500ms does not lose the draft
- `writeDraft` and `removeDraft` are exported for direct use in success/failure handlers (see Steps 2e and 2f)
- Empty drafts (no text, no attachments) are removed rather than stored as empty objects
- Attachment serialization strips transient fields (`previewUrl`, `progress`, `error`)

---

### Step 2: Integrate into `Chat.tsx` — In-Thread Chat

**File to modify:** `src/components/Chat.tsx`

#### 2a. Import the hook and `loadDraft`

Near the top imports:

```typescript
import { useDraftPersistence, loadDraft, removeDraft, writeDraft } from '@/hooks/use-draft-persistence';
```

#### 2b. Initialize `input` and `attachments` state from persisted draft

Around line 1069, the current code is:

```typescript
const [input, setInput] = useState('');
```

And line 1077:

```typescript
const [attachments, setAttachments] = useState<Attachment[]>([]);
```

Change `input` initialization to restore from draft. Because the Chat component is keyed by `threadId` (line 266 in `_app.chat.$id.tsx`), the component fully remounts on thread change — so `useState` initializers run fresh for each thread.

Replace the `input` initializer:

```typescript
const [input, setInput] = useState(() => {
  if (readOnly) return '';
  const draft = loadDraft(workspaceId, threadId);
  return draft?.text ?? '';
});
```

Replace the `attachments` initializer:

```typescript
const [attachments, setAttachments] = useState<Attachment[]>(() => {
  if (readOnly) return [];
  const draft = loadDraft(workspaceId, threadId);
  return draft?.attachments ?? [];
});
```

**Note:** `loadDraft` is called twice here. Since it's a synchronous localStorage read and the data is tiny, this is fine — no need to optimize. If you prefer, hoist the result into a single `const initialDraft = readOnly ? null : loadDraft(workspaceId, threadId)` above both `useState` calls and reference it in each initializer.

#### 2c. Set up the persistence hook

After the state declarations (around line 1078), add:

```typescript
const { saveDraft, clearDraft } = useDraftPersistence(workspaceId, threadId);
```

#### 2d. Save draft on input or attachment changes (in-thread only)

Add an effect after the hook setup. **This effect is explicitly gated on `threadId` being truthy** — the welcome screen has its own separate effect (step 3b). This prevents both effects from running simultaneously.

```typescript
useEffect(() => {
  if (!threadId || readOnly) return;
  saveDraft(input, attachments);
}, [input, attachments, saveDraft, readOnly, threadId]);
```

This fires on every change to `input` or `attachments`, but the actual localStorage write is debounced inside `saveDraft`.

#### 2e. Clear draft on confirmed success, not on send initiation

**Do NOT call `clearDraft()` inside `sendMessage()`.** The existing code already clears the UI state optimistically (`setInput('')`, `setAttachments([])`). The localStorage draft is kept as a safety net until the server confirms receipt.

**In-thread: clear on `result` event (line 2331 in the WebSocket message handler):**

Inside the `sdkEvent.type === 'result'` branch (around line 2331), after `setLoading(false)` (line 2349), add:

```typescript
// Draft confirmed delivered — clear localStorage backup
if (workspaceId) {
  removeDraft(workspaceId, threadId);
}
```

**In-thread: restore draft on `error` event (line 2389):**

Inside the `data.type === 'error'` branch (around line 2389), after `setLoading(false)` (line 2402), add:

```typescript
// Message failed — restore draft from localStorage so user doesn't lose their text
const savedDraft = loadDraft(workspaceId, threadId);
if (savedDraft) {
  setInput(savedDraft.text);
  setAttachments(savedDraft.attachments);
}
```

**In-thread: restore draft on reconnect exhaustion (line 2446):**

Inside the `else` branch of reconnect attempts (around line 2445), add:

```typescript
// Reconnect exhausted — restore draft from localStorage
const savedDraft = loadDraft(workspaceId, id);
if (savedDraft) {
  setInput(savedDraft.text);
  setAttachments(savedDraft.attachments);
}
```

**Note on `/compact` and `preserveDraft`:** Because `clearDraft()` is no longer called inside `sendMessage()` at all, the `/compact` preserve-draft path (`handleCompactFromIndicator` at line 3613) is not affected. The draft is cleared only on `result`, which is correct — compaction completes with a `result` event too, but by that point `preserveDraft` has already kept the UI input intact, and the save-on-change effect will re-persist the still-present input text to localStorage on the next debounce cycle. No regression.

---

### Step 3: Integrate into `Chat.tsx` — Welcome Screen (New Chat)

The welcome screen input uses `welcomeInput` / `setWelcomeInput` (line 1072). It shares the same `attachments` state as the in-thread chat.

#### 3a. Initialize `welcomeInput` from draft when no external initial value

Line 1072 currently:

```typescript
const [welcomeInput, setWelcomeInput] = useState(() => initialWelcomeInput ?? '');
```

Change to:

```typescript
const [welcomeInput, setWelcomeInput] = useState(() => {
  if (initialWelcomeInput) return initialWelcomeInput;
  const draft = loadDraft(workspaceId, null);
  return draft?.text ?? '';
});
```

The welcome screen also needs its own draft persistence. Since `threadId` is `undefined` on the welcome screen, the hook already handles this via the `null` threadId → `draft:{workspaceId}:new` key.

#### 3b. Save welcome screen draft

Add another effect. **This effect is explicitly gated on `threadId` being falsy** — the inverse of the in-thread save effect (step 2d). Only one of the two effects runs at a time.

```typescript
useEffect(() => {
  if (threadId) return; // Only for welcome screen (no threadId)
  saveDraft(welcomeInput, attachments);
}, [welcomeInput, attachments, saveDraft, threadId]);
```

**Important:** The `saveDraft` / `clearDraft` returned from the hook are already scoped to the correct `threadId` (`null` for welcome screen). On the welcome screen route (`_app.chat._index.tsx`), the Chat component is rendered without a `threadId` prop, so `threadId` is `undefined`. The hook handles this via `threadId ?? 'new'` in the key construction, producing `draft:{workspaceId}:new`.

#### 3c. Clear welcome screen draft on confirmed thread creation, not on submit

**Do NOT call `clearDraft()` inside `startNewChat()`.** The existing code already clears the UI state optimistically (`setWelcomeInput('')`, `setAttachments([])`). The localStorage draft is kept until the thread is actually created.

In the `createThreadFetcher` success handler (line 3039), where `data.thread` is truthy and `pendingNewChatRef.current` is set, add **before** the `navigate()` call:

```typescript
// Thread created successfully — clear the welcome screen draft
if (workspaceId) {
  removeDraft(workspaceId, null); // null = welcome screen key
}
```

On failure (line 3059 `data.error` branch), restore the draft:

```typescript
// Thread creation failed — restore draft so user doesn't lose their text
const savedDraft = loadDraft(workspaceId, null);
if (savedDraft) {
  setWelcomeInput(savedDraft.text);
  setAttachments(savedDraft.attachments);
}
```

#### 3d. Also restore welcome-screen attachments from draft

The `attachments` state initializer (step 2b) already loads from `loadDraft(workspaceId, threadId)`. On the welcome screen, `threadId` is null/undefined, so it will load from the `draft:{workspaceId}:new` key. This means welcome-screen attachments are automatically restored — no separate change needed if the `attachments` initializer uses the same `threadId` that the welcome screen path uses.

**Edge case — `initialWelcomeInput` from sales prompt:** When `initialWelcomeInput` is provided (sales site handoff), the draft should NOT override it. The initializer in step 3a already handles this: `if (initialWelcomeInput) return initialWelcomeInput`.

---

### Step 4: Effect mutual exclusion — why the two save effects don't conflict

The Chat component serves both the welcome screen (`welcomeInput`) and active threads (`input`). Both need draft saving, but the two effects are **explicitly gated to be mutually exclusive**:

- **Step 2d** (in-thread): `if (!threadId || readOnly) return;` — only runs when `threadId` is truthy
- **Step 3b** (welcome screen): `if (threadId) return;` — only runs when `threadId` is falsy

This means exactly one effect is active at any time. The shared `saveDraft` callback from the hook is scoped to the correct localStorage key via `threadId` (or `null` → `"new"`), so there is no key collision.

---

## Files Summary

| Action | File | Changes |
|--------|------|---------|
| **Create** | `src/hooks/use-draft-persistence.ts` | New hook with `useDraftPersistence`, `loadDraft`, eviction logic |
| **Modify** | `src/components/Chat.tsx` | Import hook, restore state from draft on mount, save on change, clear on send |

No new dependencies. No server-side changes. No database changes. No new API routes.

---

## Verification Checklist

### Basic persistence
- [ ] Type text in a thread, refresh the page → text is restored
- [ ] Type text in "New Chat", refresh → text is restored
- [ ] Type text in Thread A, navigate to Thread B, navigate back to Thread A → text in A is restored
- [ ] Type text in Thread A, navigate to "New Chat" → New Chat has its own independent draft
- [ ] Type text in "New Chat", navigate to Thread A, navigate back to "New Chat" → New Chat text is restored

### Attachments
- [ ] Add a file attachment (completed upload) in a thread, refresh → attachment card reappears
- [ ] Add a file in Thread A, switch to Thread B, switch back → file still shown in Thread A
- [ ] Start an upload, refresh before it completes → in-progress upload is NOT restored (expected)
- [ ] Image attachments restored from draft show as `FileCard` (not thumbnail) since blob URL is gone — this is acceptable

### Send clears draft on confirmed success
- [ ] Type text + attach file in a thread, send the message, wait for `result` → draft is cleared from localStorage
- [ ] Start a new chat from welcome screen with text + attachment, thread created → welcome draft is cleared
- [ ] After sending, navigate away and return → composer is empty (no stale draft)
- [ ] `/compact` with unsent text in composer → draft is NOT cleared (preserveDraft behavior), input text survives

### Failure recovery — draft restored
- [ ] Send a message, simulate WebSocket `error` event → draft text is restored into the composer
- [ ] Send a message, simulate reconnect exhaustion (5 attempts) → draft text is restored into the composer
- [ ] Start a new chat, simulate thread creation failure → welcomeInput is restored from draft

### Navigation timing — flush on unmount
- [ ] Type text in a thread, immediately switch threads (< 500ms) → draft is still saved (flush on unmount)
- [ ] Type text in a thread, immediately refresh (< 500ms) → draft is still restored on reload

### Edge cases
- [ ] `initialWelcomeInput` from sales prompt takes priority over persisted draft
- [ ] Read-only threads (`?adminReadonly=1`) do not load or save drafts
- [ ] Opening 50+ threads and typing in each does not cause localStorage errors (eviction works)
- [ ] Malformed localStorage entries do not crash the app (graceful fallback to empty)

---

## Not in Scope

- **Server-side draft persistence**: Drafts are local-only. No KV/DO storage for drafts.
- **Cross-device sync**: Drafts do not sync between devices or browsers.
- **Resumable uploads**: In-progress file uploads cannot be resumed after page reload. Only completed attachment metadata is persisted.
- **Image preview restoration**: Blob URLs are not valid across page loads. Restored image attachments render as `FileCard` instead of thumbnails. Fetching the image from R2 to regenerate previews is out of scope.
- **Draft indicators in sidebar**: No visual indicator in the thread list showing which threads have unsent drafts.
