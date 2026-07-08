# Attachment Card Hover Preview — Round-3 Feedback (attachments pop-in)

**Date:** 2026-07-08
**Applies to:** the working tree after round 2 (`docs/group-attachment-hover-preview-feedback.md` applied).
**Round-2 verdict:** all applied correctly — borders removed with tint-only separation (R1), metadata hover is header+footer with message-line-only errors (R2), `FileCard` gained the opt-in `showAddOnHover` Plus swap (R3), image attachments render as an 88×88 thumbnail tile with skeleton/error fallback to `FileCard` (R4), text previews wrap with the 4,000-char render cap and generalized footnote (R5), and the table footnote gates on `totalRows` (F1). 29 tests pass, typecheck clean. **No changes requested to any of that.** This round is one new item from staging review.

---

## R6 — Attachments section pops in late and pushes the transcripts down

### What happens and why

`recentItems` (attachment cards + recently-used tags) is deliberately **streamed**: the loader returns it as an unresolved promise (`src/routes/_app.chat._index.tsx:452-467, :588`) because computing it requires fetching the full pi_core transcript of up to 8 group threads (`loadGroupNewChatRecentItems` → `chatDO.getPiCoreMessages` per thread) — far too slow to block first paint on. Until it resolves, `RecentlyUsedInGroup` renders the empty fallback (`recently-used-in-group.tsx:145-168`), so the Attachments row doesn't exist; transcript cards (built synchronously from group summaries) render at the top of the section. When the promise resolves, the tags row and Attachments row mount **above** the transcripts and shove them down. That's the jarring shift.

Keep the streaming — do not await the message scan in the loader (pi_core transcripts are large; that would trade a cosmetic shift for a slow page). The fix is to **know at first paint that attachments are coming and reserve their space with the real header + skeleton cards**.

### We *can* know — the signal already exists server-side

The user asked whether we can know there are attachments before the scan completes. Yes:

- Every thread row in `OrgDO` stores `first_user_message` and `last_user_message`, normalized by `normalizeThreadUserMessageText` at write time (`workers/main/src/identity/org-do.ts:6624, :6812`). That normalization strips mention/system/`⟦upload:…⟧` annotations **but keeps the `(user uploaded file to uploads/<name>)` markers** in the text (`src/lib/thread-preview.ts:15-27`, `stripUploadAnnotations` removes only the `⟦…⟧` metadata).
- The group loader already ships these threads to the page synchronously — the loader **awaits** the group view (`_app.chat._index.tsx:493`); only `recentItems` streams.
- The one trap: both summary-mapping sites truncate the texts to 500 chars (`src/lib/chat-groups.server.ts:50-57` and `:188-195`), and upload markers sit at the *end* of the message — a long prompt with an attachment loses its marker to truncation. So the hint must be extracted **from the full texts before truncation, server-side**, not parsed client-side from the truncated summaries.

Coverage of this signal: exact for any upload referenced in a thread's first or latest user message — which is where uploads overwhelmingly occur. A thread whose only uploads live in *middle* messages produces no hint (falls back to today's pop-in). That residual is accepted; see "Behavior matrix".

### Implementation

Five small edits, one shared helper. No Durable Object schema, storage, or API changes — the hint is computed in the loader layer from data OrgDO already returns.

**1. Hint helper — `src/lib/group-new-chat-recent-items.ts` (new export, unit-testable):**

```ts
import { isUserUploadMountPath, parseUploadRefs } from '@/lib/chat-attachment-refs';

/**
 * Upload mount paths referenced in a thread's first/latest user message
 * summaries. Used as a synchronous "attachments are coming" hint while the
 * full recent-items scan streams; generated transcripts are excluded by
 * filename since summary normalization strips the ⟦upload:…⟧ kind annotation.
 */
export function extractUploadRefPathsForHint(
  ...texts: Array<string | null | undefined>
): string[] {
  const paths = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const ref of parseUploadRefs(text).refs) {
      if (!isUserUploadMountPath(ref.mountPath)) continue;
      if (ref.originalName.endsWith('-transcript.md')) continue; // generated transcript uploads (Chat.tsx:3204)
      paths.add(ref.mountPath);
    }
  }
  return [...paths];
}
```

**2. Type — `src/types.ts`:** add to `ChatGroupThreadSummary` (`:62`):

```ts
/** Upload mount paths seen in first/latest user messages (pre-truncation); attachment-loading hint. */
upload_ref_paths?: string[];
```

and to `GroupNewChatPayload` (`:119`):

```ts
/** Expected attachment-card count while recentItems is still streaming. */
pendingAttachmentCount?: number;
```

**3. Both summary-mapping sites — `src/lib/chat-groups.server.ts`:** in `threadToGroupThreadSummary` (`:43`) and the `toThreadSummary` closure (`:173`), compute from the **full** `Thread` fields, before the 500-char truncation, and omit when empty to keep sidebar payloads lean:

```ts
const uploadRefPaths = extractUploadRefPathsForHint(
  thread.first_user_message,
  thread.last_user_message,
);
// …in the returned object:
...(uploadRefPaths.length > 0 ? { upload_ref_paths: uploadRefPaths } : {}),
```

The live-status merge in `src/hooks/use-chat-groups.tsx` overlays status fields by spreading the existing summary (`resolveThread`, ~`:750`), so the new optional field survives live updates — verify, but no change is expected there.

**4. Payload — `buildGroupNewChatPayload` in `_app.chat._index.tsx:114`:** count is only meaningful while `recentItems` is still a promise; mirror the extraction's dedupe-across-threads and its 8-card limit (`attachmentLimit` in `extractGroupNewChatRecentItems`):

```ts
const pendingAttachmentPaths = new Set<string>();
for (const thread of getGroupNewChatCandidateThreads(group)) {
  for (const path of thread.upload_ref_paths ?? []) pendingAttachmentPaths.add(path);
}
const pendingAttachmentCount = isPromiseLike(recentItems)
  ? Math.min(pendingAttachmentPaths.size, 8)
  : 0;
// …include pendingAttachmentCount in the returned payload
```

**5. Client — `recently-used-in-group.tsx`:** track pending and render skeletons under the real header.

```ts
const [recentItemsPending, setRecentItemsPending] = useState(() =>
  isPromiseLike(group.recentItems),
);
```

In the existing resolution effect (`:145-168`): the non-promise branch and both `.then`/`.catch` branches set `setRecentItemsPending(false)` (inside the `cancelled` guards); the promise branch sets it `true` alongside the fallback. Then:

```tsx
const showAttachmentSkeletons =
  recentItemsPending &&
  (group.pendingAttachmentCount ?? 0) > 0 &&
  attachmentCards.length === 0;
```

- Include `showAttachmentSkeletons` in the section's early-return visibility check (`:323`) alongside the three length checks.
- Attachments block renders when `attachmentCards.length > 0 || showAttachmentSkeletons`; the `h4` header ("Attachments") is the real one in both states — it must not flicker between states. Skeleton row, matching the FileCard/ImageTile footprint exactly so cards swap in place:

```tsx
{showAttachmentSkeletons
  ? Array.from({ length: Math.min(group.pendingAttachmentCount ?? 0, 8) }, (_, index) => (
      <Skeleton key={index} className="h-[88px] w-[88px] rounded-lg" />
    ))
  : attachmentCards.map((card) => ( /* existing RecentAttachmentCard */ ))}
```

(`Skeleton` from `@/components/ui/skeleton`; image attachments then continue skeleton → thumbnail seamlessly, since `ImageTile` opens with its own skeleton.)

### The two paint states

```text
  t0 — first paint (recentItems streaming, hint = 3)          t1 — recentItems resolves
  ────────────────────────────────────────────────            ────────────────────────────────────────────────
  RECENTLY USED IN THIS GROUP                                 RECENTLY USED IN THIS GROUP
                                                              [⌁ Admin API MCP] [⌁ GitHub]      ← tags mount (small residual push)
  ATTACHMENTS                                                 ATTACHMENTS
  ┌─────────┐ ┌─────────┐ ┌─────────┐                        ┌─────────┐ ┌─────────┐ ┌─────────┐
  │▒▒▒▒▒▒▒▒▒│ │▒▒▒▒▒▒▒▒▒│ │▒▒▒▒▒▒▒▒▒│                        │(IMG tile)│ │ CSV  ⊞  │ │ PDF  ▤ │  ← swap in place
  └─────────┘ └─────────┘ └─────────┘                        └─────────┘ └─────────┘ └─────────┘
  TRANSCRIPTS                                                 TRANSCRIPTS
  ┌────────┐ ┌────────┐ ┌────────┐                           ┌────────┐ ┌────────┐ ┌────────┐    ← stays put (modulo tags row)
```

### Behavior matrix

| Case | First paint | On resolve | Shift |
|---|---|---|---|
| Uploads in first/latest messages (the normal case) | Header + N skeletons | Cards replace skeletons in place; count may differ slightly (row reflows, no section mount) | ~none |
| Uploads only in middle messages of threads | Nothing (no hint) | Section mounts — today's behavior | Same as today (accepted residual) |
| Hint present but scan yields none (e.g. odd transcript-named file) | Header + skeletons | Block collapses | Rare, brief |
| No attachments anywhere | Nothing | Nothing | None — skeletons are never speculative |
| Tags (projects/connections) | Not reserved | Tags row mounts above attachments | Small (~one pill row), simultaneous with the skeleton→card swap, so the section settles in **one** paint instead of two |

The tags row is deliberately not predicted this round — mention annotations *are* stripped from the stored summaries at write time, so there is no equivalent free signal for tags, and the user's complaint is specifically the attachments block. If the residual tags push still feels bad in staging, that's a follow-up (likely an OrgDO-persisted hint), not a tweak to this change.

### Alternatives considered and rejected

- **Await the scan in the loader** — blocks TTFB on serializing up to 8 full pi_core transcripts; the streaming exists for good reason.
- **`has_user_uploads` column on OrgDO thread rows** — accurate forever, but needs a migration, write-path threading, and a backfill story (existing threads would read "unknown", so it wouldn't even fix current staging groups until new messages arrive). Escalation path if the hint proves insufficient, not this round.
- **sessionStorage cache of last-resolved recentItems per group** — fixes repeat visits only, introduces a new client-cache pattern and staleness edge cases for a cosmetic issue.
- **Move attachments below transcripts** — rejected by design: attachments are the higher-value row and stay on top.

### Classification

- **Required:** helper (1), type fields (2), both summary sites (3), payload count (4), client pending/skeletons (5).
- **Cuttable:** the `-transcript.md` filename filter inside the helper — cutting it means a group whose recent messages only inserted transcripts briefly shows skeletons that collapse. Keep it unless it causes trouble.
- **Deliberately not included:** OrgDO schema flag, any cache, tags-row reservation, changes to summary truncation or `normalizeThreadUserMessageText`.

---

## Tests (agent-actionable)

- `tests/group-new-chat-recent-items.test.ts`: `extractUploadRefPathsForHint` — extracts marker paths from either text; dedupes across first/latest; excludes `*-transcript.md` originals (stored name `foo-transcript-1751-ab12.md` → excluded); returns `[]` for null/marker-free text; a marker beyond position 500 of a long message still extracts (the motivating case — full text in, not the truncated summary).
- `tests/chat-groups-server.test.ts`: a thread whose `last_user_message` is >500 chars ending in an upload marker hydrates with `upload_ref_paths` containing that path while `latest_user_message` stays truncated; marker-free threads omit the field.
- `tests/recently-used-in-group.test.tsx`: with `recentItems` a pending promise and `pendingAttachmentCount: 2` → "Attachments" header + 2 skeletons and no `RecentAttachmentCard`; after resolve with one card → skeletons gone, card rendered; with `pendingAttachmentCount: 0` and pending promise → no attachments block; resolve-to-empty removes the block.
- Run: `bun run test:run -- tests/group-new-chat-recent-items.test.ts tests/chat-groups-server.test.ts tests/recently-used-in-group.test.tsx tests/attachment-hover-preview.test.tsx`, then `bun run typecheck`.
