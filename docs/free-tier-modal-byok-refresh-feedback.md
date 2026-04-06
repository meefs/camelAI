# Free Tier Modal + BYOK Refresh — Review Feedback

**Date:** 2026-04-05

---

## 1. Remove the Dev Override Flag

The agent added `DEV_ALWAYS_SHOW_FREE_TIER_MODAL=1` to `.dev.vars` (line 7) and wired it through `_app.tsx` (line 84-85) → `cloudflare.server.ts` (line 42) → `Chat.tsx` (line 1018, `forceFreeTierModal`).

**Remove all of it:**
- Delete `DEV_ALWAYS_SHOW_FREE_TIER_MODAL=1` from `.dev.vars` (line 7)
- Remove `DEV_ALWAYS_SHOW_FREE_TIER_MODAL?: string` from `cloudflare.server.ts` (line 42)
- Remove `freeTierModalDebugAlways` from the loader return in `_app.tsx` (lines 84-85)
- Remove `forceFreeTierModal` reading and all references in `Chat.tsx` (line 1018 and anywhere it's used in `shouldShowFreeTierModalForMessage` or the dev-force paths like `forceSetFreeTierModalPending` / `clearFreeTierModalPending`)

**Why:** Testing the modal should use the real `localStorage` counter. Just clear `freeTierModalSeen:{userId}` and `userMessageCount:{userId}` in devtools to re-trigger. A persistent dev flag that bypasses the real logic risks masking bugs in the counter flow. The five helper functions around pending/seen/force are over-engineered for what's needed — see section below.

Also clean up `workers/main/src/types.ts` (line with `DEV_ALWAYS_SHOW_FREE_TIER_MODAL`) if the binding was added there.

---

## 2. Simplify the Free Tier Modal Counter Logic

The current implementation has six helper functions (`shouldShowFreeTierModalForMessage`, `hasPendingFreeTierModal`, `markFreeTierModalSeen`, `forceSetFreeTierModalPending`, `clearFreeTierModalPending`) plus three storage key prefixes and a `persistPending` option with `sessionStorage`.

This is too complex. The modal fires once on the 3rd message — it doesn't need a pending/seen two-phase system. Simplify to:

```typescript
const FREE_TIER_MODAL_SEEN_PREFIX = 'freeTierModalSeen:';
const FREE_TIER_MSG_COUNT_PREFIX = 'freeTierMsgCount:';

function shouldShowFreeTierModal(userId: string | undefined): boolean {
  if (!userId) return false;
  try {
    if (localStorage.getItem(`${FREE_TIER_MODAL_SEEN_PREFIX}${userId}`) === 'true') return false;
    const count = Number(localStorage.getItem(`${FREE_TIER_MSG_COUNT_PREFIX}${userId}`) || '0');
    return count >= 3;
  } catch {
    return false;
  }
}

function incrementFreeTierCount(userId: string): number {
  try {
    const key = `${FREE_TIER_MSG_COUNT_PREFIX}${userId}`;
    const next = Number(localStorage.getItem(key) || '0') + 1;
    localStorage.setItem(key, String(next));
    return next;
  } catch {
    return 0;
  }
}

function markFreeTierModalSeen(userId: string): void {
  try {
    localStorage.setItem(`${FREE_TIER_MODAL_SEEN_PREFIX}${userId}`, 'true');
  } catch {}
}
```

In `sendMessage()`:
```typescript
const count = incrementFreeTierCount(user.id);
if (count === 3 && !showFreeTierModal) {
  setShowFreeTierModal(true);
}
```

No `sessionStorage`, no pending keys, no persist options, no force functions.

---

## 3. Redesign the Free Tier Modal

The current modal has centered text, an X close button, and two side-by-side action buttons ("Add API key" + "Got it"). It needs a full redesign. Here's the exact spec for the updated modal:

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  (i)  A quick heads up on usage                                  │
│                                                                  │
│  camelAI is free to use. We want everyone to have access         │
│  to a powerful coding assistant.                                 │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  FREE TIER LIMITS                                        │    │
│  │                                                          │    │
│  │  Rolling 5-hour window                            $25    │    │
│  │  Rolling 7-day window                            $100    │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  🔑  Want unlimited usage? Add your own API key.         │    │
│  │      You're billed directly by the provider, and         │    │
│  │      camelAI adds zero markup.                           │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                        Got it                             │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Specific changes from current implementation:

**A. Remove the X close button.** The Dialog should not have the default close X. Use `DialogContent` without the close button (add `hideCloseButton` or override with `className`). The only way to dismiss is the "Got it" button.

**B. Left-align the header with an info icon.** Replace the centered `DialogTitle` with a left-aligned header row:
```tsx
<DialogHeader>
  <div className="flex items-center gap-2">
    <Info className="size-5 text-primary" />
    <DialogTitle className="text-base font-semibold">A quick heads up on usage</DialogTitle>
  </div>
</DialogHeader>
```
Icon: `Info` from lucide-react, `size-5 text-primary`.

**C. Left-align the subtitle text.** Not centered:
```tsx
<p className="text-sm text-muted-foreground">
  camelAI is free to use. We want everyone to have access to a powerful coding assistant.
</p>
```

**D. Replace the icon-per-limit rows with a labeled table-style card.** Current has `Clock` and `CalendarDays` icons per row. Replace with:
```tsx
<div className="rounded-lg border bg-muted/50 p-4 space-y-3">
  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
    Free tier limits
  </p>
  <div className="space-y-2">
    <div className="flex items-center justify-between text-sm">
      <span>Rolling 5-hour window</span>
      <span className="font-medium">$25</span>
    </div>
    <div className="flex items-center justify-between text-sm">
      <span>Rolling 7-day window</span>
      <span className="font-medium">$100</span>
    </div>
  </div>
</div>
```

**E. Make the API key pitch a distinct alert-style card.** Currently it's a plain `<p>` tag. Turn it into a visually distinct callout with a key icon and an inline link:
```tsx
<div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
  <div className="flex gap-3">
    <KeyRound className="size-4 mt-0.5 shrink-0 text-primary" />
    <p className="text-sm text-muted-foreground">
      Want unlimited usage?{' '}
      <Link to="/settings/organization/ai-provider" onClick={onClose} className="underline text-foreground font-medium">
        Add your own API key.
      </Link>{' '}
      You're billed directly by the provider, and camelAI adds zero markup.
    </p>
  </div>
</div>
```
Icon: `KeyRound` from lucide-react. "Add your own API key." is an inline underlined link — not a separate button.

**F. Single full-width "Got it" button.** Remove the "Add API key" button from the footer. The link in the callout card above handles navigation. The footer has one button:
```tsx
<DialogFooter>
  <Button variant="outline" onClick={onClose} className="w-full">
    Got it
  </Button>
</DialogFooter>
```

**G. Remove `'use client'` directive.** This is a React Router / Vite app, not Next.js. The `'use client'` on line 1 of `free-tier-modal.tsx` should not be there.

### Updated component structure:

```
FreeTierModal
├── Dialog (no X button)
│   ├── DialogContent sm:max-w-md
│   │   ├── DialogHeader (left-aligned)
│   │   │   ├── Info icon + "A quick heads up on usage"
│   │   │   └── Subtitle paragraph
│   │   ├── Limits card (table layout, "FREE TIER LIMITS" label)
│   │   ├── API key callout (primary tint, KeyRound icon, inline link)
│   │   └── DialogFooter
│   │       └── "Got it" button (outline, full-width)
│   └── (mobile: Sheet variant, same content)
```

---

## 4. AI Provider Settings Page — Reduce Visual Bulk

The current implementation wraps each radio option in its own bordered container (`ProviderOptionCard` with `rounded-lg border p-4`), then the selected provider's inputs are inside another `rounded-xl border p-5` container, and inside that is the collapsible instructions in yet another `rounded-lg border bg-muted/50`. That's three nested visual containers.

### Changes:

**A. Remove the per-radio-option containers.** Go back to plain radio items — no border, no padding, no highlight on selection. The radio bullet itself is enough visual indication:

```tsx
<RadioGroup value={selectedProvider} onValueChange={...} className="space-y-3">
  {PROVIDER_CARD_OPTIONS.map((option) => (
    <div key={option.value} className="flex items-start gap-3">
      <RadioGroupItem value={option.value} id={`provider-${option.value}`} className="mt-0.5" />
      <Label htmlFor={`provider-${option.value}`} className="cursor-pointer space-y-0.5">
        <span className="text-sm font-medium">{option.label}</span>
        <p className="text-xs text-muted-foreground">{option.description}</p>
      </Label>
    </div>
  ))}
</RadioGroup>
```

Delete the `ProviderOptionCard` component entirely.

**B. Remove the outer container around the provider setup section.** The key input, collapsible instructions, and region select should render as direct children of the page flow — no wrapping `rounded-xl border p-5` container. The `Separator` or a simple `mt-6` gap is enough visual separation between the radio group and the provider-specific fields.

**C. Remove the "Default selected" explainer card.** When "Default (free tier)" is selected, don't show the `rounded-lg border bg-muted/50` card that restates the limits. The description on the radio option already says "$25/5hrs, $100/7days" — repeating it in a card below is redundant. Show nothing.

**D. Fix the collapsible instructions layout.** The "Open [Provider]" link is currently in its own right-aligned `<div className="flex justify-end">` block above the numbered steps, which looks disconnected. Instead, move the link inline with step 1:

```tsx
<ol className="space-y-2 text-sm text-muted-foreground">
  <li className="flex gap-2">
    <span className="w-5 shrink-0 text-foreground">1.</span>
    <span>
      Go to{' '}
      <a href={guide.href} target="_blank" rel="noreferrer noopener" className="underline text-foreground">
        {guide.href.replace('https://', '')}
      </a>
    </span>
  </li>
  {guide.steps.slice(1).map((step, i) => (
    <li key={step} className="flex gap-2">
      <span className="w-5 shrink-0 text-foreground">{i + 2}.</span>
      <span>{step}</span>
    </li>
  ))}
</ol>
```

Remove the separate "Open [Provider]" button entirely. The link is now part of the step text itself, which reads naturally: "Go to console.anthropic.com/settings/keys".

Update the step text in `PROVIDER_GUIDES` to remove the "Go to [url]." prefix from step 1 since it's now handled by the inline link rendering. Change step 1 for each provider to just be the human-readable action:
- Anthropic step 1: just rendered as `Go to console.anthropic.com/settings/keys` (the link portion is the URL)
- OpenAI step 1: `Go to platform.openai.com/api-keys`
- Bedrock step 1: `Go to your AWS Console and open Bedrock`

**E. Default the collapsible instructions to collapsed.** The current implementation sets `defaultOpen={!config}` (expanded when no key is configured). Change this to **always start collapsed** regardless of config state. Users who need help can click to expand. This keeps the page compact and avoids overwhelming users who already know how to get their key.

In `ProviderSetupInstructions`, the initial `open` state should be `false`. Also simplify the `useEffect` in the parent that currently toggles `instructionsOpen` based on config/provider — remove it and just initialize `instructionsOpen` to `false`.

### Resulting layout (no extra containers):

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  AI Provider                                                     │
│  Add your own API key to remove usage limits. You're billed      │
│  directly by the provider — camelAI adds zero markup.            │
│                                                                  │
│  ──────────────────────────────────────────────────────────────  │
│                                                                  │
│  ┌─ Current Key ─────────────────────────────────────────────┐   │
│  │  Anthropic          Key: sk-ant-···abc    Updated 4/1     │   │
│  │                                      [Test]   [Remove]    │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Choose a provider                                               │
│                                                                  │
│  ◉ Default (free tier)                                           │
│    Free with usage limits ($25/5hrs, $100/7days)                 │
│                                                                  │
│  ○ Anthropic (recommended)                                       │
│    Direct access to Claude models                                │
│                                                                  │
│  ○ OpenAI                                                        │
│    For Codex-powered threads                                     │
│                                                                  │
│  ○ AWS Bedrock                                                   │
│    Claude via your AWS account                                   │
│                                                                  │
│  ──────────────────────────────────────────────────────────────  │
│                                                                  │
│  Anthropic API Key                                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  sk-ant-...                                               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─ How to get your API key ──────────────────── [▸ expand] ─┐   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Model selection is configured per thread in the chat UI.        │
│                                                                  │
│  [Save]                                                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 5. Fix "Claude model selection" Copy

**File:** `_app.settings.organization.ai-provider.tsx` (line 573)

**Current:** `"Claude model selection is still configured per thread in the web chat UI."`

**Change to:** `"Model selection is configured per thread in the chat UI."`

Drop "Claude" because the page supports OpenAI and Bedrock too. Drop "still" — it reads like an apology. Drop "web" — unnecessary qualifier.

---

## 6. BYOK Reconnect Implementation — Looks Good

The `byokChanged()` RPC on `ChatThreadDO`, the `notifyByokChanged()` broadcast on `OrgDO`, the `waitUntil` call in the API route, and the close code `4001` handling all look correct. The success message on the settings page ("Your active chats are now using your key and do not need a refresh") is a nice touch.

No changes needed here.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/components/free-tier-modal.tsx` | Full rewrite: remove `'use client'`, left-align header with `Info` icon, table-style limits card, alert-style API key callout with inline link, single full-width "Got it" button, remove X close button |
| `src/components/Chat.tsx` | Remove all dev-force logic (`forceFreeTierModal`, `forceSetFreeTierModalPending`, `clearFreeTierModalPending`), simplify to 3 helper functions (see section 2), remove `appLoaderData` cast for `freeTierModalDebugAlways` |
| `src/routes/_app.tsx` | Remove `freeTierModalDebugAlways` from loader return |
| `src/lib/cloudflare.server.ts` | Remove `DEV_ALWAYS_SHOW_FREE_TIER_MODAL` from env type |
| `workers/main/src/types.ts` | Remove `DEV_ALWAYS_SHOW_FREE_TIER_MODAL` if added |
| `.dev.vars` | Remove `DEV_ALWAYS_SHOW_FREE_TIER_MODAL=1` line |
| `src/routes/_app.settings.organization.ai-provider.tsx` | Remove `ProviderOptionCard` component, use plain radio items, remove outer container around provider setup, remove "Default selected" explainer card, fix collapsible instructions (inline link in step 1, remove separate "Open" button), change model selection copy |
