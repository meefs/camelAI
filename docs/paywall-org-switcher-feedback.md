# Paywall Org Switcher — Implementation Feedback

## Summary

Implementation matches the plan. Verified behavior end-to-end against a brand-new org and a multi-org user — both work as designed. Four changes required, listed below. All four should be made before this ships.

---

## 1. Vertically center the paywall in the content area

The takeover currently sits flush near the top of `<SidebarInset>` and leaves a large empty band below. The cause is in [src/components/billing/paywall-takeover.tsx:282-285](src/components/billing/paywall-takeover.tsx#L282-L285):

```tsx
return (
  <div className="flex min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <div className="space-y-5 text-left">
```

The outer is `flex` with default row direction and default cross-axis alignment `stretch`. The inner div has `mx-auto` (horizontal centering only), so it stretches to fill the height of the parent, and the content inside (`space-y-5`) stacks from the top of that stretched container.

### Change

```tsx
return (
  <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <div className="m-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <div className="space-y-5 text-left">
```

Two effective edits: `flex` → `flex flex-col` on the outer, `mx-auto` → `m-auto` on the inner. In a flex column `m-auto` distributes auto margins on both axes and centers the child both horizontally and vertically. This pattern is **scroll-safe**: when content is taller than the viewport, auto margins collapse to zero and the parent's `overflow-y-auto` scrolls normally — so we don't get the "centered but top is clipped" failure mode you'd get from `items-center`.

Keep `py-8` as the minimum breathing room when the content does happen to be near the viewport height.

### Verify after the change

- Tall viewport (1200px+): paywall centered, equal space above and below.
- Standard laptop (768–900px): paywall centered with comfortable top/bottom padding.
- Short viewport (~500px): content scrolls from the top, nothing clipped.

---

## 2. Delete the dead BYOK branch in `handleSelectPlan`

[src/components/billing/paywall-takeover.tsx:242-250](src/components/billing/paywall-takeover.tsx#L242-L250):

```tsx
if (cta.kind === "byok") {
  if (paywallContext.byokProviderLabel) {
    revalidator.revalidate();
    return;
  }
  setShowProviderError(false);
  setByokDialogOpen(true);
  return;
}
```

The `byokProviderLabel ? revalidate()` branch is unreachable in the takeover. `paywallContext.byokProviderLabel` is only populated by `_app.tsx` when `!billingAccessReady`, but if BYOK is configured, `billingAccessReady` is true ([`_app.tsx:69-74`](src/routes/_app.tsx#L69-L74)) and the takeover doesn't render at all. The branch was a carry-over from `welcome.tsx` where it made sense; here it's dead.

### Change

```tsx
if (cta.kind === "byok") {
  setShowProviderError(false);
  setByokDialogOpen(true);
  return;
}
```

Also drop the now-unused `useRevalidator` import and `const revalidator = useRevalidator()` at line 72 *if and only if* the change in §3 below also removes its other caller (it does — both calls go away together).

---

## 3. Remove the manual `revalidator.revalidate()` after BYOK save

[src/components/billing/paywall-takeover.tsx:186-194](src/components/billing/paywall-takeover.tsx#L186-L194):

```tsx
useEffect(() => {
  if (providerFetcher.state !== "idle" || !providerFetcher.data?.success) {
    return;
  }
  setByokDialogOpen(false);
  setError(null);
  setShowProviderError(false);
  revalidator.revalidate();
}, [providerFetcher.data, providerFetcher.state, revalidator]);
```

React Router auto-revalidates loaders after `useFetcher` action submits, including cross-route ones. The explicit `revalidator.revalidate()` is redundant and triggers a second loader pass.

### Change

```tsx
useEffect(() => {
  if (providerFetcher.state !== "idle" || !providerFetcher.data?.success) {
    return;
  }
  setByokDialogOpen(false);
  setError(null);
  setShowProviderError(false);
}, [providerFetcher.data, providerFetcher.state]);
```

Remove `revalidator` from the dependency array. Combined with §2, this means `useRevalidator` is no longer needed in this component — delete the import at line 2 and the `const revalidator = useRevalidator()` at line 72.

### Verify after the change

Save a BYOK key from the takeover, confirm:
- The takeover unmounts.
- `/chat` renders.
- The network panel shows the `/api/orgs/:id/llm-provider` POST followed by exactly one `_app.tsx` loader fetch (no duplicate).

---

## 4. Make the dev preview reflect real viewport behavior

[src/routes/dev.billing-paywall.tsx:276](src/routes/dev.billing-paywall.tsx#L276) wraps the takeover in `<section className="min-h-[680px] overflow-hidden rounded-lg border">`. The 680px floor is arbitrary and won't show the centering behavior from §1 at different viewport heights. Once vertical centering is in, the preview should match what real users see inside `SidebarInset`.

### Change

```tsx
<section className="min-h-[80vh] overflow-hidden rounded-lg border">
```

This gives the preview enough room to show centered-with-breathing-room at the dominant laptop heights, and the preview-page header above it still keeps the rest of the dev controls accessible without scrolling.

---

## Out of Scope (Confirmed Working)

The following were verified during testing and need no changes:

- Brand-new signup flow: PlanPicker in `welcome.tsx` → Stripe checkout → return to `/onboarding?checkout=success` → auto-complete → boot modal → seeded first-chat. Untouched and intact.
- Multi-org switch into an unpaid org: takeover renders inside the app shell, sidebar is interactive, switching to a workspace in the paid org via `WorkspaceSwitcher` dismisses the takeover and lands in chat.
- Floating `LegacyMigrationDialog` is correctly suppressed when the takeover is showing ([_app.tsx:183, :228-241](src/routes/_app.tsx)), so the two surfaces don't race.
- `_onboarding.tsx`'s redirect-to-`/chat` condition correctly drops `billingAccessReady` so already-onboarded users hitting `/onboarding` directly get bounced back to `/chat`.
- `/api/billing/start-trial` parallels the welcome route's action with `/chat?checkout=success` as the return URL.
