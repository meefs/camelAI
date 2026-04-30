# Chat Usage Alerts Restyle — Feedback

## Summary

Visuals and CTA wiring landed correctly. Two issues to address before merging:

1. The BYOK helper copy is unclear and partially wrong in context.
2. The dev preview route at `/dev/chat-credit-states` does not render the alert directly above the prompt input — it renders at the top of the section, separated from the input by the simulated messages area. (The real Chat layout *is* correct; the dev preview is what's misleading.)

---

## Issue 1 — BYOK helper copy is confusing

### Where

[src/components/Chat.tsx:660-665](src/components/Chat.tsx#L660-L665) (low state, BYOK aside) and [src/components/Chat.tsx:618-622](src/components/Chat.tsx#L618-L622) (exhausted state, BYOK description).

Current strings:
- Low + BYOK: `"Own-key threads do not use hosted credits."`
- Exhausted + BYOK: `"Top up to keep using hosted models. Own-key threads continue to work."`

### Why it's wrong

The alert only appears when **this** thread is consuming hosted credits. If a user has a BYOK provider configured but is still seeing the alert, it's because the model in this thread isn't covered by their API key (e.g. they returned to an older chat using a hosted-only model). Telling them "own-key threads do not use hosted credits" answers the wrong question — they aren't confused about their other threads, they're confused about *why this thread is being charged when they thought BYOK covered it*.

The phrase **"own-key"** is also internal-jargon. Users entered an API key; they don't think of their threads as "own-key threads." The UI elsewhere uses "API key" / "your API key."

### Proposed copy

Both lines should explain *why* the alert is showing despite a configured API key, and reference "API key" instead of "own-key." Two options to choose from — first is more diagnostic, second is shorter:

**Option A (diagnostic):**
- Low + BYOK: `"This thread uses a hosted model that isn't covered by your API key, so it's drawing from hosted credits."`
- Exhausted + BYOK: `"This thread uses a hosted model that isn't covered by your API key. Top up to keep going, or switch to a model your key supports."`

**Option B (shorter):**
- Low + BYOK: `"This thread uses a hosted model — your API key doesn't cover it."`
- Exhausted + BYOK: `"This thread uses a hosted model your API key doesn't cover. Top up, or switch to a covered model."`

I'd ship Option A — it's a couple of words longer but actually answers the question a confused user is asking. Either way: drop "own-key" entirely from user-facing copy and replace with "your API key."

### Sanity check before applying

Confirm the assumption: is `hasByokProvider` true when the user has *configured* a key, regardless of whether the current thread/model is using it? If it's only true when the *current thread* is on BYOK, then the alert wouldn't show in the first place (BYOK threads don't consume hosted credits) — and the BYOK branch is unreachable. Worth a 30-second check at the call site in [Chat.tsx:4574-4580](src/components/Chat.tsx#L4574-L4580) and at `buildBillingCreditStatus` in [src/lib/chat-credit-status.ts:14-43](src/lib/chat-credit-status.ts#L14-L43) before rewriting copy.

---

## Issue 2 — Dev preview route renders the alert in the wrong position

### Where

[src/routes/dev.chat-credit-states.tsx:87-121](src/routes/dev.chat-credit-states.tsx#L87-L121).

### What's happening

Current layout in the preview section:

```
┌──── section ────────────────────────────────────────┐
│  m's Workspace (header)                              │
├──────────────────────────────────────────────────────┤
│  BillingCreditNotice         ← rendered HERE         │
├──────────────────────────────────────────────────────┤
│                                                      │
│   "Can you update the landing page copy?"            │
│                                                      │
│   [min-h-[28rem] of empty messages area]             │
│                                                      │
│   ChatErrorNotice (when send-error state)            │
├──────────────────────────────────────────────────────┤
│  Message camelAI                              [Send] │
└──────────────────────────────────────────────────────┘
```

The credit notice ends up pinned to the top, with ~28rem of empty messages area separating it from the prompt input. In the real Chat layout the `BillingCreditNotice` sits directly above `PromptInput` (call site verified at [src/components/Chat.tsx:4574-4580](src/components/Chat.tsx#L4574-L4580)), so this is **only a dev-preview bug** — but it's misleading enough that it makes the redesign look broken when iterating.

### Fix

Move both `BillingCreditNotice` and `ChatErrorNotice` to render **immediately above the prompt input** in the dev route, matching the real layout:

```
┌──── section ────────────────────────────────────────┐
│  m's Workspace (header)                              │
├──────────────────────────────────────────────────────┤
│                                                      │
│   "Can you update the landing page copy?"            │
│                                                      │
│   [min-h-[28rem] of empty messages area]             │
│                                                      │
├──────────────────────────────────────────────────────┤
│  ChatErrorNotice (when send-error)   ← above input  │
│  BillingCreditNotice                  ← above input  │
├──────────────────────────────────────────────────────┤
│  Message camelAI                              [Send] │
└──────────────────────────────────────────────────────┘
```

Concretely in [dev.chat-credit-states.tsx](src/routes/dev.chat-credit-states.tsx):

- Remove the `BillingCreditNotice` block at lines 93-99 from its current position.
- Remove the `ChatErrorNotice` line at line 105.
- Inside the bottom `<div className="border-t p-4">` wrapper at line 113, add a `<div className="mx-auto w-full max-w-3xl">` ancestor that stacks (in order, top-to-bottom): `ChatErrorNotice` (when `error`), `BillingCreditNotice` (when `creditStatus`), then the existing fake textarea row. Keep the textarea row as the last child so the input stays at the bottom.
- Drop the "Send a hosted-model message in this state to see the runtime result." placeholder block (lines 106-110) — once the alert is above the input, the empty messages area can just stay empty.

This also lets the reviewer see how the two alerts visually stack in the `send-error` state (the third mock from the design conversation), which is currently impossible because they're at opposite ends of the preview section.

### Verify after fixing

Walk through all five preview states (`low`, `low-byok`, `exhausted`, `exhausted-byok`, `send-error`) in both light and dark mode and confirm:
- Both alerts render directly above the textarea row, not at the top of the section.
- In `send-error`, the inline `ChatErrorNotice` sits above the inverted exhausted card, and both sit above the input — matching the layout requested in the original feedback.

---

## Nits (not blocking)

- `formatCredits` no longer appends `" credits"` ([Chat.tsx:506-510](src/components/Chat.tsx#L506-L510)). The low-state title compensates by saying `"… credits used this month"`, so the visual reads correctly. Worth a one-line code comment so a future reader doesn't reintroduce `" credits"` thinking it was lost in the refactor — the suffix is intentionally inlined into the surrounding sentence.
- `Progress` is positioned with `mt-2`. Visually fine; just verify in dark mode that the unfilled track has enough contrast against `bg-card` (Progress defaults to `bg-primary/20` track, which can read very faint on certain card surfaces). If it looks too washed out, bump to a more visible track via the `Progress` indicator className.

---

## Files to update

| File | Change |
|------|--------|
| [src/components/Chat.tsx](src/components/Chat.tsx) | Replace BYOK copy strings in both low and exhausted states (Option A above). |
| [src/routes/dev.chat-credit-states.tsx](src/routes/dev.chat-credit-states.tsx) | Move `BillingCreditNotice` and `ChatErrorNotice` to render directly above the simulated prompt input row. Drop the placeholder text block. |
