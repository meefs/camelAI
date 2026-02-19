# Get Help Flow — Round 2 Feedback

## Changes Reviewed

Uncommitted diff addressing items #1–#9 from `docs/get-help-flow-feedback.md`.

All 36 help-related tests pass. The implementation correctly addresses most of the feedback items. Below is what needs attention.

---

## Bugs

### 1. Description textarea has no max height

**Severity: High** — Directly impacts usability.

The `<Textarea>` at `src/components/get-help-dialog.tsx:222-230` has `min-h-[120px]` but no max height. When a user writes a long message, the textarea (and the entire dialog) grows unbounded, eventually pushing the submit button off-screen.

**Fix:** Add `max-h-[240px]` (or similar) alongside the existing `min-h-[120px]`. Tailwind's Textarea component should already handle `overflow-y: auto` when content overflows, but verify scrolling works after adding the constraint.

```tsx
className="min-h-[120px] max-h-[240px]"
```

This caps the textarea at roughly 10 lines while still giving room for a meaningful message. The dialog stays a fixed, predictable size.

---

## Code Quality

### 2. Helper text duplicates the placeholder

**Severity: Low** — Minor visual redundancy, no functional issue.

The `aria-describedby` helper text added at line 231–233:

```tsx
<p id={descriptionHelpTextId} className="text-xs text-muted-foreground">
  Include what happened, what you expected, and steps to reproduce if applicable.
</p>
```

Says essentially the same thing as the placeholder:

```tsx
placeholder="What happened? What did you expect? Include steps to reproduce if applicable."
```

When the textarea is empty, the user sees both. Once they start typing, the placeholder disappears and the helper text remains — but it's still the same guidance repeated.

**Options:**
- **A) Change the helper text** to something complementary rather than redundant — e.g., `"The more detail you include, the faster we can help."` This gives the `aria-describedby` a distinct purpose (encouragement/context) while the placeholder handles the structural guidance.
- **B) Remove the visible helper text** and keep only the `aria-describedby` linkage to the placeholder itself (set `aria-describedby` to point at a visually-hidden element with the same text, or just rely on the placeholder for sighted users).

Option A is probably the best UX — it adds value for both sighted and screen reader users without repeating the placeholder.

---

## What Was Done Well

The agent addressed the feedback items cleanly:

| # | Original Item | Verdict |
|---|---------------|---------|
| 1 | Toast not appearing | Fixed correctly — `successToastShownRef` guard + filtering `lastResult` on success + removing `submission.reply()` from success response. Three-pronged fix that addresses all the suspected causes. |
| 2 | Logo — Cloudflare Images URL | Clean. `baseUrl` removed from template props, interface, `email.server.ts` args, `help.ts`, and all tests. |
| 3 | Duplicate truncation | Removed from template. Test moved to `help-email-delivery.test.ts` where the truncation actually happens. |
| 4 | `form={form.id}` linkage | Verified with new test. |
| 5 | Success flow + toast test | Added — tests `toast.success` call and `onOpenChange(false)`. |
| 6 | HTML escaping test | Added — confirms `<script>` is escaped to `&lt;script&gt;`. |
| 7 | AI prompt content assertion | Added — asserts exact system prompt text. |
| 8 | Email delivery failure test | Added — confirms the `waitUntil` `.catch()` logs the error and doesn't crash the worker. |
| 9 | `aria-describedby` | Added with persistent helper text (see item #2 above for polish note). |

---

## Summary

| # | Item | Priority | Type |
|---|------|----------|------|
| 1 | Textarea needs `max-h` to prevent dialog overflow | High | Bug |
| 2 | Helper text duplicates placeholder — rephrase | Low | Polish |
