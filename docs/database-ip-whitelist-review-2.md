# Code review #2 — Sandbox IP whitelisting (design polish pass)

**Plan reviewed against:** `docs/database-ip-whitelist-review.md` (the design feedback section)
**Reviewer:** illiana (via Claude)
**File of interest:** `src/components/connections/sandbox-ip-notice.tsx`

## Verdict

The agent correctly applied four of the five design changes from the previous review:

| Change | Status |
|---|---|
| Drop the info icon | ✅ Removed |
| Drop the "Learn more" link | ✅ Removed (`SANDBOX_NETWORK_DOCS_URL` import gone) |
| Drop the Supabase/BigQuery sentence | ✅ Removed |
| IP pill is the click target (no separate Copy button) | ✅ Done — single `<button>` with `Copy`/`Check` from lucide |
| Pill background flush with alert (no `bg-background`) | ✅ Done |

Two visual nits remain. **Both are one-line tailwind tweaks. Nothing else in the file needs to change.**

## Remaining issues

### 1. Font size mismatch — pill text is too large

The `<Alert />` primitive (`src/components/ui/alert.tsx:6,54`) uses `text-xs/relaxed` for both the alert body and the description. The current pill uses `text-sm`, which is one Tailwind step larger (`0.875rem` vs `0.75rem`). Side-by-side this makes the IP look like a different typographic system from the rest of the modal, which is exactly what we don't want for a value the user is supposed to read as part of the surrounding sentence.

**Fix — exact change:**

```diff
- className="inline-flex items-center gap-2 rounded border border-border/50 px-3 py-1.5 font-mono text-sm text-foreground transition-colors hover:bg-muted/50"
+ className="inline-flex items-center gap-2 rounded border border-border px-3 py-1.5 font-mono text-xs text-foreground transition-colors hover:bg-muted/50"
```

`text-sm` → `text-xs`. That's the font-size tweak. (The other change in that diff line is issue #2 below — they're in the same className string, so apply both at once.)

While you're there, the icon size should drop a notch too, so the icon doesn't look oversized next to the smaller text:

```diff
-          {copied ? (
-            <Check className="size-3.5" />
-          ) : (
-            <Copy className="size-3.5" />
-          )}
+          {copied ? (
+            <Check className="size-3" />
+          ) : (
+            <Copy className="size-3" />
+          )}
```

`size-3.5` → `size-3`.

### 2. Border opacity — pill outline is too light

The pill currently uses `border-border/50` (half-opacity border). The alert wrapper itself uses a solid `border` (full opacity, the default `border-border`). The half-opacity pill border ends up *lighter than the surrounding alert's border*, which makes the click target harder to see and inverts the expected visual hierarchy (interactive elements should have at least the same contrast as the container they sit in, not less).

**Fix:**

```diff
- border-border/50
+ border-border
```

Drop the `/50`. Use the full-opacity token. This makes the pill border match the alert's outer border.

## Combined target — final markup

For clarity, here's the final state of the `<button>` element after both fixes (no other changes to the file):

```tsx
<button
  type="button"
  onClick={copyIp}
  className="inline-flex items-center gap-2 rounded border border-border px-3 py-1.5 font-mono text-xs text-foreground transition-colors hover:bg-muted/50"
  aria-label={copied ? 'Copied' : `Copy IP address ${SANDBOX_OUTBOUND_IP}`}
>
  <span>{SANDBOX_OUTBOUND_IP}</span>
  {copied ? (
    <Check className="size-3" />
  ) : (
    <Copy className="size-3" />
  )}
</button>
```

Three token changes total: `text-sm` → `text-xs`, `border-border/50` → `border-border`, `size-3.5` → `size-3`. No other lines in `sandbox-ip-notice.tsx` need to move.

## Why these specifics matter

The Alert's design system is doing the work for you — `text-xs/relaxed` is the alert body's font size, and `border-border` is its border token. By matching those exact values, the pill stops being "a thing the agent designed inside an alert" and starts being "a thing that belongs to the alert." That's what alignment looks like at the token level.

Do **not** introduce any new colors, opacities, sizes, or shadows beyond the three swaps above. If the result still looks off after these three changes, ping me with a screenshot rather than guessing — don't iterate on tokens speculatively.
