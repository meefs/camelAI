# Billing Settings Redesign — Round 2 Feedback

Reviewed against the diff after the first round of fixes landed.

---

## 1. Layout max width — verify it's actually `max-w-[90rem]`

The user bumped the cap to 90rem themselves after my round-1 suggestion of `max-w-5xl`. Make sure [_app.settings.tsx](src/routes/_app.settings.tsx) renders `<div className="mx-auto w-full max-w-[90rem]">` (or the equivalent — `max-w-[90rem]` is the literal value the user wants). If the file currently still has `max-w-5xl` from the first pass, swap it.

No other action needed here unless that's wrong.

---

## 2. Billing — Free user can enter the picker but can't actually pick a plan

**Status: expected, but needs better FIXMEs.**

What's happening:

1. User on Free plan clicks "Choose a plan" → `<ManagePlanView>` renders.
2. `<ManagePlanView>` passes `disabledReason={stripeConfigured ? null : "Stripe billing is not configured."}` ([_app.settings.organization.billing.tsx:364-366](src/routes/_app.settings.organization.billing.tsx#L364-L366)).
3. Inside [PlanPicker](src/components/billing/plan-picker.tsx), `const isDisabled = Boolean(disabledReason)` and per-card `disabled = isDisabled && cta.kind === "trial"` ([plan-picker.tsx:115-116](src/components/billing/plan-picker.tsx#L115-L116)).
4. With `disabledReason` truthy, every "Start trial" button on the card grid is disabled ([plan-picker-card.tsx:122-128](src/components/billing/plan-picker-card.tsx#L122-L128)).
5. **Even if** the user clicked through, the `changePlan` action just `throw redirect(billingUrl)` with no Stripe-side work — there's a `// FIXME(billing-stripe)` at [_app.settings.organization.billing.tsx:124](src/routes/_app.settings.organization.billing.tsx#L124).

So the gray state is correct given the test environment doesn't have Stripe wired up. The next engineer needs three pieces of context that aren't yet captured in code:

### Action items to make the handoff clean

**A. Add a top-level FIXME block in [_app.settings.organization.billing.tsx](src/routes/_app.settings.organization.billing.tsx)**, right above the `action()` function, summarizing the Stripe-incomplete state for the next engineer:

```ts
// FIXME(billing-stripe): Plan upgrades, downgrades, and cancellations are not
// wired to Stripe yet. Today this route:
//   - Disables the per-card CTA in <PlanPicker> when stripeConfigured is false
//     (see ManagePlanView's `disabledReason`).
//   - Stubs `changePlan` and `cancelSubscription` to redirect-only (below).
//
// To complete the wiring, the next engineer needs to:
//   1. Implement createSubscriptionCheckoutSession() / upgradeSubscription() /
//      downgradeSubscription() helpers in src/lib/billing.server.ts and call
//      them from the `changePlan` case.
//   2. Implement cancelStripeSubscription() (cancel at period end) and call it
//      from the `cancelSubscription` case.
//   3. Once those helpers exist, remove the `disabledReason` argument from
//      <ManagePlanView>'s <PlanPicker> render so the card CTAs are enabled
//      whenever stripeConfigured is true (or remove the gate entirely if the
//      Stripe wiring is mandatory).
//   4. Verify webhook handling in `/api/billing/stripe/webhook` updates
//      org.billing_plan / billing_status correctly after each transition.
```

**B. Tighten the existing FIXMEs at [_app.settings.organization.billing.tsx:124](src/routes/_app.settings.organization.billing.tsx#L124) and [_app.settings.organization.billing.tsx:130](src/routes/_app.settings.organization.billing.tsx#L130)** with a one-line link back to the block above, so the next engineer can find the full context from any FIXME they grep:

```ts
case "changePlan": {
  // FIXME(billing-stripe): see top-of-file FIXME block. Currently a no-op
  // redirect — implement the actual Stripe subscription transition here.
  throw redirect(billingUrl.toString());
}
```

**C. Add a comment in [ManagePlanView](src/routes/_app.settings.organization.billing.tsx#L316)** explaining why `disabledReason` is currently set:

```ts
// FIXME(billing-stripe): `disabledReason` disables every paid-plan CTA when
// Stripe isn't configured locally. Once Stripe wiring is complete, either:
//   - keep this as-is (Stripe is required to upgrade), or
//   - drop the `disabledReason` prop entirely and rely on the action handler
//     to surface configuration errors via the fetcher's `data.error` channel.
disabledReason={
  stripeConfigured ? null : "Stripe billing is not configured."
}
```

**D. Optional — add a developer-mode bypass.** If the user wants to *visually* exercise the plan picker on a no-Stripe local env, gate the `disabledReason` on a debug env var (`env.BILLING_STRIPE_BYPASS === "1"` or similar). This is nice-to-have, not required.

No code changes to behavior in this round — just documentation tightening so the handoff is unambiguous.

---

## 3. AI Provider — Remove key dialog button is broken in both light and dark mode

**Status: real bug. Root cause found.**

### Symptom (per the screenshot the user attached)

In dark mode, the destructive "Remove key" action button has dark text on a red background — illegible. In light mode, the button isn't red at all — it's the default primary button (black background with white text).

### Root cause

[components/ui/alert-dialog.tsx:135-151](src/components/ui/alert-dialog.tsx#L135-L151) — `AlertDialogAction` is **already** wrapped in a `<Button asChild>`, and that wrapper accepts a `variant` prop:

```tsx
function AlertDialogAction({
  className,
  variant = "default",   // ← defaults to "default", not "destructive"
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Action
        ...
        className={cn(className)}   // ← whatever className you pass goes on the inner Action, not the Button
      />
    </Button>
  )
}
```

The current code in [remove-key-dialog.tsx:50-61](src/components/byok/remove-key-dialog.tsx#L50-L61) (and the identical bug in [cancel-plan-dialog.tsx:63-75](src/components/billing/cancel-plan-dialog.tsx#L63-L75)) does this:

```tsx
<AlertDialogAction
  ...
  className={buttonVariants({ variant: "destructive" })}
>
  Remove key
</AlertDialogAction>
```

Two problems compound:

1. **`variant` is never passed**, so the wrapper `<Button>` renders with `variant="default"` → applies `bg-primary text-primary-foreground`.
2. The `className={buttonVariants({ variant: "destructive" })}` string is passed *to the inner Radix Action* (which is then `Slot.Root`'d into the Button via `asChild`). With `asChild`, both class strings get merged onto the same final `<button>` element. Because Tailwind classes don't auto-resolve precedence by intent — they're just sorted by source order — you end up with **both** `bg-primary` and `bg-destructive/10` on the same element, **both** `text-primary-foreground` and `text-destructive` on the same element. The browser picks whichever the bundle output puts last.

That's exactly what the screenshot shows: clashing classes from two different variants smashed onto one button, and which one "wins" varies between light and dark mode because the `dark:` variants are in their own cascade order.

### Fix

Pass `variant="destructive"` directly on `AlertDialogAction` (the prop is already typed and forwarded to the wrapper Button) and **remove** the `className={buttonVariants(...)}` workaround.

**[components/byok/remove-key-dialog.tsx:50-61](src/components/byok/remove-key-dialog.tsx#L50-L61):**

```diff
- import { buttonVariants } from "@/components/ui/button";

  ...

  <AlertDialogAction
+   variant="destructive"
    onClick={(event) => {
      event.preventDefault();
      onConfirm();
    }}
    disabled={isRemoving}
-   className={buttonVariants({ variant: "destructive" })}
  >
    {isRemoving
      ? (removingLabel ?? "Removing…")
      : (confirmLabel ?? "Remove key")}
  </AlertDialogAction>
```

**[components/billing/cancel-plan-dialog.tsx:63-75](src/components/billing/cancel-plan-dialog.tsx#L63-L75)** — same fix, identical code:

```diff
- import { buttonVariants } from "@/components/ui/button";

  ...

  <AlertDialogAction
+   variant="destructive"
    onClick={(event) => {
      event.preventDefault();
      fetcher.submit(
        { intent: "cancelSubscription" },
        { method: "post" },
      );
    }}
    disabled={isCancelling}
-   className={buttonVariants({ variant: "destructive" })}
  >
    {isCancelling ? "Cancelling…" : "Cancel plan"}
  </AlertDialogAction>
```

After the fix:

- The wrapper `<Button>` renders with `variant="destructive"` → applies the project's destructive token classes from [components/ui/button.tsx:16](src/components/ui/button.tsx#L16) (`bg-destructive/10 hover:bg-destructive/20 text-destructive` etc.) — these are already correctly themed for both light and dark mode.
- The inner Action no longer carries a duplicate set of variant classes, so there's no class-collision.
- The button text uses `text-destructive`, which is a theme token that resolves to the right contrast color in both modes (it's a darker red in light mode, lighter red in dark mode — both legible against the `bg-destructive/10` background).

### Why my round-1 advice was wrong

I told the agent "use `buttonVariants({ variant: 'destructive' })` to get the right classes." That's correct *for a raw element that's not already inside a Button*, but `AlertDialogAction` is already a Button — passing `buttonVariants(...)` as `className` doubles up the variant. The right answer was always "use the `variant` prop the wrapper already exposes." Update the round-1 plan or feedback if it's referenced for similar dialogs in the future.

### Sanity check after the fix

1. Open the Remove key dialog in light mode → button reads as the project's standard destructive button (light red background, dark red text).
2. Toggle to dark mode → same dialog, button is dark-red-tinted background with light red text. Both legible.
3. Open the Cancel plan dialog (Billing page → active subscription → Cancellation section → Cancel) in both modes → same expected appearance.

If the cancel dialog isn't testable without an active subscription, manually flip the route's `hasActiveSubscription` short-circuit to true in dev to render it.

---

## Summary of changes needed

| File | Change |
|---|---|
| [src/routes/_app.settings.organization.billing.tsx](src/routes/_app.settings.organization.billing.tsx) | Add top-of-file FIXME block (item 2A); tighten existing case-level FIXMEs (item 2B); add inline FIXME on `ManagePlanView`'s `disabledReason` (item 2C) |
| [src/components/byok/remove-key-dialog.tsx](src/components/byok/remove-key-dialog.tsx) | Remove `buttonVariants` import; replace `className={buttonVariants(...)}` with `variant="destructive"` on `AlertDialogAction` |
| [src/components/billing/cancel-plan-dialog.tsx](src/components/billing/cancel-plan-dialog.tsx) | Same fix as above |
| [src/routes/_app.settings.tsx](src/routes/_app.settings.tsx) | Verify the layout cap is `max-w-[90rem]` and not the round-1 `max-w-5xl` |

No new tests required — these are visual/documentation fixes. After the dialog changes, eyeball both dialogs in light and dark mode and confirm the screenshots from the user no longer reproduce.
