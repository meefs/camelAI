# BYOK Modal — Feedback

The structural work is solid: dialog opens correctly, four-provider pill row, Bedrock region picker conditional, model-coverage note, X close button retained, errors surfaced inside the dialog, Enter-to-submit, OpenRouter default. Three polish issues to address — two visual, one already done by the user.

---

## 1. Shrink the input back to the codebase default; shrink the pills to match

In [src/components/onboarding/byok-key-dialog.tsx:129](src/components/onboarding/byok-key-dialog.tsx#L129), the input has `className="h-11 font-mono text-sm"`. The default `<Input>` in this codebase is `h-7` ([src/components/ui/input.tsx:11](src/components/ui/input.tsx#L11)) — every other input in the app is that height. The `h-11` override here is the agent trying to make the input match the pill height above it, which I called out in the plan but was the wrong call in retrospect.

The fix is to **drop the input override and shrink the pills**, not the other way around. The codebase convention is small-and-tight inputs; we should match.

**Changes:**

- [byok-key-dialog.tsx:129](src/components/onboarding/byok-key-dialog.tsx#L129): remove `h-11`. Keep `font-mono text-sm` (mono is correct for an API key paste target). Result: `className="font-mono text-sm"`.
- [byok-key-dialog.tsx:97](src/components/onboarding/byok-key-dialog.tsx#L97): change `className="h-11 px-2 text-sm font-medium ..."` to `className="px-3 text-sm font-medium ..."` (drop the `h-11`, add a touch more horizontal padding so the labels don't crowd). The ToggleGroup `size="lg"` variant at [toggle-group.tsx:21](src/components/ui/toggle-group.tsx#L21) is already `h-8 px-2.5` — let it apply.
- [byok-key-dialog.tsx:138](src/components/onboarding/byok-key-dialog.tsx#L138): drop the `!h-11` on the `SelectTrigger` (Bedrock region picker). Let the default Select height apply for consistency with everything else.

The pills will read as compact controls — exactly like the tabs and toggle groups elsewhere in settings. The input will read as a normal input. The visual rhythm is "form fields, all the same height," not "everything pumped up to 44px."

While there: re-check the X close button position after the height changes. The current `absolute top-2 right-2` ([dialog.tsx:69](src/components/ui/dialog.tsx#L69)) should still align fine against the smaller form, but eyeball it.

---

## 2. Drop the display font from the dialog title

[byok-key-dialog.tsx:64](src/components/onboarding/byok-key-dialog.tsx#L64) reads:

```tsx
<DialogTitle className="font-[family-name:var(--font-display)] text-xl font-normal">
  Add your API key
</DialogTitle>
```

The display font is correct on the paywall heading because it's a marketing-weight surface — the user is making a purchase decision. Dialogs in the rest of the product (`invite-member-dialog`, `create-workspace-dialog`, `create-org-dialog`, `bug-report-dialog`, etc.) use the default `text-sm font-medium` `DialogTitle` styling. Mixing the display font in here breaks that convention and makes this single dialog look like a different product surface.

**Change:**

- [byok-key-dialog.tsx:64](src/components/onboarding/byok-key-dialog.tsx#L64): drop the `font-[family-name:var(--font-display)] text-xl font-normal` override. Either:
  - **Use the default**: `<DialogTitle>Add your API key</DialogTitle>` — matches every other dialog in the product.
  - **Or bump just one notch for prominence**: `<DialogTitle className="text-base">Add your API key</DialogTitle>` — slightly larger than the default `text-sm` since this is a focused single-task dialog, but no font-family change.

Recommend the first option (pure default) for full consistency. If the title feels too small after dropping the override, then go with `text-base`.

---

## 3. Description copy already trimmed (no action needed)

The user has already removed `"We never see your key after setup."` from the description, leaving:

```tsx
<DialogDescription className="text-sm">
  Your provider bills you directly.
</DialogDescription>
```

That's correct — the full claim was vague and not strictly accurate (the key is encrypted at rest with `INTEGRATION_SECRET_KEY` and decrypted on each request, so we technically *can* see it; we just don't display it back). No further change.

---

## What to do

1. Drop `h-11` from the input ([byok-key-dialog.tsx:129](src/components/onboarding/byok-key-dialog.tsx#L129)).
2. Drop `h-11` from the pills ([byok-key-dialog.tsx:97](src/components/onboarding/byok-key-dialog.tsx#L97)) and add `px-3`.
3. Drop `!h-11` from the Bedrock region SelectTrigger ([byok-key-dialog.tsx:138](src/components/onboarding/byok-key-dialog.tsx#L138)).
4. Remove the display font + size override on `DialogTitle` ([byok-key-dialog.tsx:64](src/components/onboarding/byok-key-dialog.tsx#L64)). Default it.
5. Re-screenshot in both Anthropic (no region) and Bedrock (with region) states to confirm the row alignment and overall density read as a normal form dialog.
