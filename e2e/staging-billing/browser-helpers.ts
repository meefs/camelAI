import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActorFixture } from "./fixture-state";
import type { BillingSnapshot } from "./admin-js-exec-client";

const execFileAsync = promisify(execFile);
let accessTokenPromise: Promise<string> | null = null;

async function stagingAccessToken(): Promise<string> {
  if (process.env.STAGING_CF_ACCESS_TOKEN?.trim()) {
    return process.env.STAGING_CF_ACCESS_TOKEN.trim();
  }
  if (!accessTokenPromise) {
    const baseURL = process.env.STAGING_BASE_URL || "https://staging.camelai.dev";
    accessTokenPromise = execFileAsync(
      process.env.CLOUDFLARED_BIN || "cloudflared",
      ["access", "token", `-app=${baseURL}`],
      { timeout: 30_000, env: process.env },
    ).then(({ stdout }) => {
      const token = stdout.trim();
      if (!token) throw new Error("cloudflared returned an empty Access token");
      return token;
    });
  }
  return accessTokenPromise;
}

async function authorizeStaging(page: Page) {
  const baseURL = process.env.STAGING_BASE_URL || "https://staging.camelai.dev";
  let token: string;
  try {
    token = await stagingAccessToken();
  } catch (error) {
    throw new Error(
      `Could not get a Cloudflare Access token. Set STAGING_CF_ACCESS_TOKEN or authenticate cloudflared: ${String(error)}`,
    );
  }
  await page.context().addCookies([
    {
      name: "CF_Authorization",
      value: token,
      url: baseURL,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
}

export async function login(page: Page, actor: ActorFixture, redirect = "/chat") {
  // A host-scoped cookie passes Access without forwarding credentials to
  // Stripe Checkout/Portal as global HTTP headers would.
  await authorizeStaging(page);
  await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`);
  await page.getByLabel("Email").fill(actor.email);
  await page.getByLabel("Password").fill(actor.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const redirectPath = new URL(redirect, "https://staging.camelai.dev").pathname;
  await page.waitForURL(
    (url) => url.pathname === "/onboarding" || url.pathname === redirectPath,
    { timeout: 60_000 },
  );
  if (new URL(page.url()).pathname === "/onboarding") {
    await page.waitForURL(/\/chat(?:\/|\?|$)/, { timeout: 60_000 });
    if (redirectPath !== "/chat") await page.goto(redirect);
  }
}

export async function waitForChat(page: Page) {
  await expect(page).toHaveURL(/\/chat(?:\/|\?|$)/, { timeout: 60_000 });
  await expect(page.locator("main textarea").first()).toBeVisible({
    timeout: 60_000,
  });
}

export async function sendChatAndWait(page: Page, message: string) {
  // The new-chat screen animates its placeholder, while an existing thread
  // uses static copy. The main composer is a textarea on both surfaces.
  const composer = page.locator("main textarea").first();
  const modelPicker = page.getByRole("button", { name: "Thread model" });
  const messageActions = page.getByRole("group", { name: "Message actions" });
  const before = await messageActions.count();

  await composer.fill(message);
  await composer.press("Enter");
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect
    .poll(() => messageActions.count(), { timeout: 4 * 60_000 })
    .toBeGreaterThan(before + 1);
  await expect(modelPicker).toBeEnabled({ timeout: 30_000 });
}

export async function selectThreadModel(page: Page, label: string) {
  const picker = page.getByRole("button", { name: "Thread model" });
  await picker.click();
  const modelUpdate = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/chat\/[^/]+\.data(?:\?|$)/.test(response.url()),
    { timeout: 60_000 },
  );
  await page.getByRole("menuitem").filter({ hasText: label }).click();
  await modelUpdate;
  await expect(picker).toHaveText(label);
  await expect(picker).toBeEnabled();
}

export function planCard(page: Page, label: string) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(label, { exact: true }) });
}

export async function checkpoint(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

export async function attachSnapshot(
  testInfo: TestInfo,
  name: string,
  snapshot: unknown,
) {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(snapshot, null, 2)),
    contentType: "application/json",
  });
}

export function snapshotPlan(snapshot: BillingSnapshot): string | null {
  const value = snapshot.billing_plan ?? snapshot.plan;
  return typeof value === "string" ? value : null;
}

export function snapshotAvailableCredits(snapshot: BillingSnapshot): number | null {
  const candidates = [
    snapshot.available_credits_cents,
    snapshot.availableCreditsCents,
    snapshot.current_available_credits_cents,
    snapshot.currentAvailableCreditsCents,
  ];
  const value = candidates.find((candidate) => typeof candidate === "number");
  return typeof value === "number" ? value : null;
}

export function snapshotPurchasedCredits(snapshot: BillingSnapshot): number | null {
  const candidates = [
    snapshot.purchased_credits_cents,
    snapshot.billing_credit_purchase_total_cents,
    snapshot.purchasedCreditsCents,
  ];
  const value = candidates.find((candidate) => typeof candidate === "number");
  return typeof value === "number" ? value : null;
}

async function stripeField(page: Page, label: RegExp): Promise<Locator> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const field = frame.getByLabel(label).first();
      if (await field.isVisible().catch(() => false)) return field;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Stripe field not found: ${label}`);
}

async function visibleStripeField(page: Page, label: RegExp): Promise<Locator | null> {
  for (const frame of page.frames()) {
    const field = frame.getByLabel(label).first();
    if (await field.isVisible().catch(() => false)) return field;
  }
  return null;
}

export async function completeStripeCheckout(page: Page) {
  await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 60_000 });

  const cardChoice = page.getByRole("radio", { name: "Card", exact: true });
  await cardChoice.check({ force: true });

  const saveInformation = page.getByRole("checkbox", {
    name: /save my information for faster checkout/i,
  });
  if (await saveInformation.isChecked().catch(() => false)) {
    await saveInformation.uncheck();
  }

  await (await stripeField(page, /card number/i)).fill("4242424242424242");
  await (await stripeField(page, /expiration/i)).fill("1234");
  await (await stripeField(page, /cvc/i)).fill("123");

  const name = await visibleStripeField(page, /cardholder name|name on card/i);
  if (name) await name.fill("Staging E2E");
  const postal = await visibleStripeField(page, /zip|postal/i);
  if (postal) await postal.fill("94107");

  const submit = page
    .getByRole("button", { name: /subscribe|pay|purchase|start trial/i })
    .last();
  await submit.click();
  await expect(page).toHaveURL(/staging\.camelai\.dev/, { timeout: 90_000 });
}
