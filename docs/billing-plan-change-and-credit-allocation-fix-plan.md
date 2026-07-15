# Billing Plan Changes and Included-Credit Allocation

**Status:** Implemented

**Product contract approved:** July 14, 2026

## Outcome

Billing has one financial authority and one deliberately small local projection:

- Stripe owns customers, subscriptions, prices, paid Team quantity, payment
  authentication, proration, invoices, and invoice status.
- camelAI stores the projected plan and paid seat quantity needed for fast
  authorization.
- camelAI owns organization membership and invitations.
- A local invoice ledger grants hosted-model credits exactly once per paid
  Stripe invoice.

An invitation is no longer a billing operation. Administrators buy Team
capacity first in a Stripe-hosted confirmation flow, then use that capacity for
members or pending invitations.

## Source-of-truth boundaries

| State | Authority | camelAI responsibility |
| --- | --- | --- |
| Customer, subscription, price, quantity | Stripe | Validate ownership and project webhook state |
| Payment, proration, 3DS, invoice status | Stripe | Never infer success before Stripe confirms it |
| Paid Team capacity | Stripe subscription item quantity | Store the webhook-projected quantity on the org |
| Members and pending invitations | OrgDO | Enforce projected capacity atomically |
| Included-credit grants | OrgDO invoice ledger | Resolve paid invoices and apply each grant once |

The local billing fields are a projection, not a second billing system. A short
webhook delay is handled conservatively: invitations remain blocked until the
new paid quantity is visible locally.

## Plan-change flow

~~~
select paid plan or Team quantity
        |
        v
server reloads org + Stripe subscription
        |
        +-- validates customer ownership
        +-- validates the canonical price catalog
        +-- computes exact target price and quantity
        +-- classifies upgrade vs downgrade by monthly total
        |
        v
Stripe Billing Portal subscription_update_confirm
        |
        +-- Stripe shows proration
        +-- Stripe handles payment failure and authentication
        +-- Stripe commits the subscription change
        |
        v
webhook projects plan and quantity into OrgDO
~~~

Active subscriptions use the exact Stripe-hosted confirmation flow. A
genuinely trialing plan change uses the existing direct no-proration update
path. Subscriptions that are past due, unpaid, incomplete,
paused, canceling, or otherwise not updateable go to Stripe management instead.

The browser never submits a trusted price ID or arbitrary quantity. The server
selects configured prices and normalizes Team quantities to the plan minimum
and current occupied capacity.

## Team capacity flow

~~~
invite dialog
    |
    +-- requested invites fit paid capacity
    |       -> create invitations locally
    |
    +-- capacity is insufficient
            -> disable invitation submit
            -> "Buy seats in Stripe"
            -> exact hosted quantity confirmation
            -> webhook projects new quantity
            -> administrator returns and sends invitations
~~~

OrgDO counts current members plus unexpired invitations. It performs the final
capacity check before inserting invitations. A route-level preview improves
the UI, but the OrgDO check is authoritative for concurrent admins.

Removing a member or deleting an invitation does not automatically reduce the
Stripe quantity. The purchased capacity remains available for another person.
A future product can offer an explicit quantity-reduction action through the
same Stripe-hosted flow; membership mutations must not silently change the
bill.

Accepting an invitation replaces one reserved invitation with one member and
does not change paid capacity.

## Portal configuration

camelAI maintains one stable Stripe Billing Portal configuration for each mode:

- management: payment method, invoice history, and cancellation;
- upgrade: exact target with immediate proration/invoicing;
- downgrade: exact target without an immediate credit or refund.

The configuration ID and desired-state fingerprint are stored in APP_KV. A
catalog or behavior change updates that same configuration instead of creating
an unbounded series of immutable configurations. All paid products and prices
come from the validated runtime catalog.

## Paid invoice and credit flow

Both `invoice.paid` and the compatibility
`invoice.payment_succeeded` event trigger canonical retrieval from Stripe.
The resolver loads the invoice, all invoice lines, and the live subscription.
It supports both legacy and Dahlia response shapes.

Eligible sources are:

- initial subscription invoice;
- full renewal invoice;
- positive paid plan-change proration;
- paid legacy migration.

The command is committed in an OrgDO transaction that inserts an immutable
invoice-ledger row and updates the credit total together. Replayed aliases,
duplicate delivery, retries, and out-of-order events therefore cannot grant
twice. Failed, open, void, and uncollectible invoices grant nothing.

Credit computation remains based on the configured allowance rather than
blindly trusting an event amount. Positive update grants use the recognized net
plan-allowance delta represented by paid proration lines. Downgrades do not
claw back credits already granted.

## Complexity deliberately removed

This implementation removes:

- invitation-triggered Stripe writes;
- Team seat leases, reservations, fencing revisions, and stabilization loops;
- automatic Stripe decreases after member or invitation removal;
- browser-posted billing disclosure fields;
- the broad admin invoice-reconciliation endpoint and CLI from this feature;
- duplicate in-app confirmation before Stripe's own confirmation;
- per-fingerprint Portal configuration proliferation.

The invoice ledger, canonical Stripe retrieval, webhook compatibility, customer
ownership checks, and current API-version work remain because they enforce real
financial invariants.

## Operational invariants

1. No member or active invitation exists beyond the locally projected paid
   capacity, except enterprise organizations whose seat limit is unlimited.
2. No route treats a Stripe session URL as a completed subscription change.
3. No hosted credit is granted until an eligible invoice is paid.
4. One Stripe invoice ID maps to at most one immutable ledger command.
5. The webhook may repair the local projection, but local membership never
   writes Stripe.
6. Billing failures are visible and retryable; they do not fall back to
   creating an unpaid invitation.

## Verification

Focused coverage includes:

- exact Stripe Portal session price and quantity fields;
- stable Portal configuration creation and update;
- paid-capacity invitation success and rejection;
- separate Team capacity purchase action;
- atomic OrgDO seat enforcement;
- invitation acceptance without Stripe mutation;
- initial, renewal, plan-change, legacy migration, duplicate, and
  version-compatible invoice processing;
- webhook signature/version compatibility and idempotent credit grants.

The credentialed Stripe integration suite additionally verifies that Stripe
accepts the real exact-target Portal flow.
