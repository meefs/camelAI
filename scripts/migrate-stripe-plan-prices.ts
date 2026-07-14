import {
  BILLING_PLAN_LIMITS,
  getIncludedCreditCentsForPlan,
  normalizeSeatCount,
} from "../src/lib/billing-plans";

const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";
const LEGACY_MONTHLY_PRICE_CENTS = {
  starter: 4000,
  pro: 15000,
} as const;
// Terminal statuses only. "incomplete" is deliberately NOT here: Stripe can
// activate an incomplete subscription within ~23h of creation, so it must be
// flagged for manual review and revisited, never silently skipped.
const SKIPPED_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "incomplete_expired",
]);

type StripeMode = "test" | "live";
type MigratedPlan = keyof typeof LEGACY_MONTHLY_PRICE_CENTS;
type MigrationPlan = MigratedPlan | "team";

interface PricePair {
  oldPriceId: string;
  newPriceId: string;
}

interface Options {
  mode: StripeMode;
  execute: boolean;
  pageSize: number;
  starter?: PricePair;
  pro?: PricePair;
  teamRestampPriceId?: string;
}

interface StripePrice {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  product?: string | { id: string } | null;
  recurring?: {
    interval?: string | null;
    interval_count?: number | null;
    usage_type?: string | null;
  } | null;
}

interface StripeSubscriptionItem {
  id: string;
  quantity?: number | null;
  price?: string | StripePrice | null;
}

interface StripeSubscription {
  id: string;
  status: string;
  metadata?: Record<string, string>;
  schedule?: string | { id: string } | null;
  items?: {
    data?: StripeSubscriptionItem[];
  } | null;
}

interface StripeList<T> {
  data: T[];
  has_more: boolean;
}

interface PassSummary {
  label: string;
  total: number;
  updated: number;
  dryRun: number;
  skipped: number;
  manualReview: number;
}

function usage(): string {
  return [
    "Usage:",
    "  STRIPE_SECRET_KEY=... bun scripts/migrate-stripe-plan-prices.ts \\",
    "    --mode <test|live> \\",
    "    [--starter-old <id> --starter-new <id>] \\",
    "    [--pro-old <id> --pro-new <id>] \\",
    "    [--team-restamp <id>] [--execute] [--page-size <1-100>]",
  ].join("\n");
}

function readOptionValue(argv: string[], index: number, name: string) {
  const arg = argv[index];
  const equalsPrefix = `${name}=`;
  if (arg?.startsWith(equalsPrefix)) {
    const value = arg.slice(equalsPrefix.length).trim();
    if (!value) throw new Error(`${name} requires a value.`);
    return { value, nextIndex: index };
  }

  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return { value, nextIndex: index + 1 };
}

function parseArgs(argv: string[]): Options {
  let mode: StripeMode | undefined;
  let execute = false;
  let pageSize = 100;
  let starterOld: string | undefined;
  let starterNew: string | undefined;
  let proOld: string | undefined;
  let proNew: string | undefined;
  let teamRestampPriceId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }

    const optionName = arg?.split("=", 1)[0];
    switch (optionName) {
      case "--mode": {
        const parsed = readOptionValue(argv, index, "--mode");
        if (parsed.value !== "test" && parsed.value !== "live") {
          throw new Error("--mode must be either test or live.");
        }
        mode = parsed.value;
        index = parsed.nextIndex;
        break;
      }
      case "--starter-old": {
        const parsed = readOptionValue(argv, index, "--starter-old");
        starterOld = parsed.value;
        index = parsed.nextIndex;
        break;
      }
      case "--starter-new": {
        const parsed = readOptionValue(argv, index, "--starter-new");
        starterNew = parsed.value;
        index = parsed.nextIndex;
        break;
      }
      case "--pro-old": {
        const parsed = readOptionValue(argv, index, "--pro-old");
        proOld = parsed.value;
        index = parsed.nextIndex;
        break;
      }
      case "--pro-new": {
        const parsed = readOptionValue(argv, index, "--pro-new");
        proNew = parsed.value;
        index = parsed.nextIndex;
        break;
      }
      case "--team-restamp": {
        const parsed = readOptionValue(argv, index, "--team-restamp");
        teamRestampPriceId = parsed.value;
        index = parsed.nextIndex;
        break;
      }
      case "--page-size": {
        const parsed = readOptionValue(argv, index, "--page-size");
        pageSize = Number(parsed.value);
        index = parsed.nextIndex;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg ?? ""}`);
    }
  }

  if (!mode) throw new Error("--mode is required.");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("--page-size must be an integer from 1 to 100.");
  }
  if (Boolean(starterOld) !== Boolean(starterNew)) {
    throw new Error(
      "--starter-old and --starter-new must be provided together.",
    );
  }
  if (Boolean(proOld) !== Boolean(proNew)) {
    throw new Error("--pro-old and --pro-new must be provided together.");
  }
  if (!starterOld && !proOld && !teamRestampPriceId) {
    throw new Error("Provide at least one price pair or --team-restamp.");
  }
  if (starterOld === starterNew && starterOld) {
    throw new Error("Starter old and new price IDs must differ.");
  }
  if (proOld === proNew && proOld) {
    throw new Error("Pro old and new price IDs must differ.");
  }

  return {
    mode,
    execute,
    pageSize,
    starter:
      starterOld && starterNew
        ? { oldPriceId: starterOld, newPriceId: starterNew }
        : undefined,
    pro:
      proOld && proNew ? { oldPriceId: proOld, newPriceId: proNew } : undefined,
    teamRestampPriceId,
  };
}

function assertSecretKeyMatchesMode(secretKey: string, mode: StripeMode): void {
  const allowedPrefixes =
    mode === "test" ? ["sk_test_", "rk_test_"] : ["sk_live_", "rk_live_"];
  if (!allowedPrefixes.some((prefix) => secretKey.startsWith(prefix))) {
    throw new Error(`STRIPE_SECRET_KEY does not match --mode ${mode}.`);
  }
}

function retryAfterMilliseconds(value: string | null): number {
  if (!value) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createStripeClient(secretKey: string) {
  return async function stripeRequest<T>(
    path: string,
    init: { method?: "GET" | "POST"; body?: URLSearchParams } = {},
  ): Promise<T> {
    const method = init.method ?? "GET";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${STRIPE_API_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          ...(init.body
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
        body: init.body?.toString(),
      });

      if (response.status === 429 && attempt === 0) {
        const delayMs = retryAfterMilliseconds(
          response.headers.get("Retry-After"),
        );
        console.warn(
          `Stripe rate limit received; retrying once after ${delayMs}ms.`,
        );
        await sleep(delayMs);
        continue;
      }
      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(
          `Stripe ${method} ${path} failed (${response.status}): ${responseText}`,
        );
      }
      return (await response.json()) as T;
    }

    throw new Error(`Stripe ${method} ${path} exhausted its retry.`);
  };
}

function getPriceId(price: StripeSubscriptionItem["price"]): string | null {
  return typeof price === "string" ? price : (price?.id ?? null);
}

function getProductId(product: StripePrice["product"]): string | null {
  return typeof product === "string" ? product : (product?.id ?? null);
}

async function assertConfiguredPrice(
  stripeRequest: ReturnType<typeof createStripeClient>,
  plan: MigrationPlan,
  priceId: string,
): Promise<StripePrice> {
  const price = await stripeRequest<StripePrice>(
    `/prices/${encodeURIComponent(priceId)}`,
  );
  const expectedAmount = BILLING_PLAN_LIMITS[plan].monthlyPriceCents;
  const failures = [
    price.active === true ? null : "price is not active",
    price.currency?.toLowerCase() === "usd" ? null : "currency is not usd",
    price.recurring?.interval === "month"
      ? null
      : "price is not monthly recurring",
    price.recurring?.interval_count === 1
      ? null
      : `interval count is ${price.recurring?.interval_count ?? "null"}, expected 1`,
    price.recurring?.usage_type === "licensed"
      ? null
      : `usage type is ${price.recurring?.usage_type ?? "null"}, expected licensed`,
    price.unit_amount === expectedAmount
      ? null
      : `unit amount is ${price.unit_amount ?? "null"}, expected ${expectedAmount}`,
  ].filter(Boolean);

  if (failures.length > 0) {
    throw new Error(
      `Preflight failed for ${plan} price ${priceId}: ${failures.join("; ")}.`,
    );
  }
  return price;
}

async function preflightMigrationPair(
  stripeRequest: ReturnType<typeof createStripeClient>,
  plan: MigratedPlan,
  pair: PricePair,
): Promise<void> {
  const newPrice = await assertConfiguredPrice(
    stripeRequest,
    plan,
    pair.newPriceId,
  );
  const oldPrice = await stripeRequest<StripePrice>(
    `/prices/${encodeURIComponent(pair.oldPriceId)}`,
  );
  const legacyAmount = LEGACY_MONTHLY_PRICE_CENTS[plan];
  if (oldPrice.unit_amount !== legacyAmount) {
    console.warn(
      `Warning: ${plan} old price ${pair.oldPriceId} has unit amount ${oldPrice.unit_amount ?? "null"}; expected legacy amount ${legacyAmount}.`,
    );
  }
  const oldProductId = getProductId(oldPrice.product);
  const newProductId = getProductId(newPrice.product);
  if (!oldProductId || !newProductId || oldProductId !== newProductId) {
    throw new Error(
      `Preflight failed for ${plan}: new price ${pair.newPriceId} is on product ${newProductId ?? "unknown"} but old price ${pair.oldPriceId} is on ${oldProductId ?? "unknown"}. Product-scoped coupons and portal configuration can silently stop applying across products; create the new price on the same product.`,
    );
  }
}

async function* listSubscriptions(
  stripeRequest: ReturnType<typeof createStripeClient>,
  priceId: string,
  pageSize: number,
): AsyncGenerator<StripeSubscription> {
  let startingAfter: string | undefined;

  for (;;) {
    const query = new URLSearchParams({
      price: priceId,
      status: "all",
      limit: String(pageSize),
    });
    if (startingAfter) query.set("starting_after", startingAfter);

    const page = await stripeRequest<StripeList<StripeSubscription>>(
      `/subscriptions?${query.toString()}`,
    );
    for (const subscription of page.data) yield subscription;
    if (!page.has_more) return;

    const lastSubscription = page.data.at(-1);
    if (!lastSubscription) {
      throw new Error("Stripe returned has_more=true with an empty page.");
    }
    startingAfter = lastSubscription.id;
  }
}

function newPassSummary(label: string): PassSummary {
  return {
    label,
    total: 0,
    updated: 0,
    dryRun: 0,
    skipped: 0,
    manualReview: 0,
  };
}

function logSubscription(args: {
  subscription: StripeSubscription;
  oldPriceId: string;
  newPriceId: string;
  quantity?: number;
  oldCredits?: string;
  newCredits?: number;
  action: string;
}): void {
  console.log(
    [
      args.subscription.id,
      `org=${args.subscription.metadata?.org_id || "-"}`,
      `status=${args.subscription.status}`,
      `price=${args.oldPriceId}->${args.newPriceId}`,
      `quantity=${args.quantity ?? "-"}`,
      `credits=${args.oldCredits ?? "-"}->${args.newCredits ?? "-"}`,
      `action=${args.action}`,
    ].join(" "),
  );
}

function getSingleMatchingItem(
  subscription: StripeSubscription,
  priceId: string,
): StripeSubscriptionItem | null {
  const matchingItems = (subscription.items?.data ?? []).filter(
    (item) => getPriceId(item.price) === priceId,
  );
  return matchingItems.length === 1 ? matchingItems[0] : null;
}

function isValidQuantity(
  quantity: number | null | undefined,
): quantity is number {
  return Number.isInteger(quantity) && (quantity ?? 0) > 0;
}

async function migratePlan(args: {
  stripeRequest: ReturnType<typeof createStripeClient>;
  plan: MigratedPlan;
  pair: PricePair;
  options: Options;
}): Promise<PassSummary> {
  const { stripeRequest, plan, pair, options } = args;
  const summary = newPassSummary(plan);

  for await (const subscription of listSubscriptions(
    stripeRequest,
    pair.oldPriceId,
    options.pageSize,
  )) {
    summary.total += 1;
    if (SKIPPED_SUBSCRIPTION_STATUSES.has(subscription.status)) {
      summary.skipped += 1;
      logSubscription({
        subscription,
        oldPriceId: pair.oldPriceId,
        newPriceId: pair.newPriceId,
        action: `skipped:status-${subscription.status}`,
      });
      continue;
    }
    if (subscription.status === "incomplete") {
      summary.manualReview += 1;
      logSubscription({
        subscription,
        oldPriceId: pair.oldPriceId,
        newPriceId: pair.newPriceId,
        action: "skipped:manual-review-incomplete-may-activate",
      });
      continue;
    }
    if (subscription.schedule) {
      summary.manualReview += 1;
      logSubscription({
        subscription,
        oldPriceId: pair.oldPriceId,
        newPriceId: pair.newPriceId,
        action: "skipped:manual-review-schedule",
      });
      continue;
    }

    const matchingItem = getSingleMatchingItem(subscription, pair.oldPriceId);
    if (!matchingItem) {
      summary.manualReview += 1;
      logSubscription({
        subscription,
        oldPriceId: pair.oldPriceId,
        newPriceId: pair.newPriceId,
        action: "skipped:manual-review-item-count",
      });
      continue;
    }
    if (!isValidQuantity(matchingItem.quantity)) {
      summary.manualReview += 1;
      logSubscription({
        subscription,
        oldPriceId: pair.oldPriceId,
        newPriceId: pair.newPriceId,
        action: "skipped:manual-review-quantity",
      });
      continue;
    }

    const seats = normalizeSeatCount(plan, matchingItem.quantity);
    const includedCreditCents = getIncludedCreditCentsForPlan(plan, seats);
    const oldCredits =
      subscription.metadata?.subscription_included_credit_cents || "-";
    const action = options.execute ? "updated" : "dry-run";

    if (options.execute) {
      await stripeRequest<StripeSubscription>(
        `/subscriptions/${encodeURIComponent(subscription.id)}`,
        {
          method: "POST",
          body: new URLSearchParams({
            "items[0][id]": matchingItem.id,
            "items[0][price]": pair.newPriceId,
            "items[0][quantity]": String(matchingItem.quantity),
            proration_behavior: "none",
            "metadata[billing_plan]": plan,
            "metadata[seat_count]": String(seats),
            "metadata[subscription_included_credit_cents]":
              String(includedCreditCents),
          }),
        },
      );
      summary.updated += 1;
    } else {
      summary.dryRun += 1;
    }

    logSubscription({
      subscription,
      oldPriceId: pair.oldPriceId,
      newPriceId: pair.newPriceId,
      quantity: matchingItem.quantity,
      oldCredits,
      newCredits: includedCreditCents,
      action,
    });
  }

  return summary;
}

async function restampTeam(args: {
  stripeRequest: ReturnType<typeof createStripeClient>;
  priceId: string;
  options: Options;
}): Promise<PassSummary> {
  const { stripeRequest, priceId, options } = args;
  const summary = newPassSummary("team-restamp");

  for await (const subscription of listSubscriptions(
    stripeRequest,
    priceId,
    options.pageSize,
  )) {
    summary.total += 1;
    if (SKIPPED_SUBSCRIPTION_STATUSES.has(subscription.status)) {
      summary.skipped += 1;
      logSubscription({
        subscription,
        oldPriceId: priceId,
        newPriceId: priceId,
        action: `skipped:status-${subscription.status}`,
      });
      continue;
    }
    if (subscription.status === "incomplete") {
      summary.manualReview += 1;
      logSubscription({
        subscription,
        oldPriceId: priceId,
        newPriceId: priceId,
        action: "skipped:manual-review-incomplete-may-activate",
      });
      continue;
    }
    if (subscription.schedule) {
      summary.manualReview += 1;
      logSubscription({
        subscription,
        oldPriceId: priceId,
        newPriceId: priceId,
        action: "skipped:manual-review-schedule",
      });
      continue;
    }

    const matchingItem = getSingleMatchingItem(subscription, priceId);
    if (!matchingItem) {
      summary.manualReview += 1;
      logSubscription({
        subscription,
        oldPriceId: priceId,
        newPriceId: priceId,
        action: "skipped:manual-review-item-count",
      });
      continue;
    }
    if (!isValidQuantity(matchingItem.quantity)) {
      summary.manualReview += 1;
      logSubscription({
        subscription,
        oldPriceId: priceId,
        newPriceId: priceId,
        action: "skipped:manual-review-quantity",
      });
      continue;
    }

    const seats = normalizeSeatCount("team", matchingItem.quantity);
    const includedCreditCents = getIncludedCreditCentsForPlan("team", seats);
    const oldCredits =
      subscription.metadata?.subscription_included_credit_cents || "-";
    if (oldCredits === String(includedCreditCents)) {
      summary.skipped += 1;
      logSubscription({
        subscription,
        oldPriceId: priceId,
        newPriceId: priceId,
        quantity: matchingItem.quantity,
        oldCredits,
        newCredits: includedCreditCents,
        action: "skipped:metadata-current",
      });
      continue;
    }

    const action = options.execute ? "updated" : "dry-run";
    if (options.execute) {
      await stripeRequest<StripeSubscription>(
        `/subscriptions/${encodeURIComponent(subscription.id)}`,
        {
          method: "POST",
          body: new URLSearchParams({
            "metadata[billing_plan]": "team",
            "metadata[seat_count]": String(seats),
            "metadata[subscription_included_credit_cents]":
              String(includedCreditCents),
          }),
        },
      );
      summary.updated += 1;
    } else {
      summary.dryRun += 1;
    }

    logSubscription({
      subscription,
      oldPriceId: priceId,
      newPriceId: priceId,
      quantity: matchingItem.quantity,
      oldCredits,
      newCredits: includedCreditCents,
      action,
    });
  }

  return summary;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is required.");
  assertSecretKeyMatchesMode(secretKey, options.mode);

  const stripeRequest = createStripeClient(secretKey);
  if (options.starter) {
    await preflightMigrationPair(stripeRequest, "starter", options.starter);
  }
  if (options.pro) {
    await preflightMigrationPair(stripeRequest, "pro", options.pro);
  }
  if (options.teamRestampPriceId) {
    await assertConfiguredPrice(
      stripeRequest,
      "team",
      options.teamRestampPriceId,
    );
  }

  console.log(options.execute ? "Mode: execute" : "Mode: dry-run");
  const summaries: PassSummary[] = [];
  if (options.starter) {
    summaries.push(
      await migratePlan({
        stripeRequest,
        plan: "starter",
        pair: options.starter,
        options,
      }),
    );
  }
  if (options.pro) {
    summaries.push(
      await migratePlan({
        stripeRequest,
        plan: "pro",
        pair: options.pro,
        options,
      }),
    );
  }
  if (options.teamRestampPriceId) {
    summaries.push(
      await restampTeam({
        stripeRequest,
        priceId: options.teamRestampPriceId,
        options,
      }),
    );
  }

  console.log("Summary:");
  for (const summary of summaries) {
    const actionable = summary.updated + summary.dryRun + summary.manualReview;
    console.log(
      `${summary.label} total=${summary.total} actionable=${actionable} updated=${summary.updated} dry-run=${summary.dryRun} skipped=${summary.skipped} manual-review=${summary.manualReview}`,
    );
  }
  if (summaries.some((summary) => summary.manualReview > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 1;
});
