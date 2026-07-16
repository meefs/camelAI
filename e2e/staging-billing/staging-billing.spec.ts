import { expect, test } from "@playwright/test";
import { StagingAdminClient } from "./admin-js-exec-client";
import { readFixtureState } from "./fixture-state";
import {
  attachSnapshot,
  checkpoint,
  completeStripeCheckout,
  login,
  planCard,
  selectThreadModel,
  sendChatAndWait,
  snapshotAvailableCredits,
  snapshotPlan,
  snapshotPurchasedCredits,
  waitForChat,
} from "./browser-helpers";

test.describe.configure({ mode: "serial" });

const admin = new StagingAdminClient();
const premiumModel = process.env.STAGING_E2E_PREMIUM_MODEL || "Gemini 3 Flash Preview";

test.describe("manual staging onboarding and billing", () => {
  test("fresh free onboarding chats, then an open premium chat falls back to Camel Free", async ({ page }, testInfo) => {
    const { primary } = await readFixtureState();
    await login(page, primary);
    await waitForChat(page);

    const modelPicker = page.getByRole("button", { name: "Thread model" });
    await expect(modelPicker).toHaveText("Camel Free");
    await sendChatAndWait(page, "Reply with exactly: free onboarding chat works");
    await checkpoint(page, testInfo, "01-free-onboarding-chat");
    await attachSnapshot(testInfo, "01-free-billing-snapshot", await admin.snapshot(primary.orgId));

    await admin.setAvailableCredits(primary.orgId, 5_000);
    await selectThreadModel(page, premiumModel);
    await sendChatAndWait(page, "Reply briefly that the premium model chat works.");
    await checkpoint(page, testInfo, "02-premium-chat-before-credit-drain");

    // The page and websocket remain open while the remote console changes the
    // org balance. The next turn exercises the server's live fallback path.
    const drained = await admin.setAvailableCredits(primary.orgId, 0);
    await attachSnapshot(testInfo, "02-credit-drain", drained);
    const fallbackTurn = sendChatAndWait(page, "Reply with exactly: fallback chat works");
    await expect(page.getByText("Switched to Camel Free", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await fallbackTurn;
    await expect(modelPicker).toHaveText("Camel Free");
    await checkpoint(page, testInfo, "03-camel-free-fallback");

    await page.reload();
    await waitForChat(page);
    await expect(page.getByRole("button", { name: "Thread model" })).toHaveText("Camel Free");
    await sendChatAndWait(page, "Reply with exactly: fallback persisted");
  });

  test("free account purchases Starter through Stripe Checkout", async ({ page }, testInfo) => {
    const { primary } = await readFixtureState();
    await login(page, primary, "/settings/organization/billing?view=plans");
    await expect(page).toHaveURL(/\/settings\/organization\/billing/);

    await planCard(page, "Starter").getByRole("button", { name: "Subscribe" }).click();
    await completeStripeCheckout(page);

    await expect
      .poll(async () => snapshotPlan(await admin.snapshot(primary.orgId)), {
        timeout: 90_000,
        intervals: [2_000, 5_000, 10_000],
        message: "waiting for the Stripe webhook to project Starter into OrgDO",
      })
      .toBe("starter");

    await page.goto("/settings/organization/billing");
    await expect(page.getByRole("heading", { name: /Starter plan/i })).toBeVisible();
    const snapshot = await admin.snapshot(primary.orgId);
    await attachSnapshot(testInfo, "04-starter-after-checkout", snapshot);
    await checkpoint(page, testInfo, "04-starter-billing");
  });

  test("Starter upgrades to Pro", async ({ page }, testInfo) => {
    const { primary } = await readFixtureState();
    await login(page, primary, "/settings/organization/billing?view=plans");
    await expect(page).toHaveURL(/\/settings\/organization\/billing/);
    await planCard(page, "Pro").getByRole("button", { name: "Subscribe" }).click();

    // Trialing subscriptions update directly. Active subscriptions may use a
    // focused Stripe portal confirmation flow instead.
    const enteredPortal = await page
      .waitForURL(/billing\.stripe\.com/, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (enteredPortal) {
      const confirm = page.getByRole("button", { name: /confirm|update|continue/i }).last();
      await expect(confirm).toBeVisible({ timeout: 60_000 });
      await confirm.click();
    }

    await expect
      .poll(async () => snapshotPlan(await admin.snapshot(primary.orgId)), {
        timeout: 90_000,
        intervals: [2_000, 5_000, 10_000],
        message: "waiting for the Pro plan projection",
      })
      .toBe("pro");
    await page.goto("/settings/organization/billing");
    await expect(page.getByRole("heading", { name: /Pro plan/i })).toBeVisible();
    await attachSnapshot(testInfo, "05-pro-after-upgrade", await admin.snapshot(primary.orgId));
    await checkpoint(page, testInfo, "05-pro-upgrade");
  });

  test("PAYG account purchases a credit pack", async ({ page }, testInfo) => {
    const { payg } = await readFixtureState();
    await login(page, payg, "/settings/organization/usage");
    await expect(page).toHaveURL(/\/settings\/organization\/usage/);
    const before = await admin.snapshot(payg.orgId);
    const beforePurchased = snapshotPurchasedCredits(before) ?? 0;
    const beforeAvailable = snapshotAvailableCredits(before) ?? 0;

    await page.getByRole("button", { name: "Top up credits" }).click();
    const topUpDialog = page.getByRole("dialog", { name: "Top up credits" });
    await expect(topUpDialog).toBeVisible();
    await topUpDialog.getByRole("button", { name: "Buy" }).first().click();
    await completeStripeCheckout(page);

    await expect
      .poll(async () => {
        const current = await admin.snapshot(payg.orgId);
        const purchased = snapshotPurchasedCredits(current);
        const available = snapshotAvailableCredits(current);
        if (purchased !== null) return purchased > beforePurchased;
        return available !== null && available > beforeAvailable;
      }, {
        timeout: 90_000,
        intervals: [2_000, 5_000, 10_000],
        message: "waiting for credit purchase webhook",
      })
      .toBe(true);

    const after = await admin.snapshot(payg.orgId);
    expect(snapshotPlan(after)).toBe("payg");
    await attachSnapshot(testInfo, "06-payg-credit-purchase", after);
    await checkpoint(page, testInfo, "06-payg-credits");
  });
});
