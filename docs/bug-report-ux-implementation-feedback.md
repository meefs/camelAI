# Bug Report UX — Implementation Feedback

Overall the implementation is solid. The type changes propagate cleanly, typecheck passes, the parser handles both old and new formats, and the voice recording integration follows the established prompt-input pattern correctly. A few things to address:

---

## 1. Escape key during recording will close the dialog

The Escape key handler for cancelling voice recording (`window.addEventListener('keydown', ...)`) calls `event.preventDefault()`, but Radix's Dialog listens for Escape via its own internal handler to close the dialog. The `preventDefault()` on the window listener may not reliably stop Radix from also catching it, depending on event ordering.

This means pressing Escape while recording could both cancel the recording AND close the dialog, which is not what we want — the user wants to cancel the recording but keep the dialog open.

**Fix:** When voice recording is active, prevent the dialog from closing on Escape. Radix Dialog accepts an `onEscapeKeyDown` callback on `DialogContent`:

```tsx
<DialogContent
  className="sm:max-w-[500px]"
  onEscapeKeyDown={(event) => {
    if (isActiveRecording || isTranscribing) {
      event.preventDefault();
      cancelRecording();
    }
  }}
>
```

Then remove the separate `useEffect` with `window.addEventListener` — the `onEscapeKeyDown` handler on `DialogContent` is the right place to handle this since it hooks into Radix's own event pipeline.

**File:** `src/components/bug-report-dialog.tsx`

---

## 2. Capture summary uses hyphens instead of middle dots

In the detail dialog (line 71), the separator between captured items uses hyphens:

```
Screenshot captured - DOM snapshot captured - Console logs captured
```

The plan specified middle dots (`·`) as separators:

```
Screenshot captured · DOM snapshot captured · Console logs captured
```

The middle dot reads better as a list separator at this small text size. Minor but worth fixing.

**File:** `src/components/bug-report-preview/bug-report-detail-dialog.tsx` line 71

---

## 3. CardHeader renders the icon and title side-by-side incorrectly

The `CardHeader` component from shadcn uses `grid` layout with `auto-rows-min` — it's designed for stacked title/description, not inline flex. Putting `flex items-center gap-2` on `CardHeader` is adding flex to a grid container, which may cause unexpected layout behavior.

**Fix:** Don't put flex on `CardHeader` itself. Instead, wrap the icon and title in a single `CardTitle`:

```tsx
<CardHeader>
  <CardTitle className="flex items-center gap-2 text-sm font-medium">
    <Bug className="size-4 text-muted-foreground shrink-0" />
    Bug Report
  </CardTitle>
</CardHeader>
```

This uses `CardTitle`'s default styling and puts the flex layout where it belongs — on the content, not the grid container.

**File:** `src/components/bug-report-preview/bug-report-card.tsx` lines 40-43

---

## 4. Card footer shows raw app name — should show vanity domain

The card footer shows `appName` which is the script name (e.g. `myapp`), but the plan's ASCII mockup showed the full vanity domain (e.g. `myapp.chiridion.app`). The vanity domain is more useful context for the user since that's the URL they were looking at.

The vanity domain isn't available from the parsed message text alone (the message says `deployed app "myapp"`, not the full domain). Two options:

**Option A (simple):** Append `.chiridion.app` to the app name in the card. This is technically not always correct (staging uses a different vanity domain), but it's good enough for display purposes and matches what the user sees in the preview toolbar.

**Option B (accurate):** Leave it as-is showing just the app name. It's still clear enough.

I'd go with Option A — just format it as `{appName}.chiridion.app` in the card footer and detail dialog. If you do this, the code change is in `bug-report-card.tsx` and `bug-report-detail-dialog.tsx`.

Your call on this one — it's cosmetic.

---

## 5. The `reportPath` prop is unused

`BugReportCard` accepts `reportPath` as a prop and sets it as a `data-report-path` attribute on the button, but it's never functionally used — it's not passed to the detail dialog, and the dialog doesn't fetch or link to the report. The `data-` attribute on the button serves no purpose since nothing reads it.

**Fix:** Either remove `reportPath` from `BugReportCardProps` and the `data-report-path` attribute, or if you want to keep it for future use, at least remove the `data-` attribute (it's just DOM clutter). The parser still extracts `reportPath` which is fine for the type, but the component doesn't need it right now.

**File:** `src/components/bug-report-preview/bug-report-card.tsx`

---

That's it. Items 1 and 3 are functional issues that should be fixed. Items 2, 4, and 5 are polish.
