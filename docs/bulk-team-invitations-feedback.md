# Bulk Team Invitations Review Feedback

## Findings

1. **High - Successful invites can leave the modal open and the CTA disabled when email delivery fails**

   In [invite-member-dialog.tsx](/Users/illiana/Projects/chiridion-app/src/components/settings/invite-member-dialog.tsx:157), a successful action response with any `failed` email deliveries shows a warning, calls `setFailedEmails(...)`, and returns before `onOpenChange(false)`. Those failed emails are then reclassified by [email-chip-input.tsx](/Users/illiana/Projects/chiridion-app/src/components/settings/email-chip-input.tsx:98) as `failed`, and only `valid` chips are emitted as hidden `emails` fields at [email-chip-input.tsx](/Users/illiana/Projects/chiridion-app/src/components/settings/email-chip-input.tsx:275). That makes `requestedInviteCount` drop to zero, so the submit button disables at [invite-member-dialog.tsx](/Users/illiana/Projects/chiridion-app/src/components/settings/invite-member-dialog.tsx:137).

   This matches the observed behavior: the invitations are created, the loading state ends, the modal remains open, and the CTA is disabled.

   Recommended fix: treat `success: true` as completion once invitations are created, even if email delivery was not fully successful. Show a warning toast such as “Created 2 invitations, but 2 emails could not be delivered. You can copy invite links from the team table.” Then clear transient state and close the modal. If we intentionally want the modal to stay open for retry, it needs an explicit retry/share flow and the CTA must not become disabled because chips changed to a non-submittable `failed` state.

2. **High - Billing copy and Stripe behavior still say/use next-invoice proration, not immediate prorated invoicing**

   The alert text in [invite-member-dialog.tsx](/Users/illiana/Projects/chiridion-app/src/components/settings/invite-member-dialog.tsx:263) says: `Will appear on your next invoice.` The bulk invite action also calls `syncTeamSubscriptionSeatCount()` with `prorationBehavior: 'create_prorations'` at [src/routes/_app.settings.organization.team.tsx](/Users/illiana/Projects/chiridion-app/src/routes/_app.settings.organization.team.tsx:213), which creates prorations for a later invoice rather than immediately invoicing them.

   This conflicts with the desired behavior: issue a prorated invoice now, then charge the added `$50/month per seat` on following invoices.

   Recommended fix: for paid seat expansion from the invite flow, pass `prorationBehavior: 'always_invoice'` and update the billing test currently expecting `create_prorations` in [tests/billing.test.ts](/Users/illiana/Projects/chiridion-app/tests/billing.test.ts:1575). Update the alert copy to a complete sentence, for example:

   > This adds 2 Team seats at $100.00 per month. We will bill a prorated amount now for the rest of your current billing period, and the full monthly seat amount will be included on future invoices. Your covered seats will increase from 3 to 5.

   Do not calculate the prorated amount in the modal unless we add a Stripe upcoming-invoice preview.

3. **Medium - Tests miss the reported success-with-email-failure path**

   [tests/invite-member-dialog.test.tsx](/Users/illiana/Projects/chiridion-app/tests/invite-member-dialog.test.tsx:5) mocks `useFetcher()` with static `data: undefined`, so the response-handling paths are not covered. The current tests pass even though the reported stuck-modal case is present in the code.

   Recommended fix: add a test where `fetcher.state === "idle"` and `fetcher.data` is `{ success: true, invited: [...], failed: [...] }`. Assert that the modal close callback runs, or, if we intentionally keep it open, assert that a clear retry/share affordance exists and the CTA is not stuck disabled. Also add a test for fully successful bulk invites closing and clearing the input state.

## Additional findings (added by second reviewer)

4. **High - flushSync race makes the disclosed-billing hidden fields stale, producing a spurious "Billing changed while you were typing" rejection**

   In [invite-member-dialog.tsx:196-200](/Users/illiana/Projects/chiridion-app/src/components/settings/invite-member-dialog.tsx#L196-L200), `handleSubmit` runs `flushSync(() => emailInputRef.current?.commitPending())`. That flushes `EmailChipInput`'s internal `chips` state synchronously, so the inner `<input type="hidden" name="emails">` rows include the just-committed email when the form posts. But the parent's `requestedInviteCount` / `liveBilling` / `disclosed_*` hidden fields update only after `EmailChipInput`'s `useEffect` calls `onChipsChange(chips)` at [email-chip-input.tsx:121-123](/Users/illiana/Projects/chiridion-app/src/components/settings/email-chip-input.tsx#L121-L123). Effects fire after commit, after the form has already serialized.

   **Concrete repro**: user has 2 valid chips, types `carl@acme.com` without pressing Enter or comma, clicks "Send 2 invites". `flushSync` adds a third chip → form posts with `emails=[a, b, c]` but `disclosed_added_seat_count` for 2 seats. Server computes 3 added seats, `3 > 2` triggers `stale_billing_context`, modal switches to State D ("Billing changed while you were typing") even though billing didn't actually change. User has to click Send again.

   Recommended fix: stop relying on `onChipsChange` propagation for the disclosed values. Either (a) have `EmailChipInput` render its own `disclosed_emails_count` hidden input that `flushSync` will update in the same flush, then derive `disclosed_added_seat_count` server-side from `emails.length`, or (b) expose `getCommittedChips()` on the imperative handle and have `handleSubmit` write the disclosed hidden inputs into a `useRef`-backed mirror just before the form submits. Option (a) is simpler and removes a class of similar bugs.

5. **Medium - Skipped/failed reasons are surfaced as raw enum strings in the toast**

   At [invite-member-dialog.tsx:166-167](/Users/illiana/Projects/chiridion-app/src/components/settings/invite-member-dialog.tsx#L166-L167) the description is built as `skipped.map((item) => \`${item.email}: ${item.reason}\`).join("\n")`, where `item.reason` is `"already_member" | "already_invited" | "duplicate"` from [_app.settings.organization.team.tsx:122-138](/Users/illiana/Projects/chiridion-app/src/routes/_app.settings.organization.team.tsx#L122-L138). For failed emails the reason can be `"email_delivery_failed"` or whatever `emailDelivery.reason` returns at [_app.settings.organization.team.tsx:282-285](/Users/illiana/Projects/chiridion-app/src/routes/_app.settings.organization.team.tsx#L282-L285), again surfaced raw at [invite-member-dialog.tsx:159](/Users/illiana/Projects/chiridion-app/src/components/settings/invite-member-dialog.tsx#L159).

   Recommended fix: add a small `inviteReasonCopy.ts` map (`already_member` → "already a member", `already_invited` → "invitation already sent", `duplicate` → "listed twice", `email_delivery_failed` → "couldn't deliver email") and use it in both the modal toasts and the announcer. Keep the enum strings on the server; only translate at the UI boundary.

6. **Medium - Concrete copy proposal for finding #2 (alert text)**

   To implement Codex's recommendation, here is suggested complete-sentence copy that does not estimate the prorated amount and matches the desired Stripe behavior. The "Adding seats" alert at [invite-member-dialog.tsx:256-267](/Users/illiana/Projects/chiridion-app/src/components/settings/invite-member-dialog.tsx#L256-L267) should become:

   > **Adding {addedSeatCount} {seat/seats} to your Team plan**
   > Your Team subscription will go from {coveredSeatCount} to {nextSeatCount} seats. We'll bill a prorated amount for the rest of your current billing period today, and your future monthly invoices will increase by {formatUsdFromCents(addedMonthlyAmountCents)}.

   The "No billing change" alert at [invite-member-dialog.tsx:246-254](/Users/illiana/Projects/chiridion-app/src/components/settings/invite-member-dialog.tsx#L246-L254) should mention the minimum so the admin understands why no charge applies:

   > **No billing change**
   > Your Team plan already covers these invitations under the {minimumSeats}-seat minimum. You'll only be charged when invitations exceed the seats you've already paid for.

   The stale-billing alert ("Billing changed while you were typing") should also be a complete sentence and should not be reachable from the no-actual-change scenario in finding #4. Once finding #4 is fixed, the only real path here is a true cross-tab race; suggested copy:

   > **Billing changed since you opened this**
   > Another admin made a change in the meantime. Sending these invitations would now add {addedSeatCount} {seat/seats} for {formatUsdFromCents(addedMonthlyAmountCents)} more per month. Review the updated total above, then resend.

7. **Low - The Tooltip on every chip is redundant when the email already fits**

   `EmailChipInput` wraps every chip in a `Tooltip` showing the full email at [email-chip-input.tsx:279-311](/Users/illiana/Projects/chiridion-app/src/components/settings/email-chip-input.tsx#L279-L311), even when the chip isn't truncated (max-width 180px). For most short addresses, the hover popup duplicates the visible text and adds noise. Consider conditionally rendering the Tooltip only when the chip's text actually overflows (e.g., compare `scrollWidth` to `clientWidth` on the inner span, or just gate on `chip.email.length > 24`). Not blocking.

8. **Low - `failedEmails` chips have no clear retry path**

   Once a chip transitions to `state: "failed"`, the hidden input for it isn't submitted (correct), but there's no UX affordance telling the admin what to do next. Combined with finding #1, this leaves the modal in a confusing state. Two reasonable resolutions:

   - **Tie to finding #1's fix**: close the modal on `success: true` regardless of email failures and surface a follow-up toast pointing to the team table where invitation links can be copied. This matches the user's reported expectation.
   - **If we keep the modal open for retry**: render an inline "Copy invite link" button on each failed chip and remove the chip's `failed` state when the user manually deletes it, so the user has a clear next step.

   Prefer the first option unless retry-in-place is a real product requirement.

## Notes

- The shared parser, server-side revalidation, dedupe, stale billing guard, and pre-create Stripe sync are directionally solid.
- Findings #4 (flushSync race) and #1 (modal-not-closing on partial email failure) compound: a user with uncommitted text who hits Send may see the spurious stale-billing alert, retry, and then land on a stuck-disabled modal if any email delivery fails. Both should ship together.
- The focused tests pass:

```bash
bun run test:run tests/invite-emails.test.ts tests/billing-plans.test.ts tests/invite-member-dialog.test.tsx tests/team-settings-bulk-invitations-route.test.ts tests/billing.test.ts
```

Result: 58 tests passed.

Suggested test additions for the new findings:

- **Finding #4**: in `tests/invite-member-dialog.test.tsx`, simulate typing a valid email without committing, then clicking Send. Assert that the form's submitted `disclosed_added_seat_count` matches the post-commit chip count, not the pre-commit count.
- **Finding #5**: snapshot the toast description string when `skipped` includes each reason value to catch raw enum leakage.
- **Finding #6**: assert the new copy verbatim in the dialog test so Stripe behavior and visible copy stay in sync.
