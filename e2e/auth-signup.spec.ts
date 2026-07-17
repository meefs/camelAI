import { expect, test } from "@playwright/test";

test("email signup creates a session and opens onboarding", async ({
  page,
  context,
}) => {
  const email = `signup-e2e-${crypto.randomUUID()}@example.com`;

  await page.goto("/signup", { waitUntil: "networkidle" });

  const hydrationOverlay = page.locator(
    "[aria-hidden='true'].fixed.inset-0.z-\\[100\\]",
  );
  if (await hydrationOverlay.isVisible()) {
    // A cold Vite server can invalidate its first optimized dependency request.
    // Reload after optimization settles, then require the real client to hydrate.
    await page.reload({ waitUntil: "networkidle" });
  }
  await expect(hydrationOverlay).toHaveCount(0);

  await page.getByLabel("Name (optional)").fill("Signup E2E");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByLabel("Confirm password").fill("password123");

  const signupResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/auth/signup.data",
  );
  await page.getByRole("button", { name: "Create account" }).click();

  const response = await signupResponse;
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(/\/onboarding(?:\?|$)/);
  await expect(
    page.getByRole("heading", { name: "Welcome to camelAI" }),
  ).toBeVisible();
  await expect(page.getByText(email, { exact: false })).toBeVisible();

  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.name === "chiridion_session_local")).toBe(
    true,
  );
});
