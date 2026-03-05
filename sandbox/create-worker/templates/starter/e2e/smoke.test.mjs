/*
 * E2E smoke tests using Playwright.
 *
 * Commented out by default — uncomment when your app is deployed and you
 * want to verify it end-to-end in a real browser.
 *
 * Run with:  bun run test:e2e
 *
 * The CHIRIDION_APP_SESSION env var is automatically available in the
 * sandbox. It holds a dispatcher session token that authenticates
 * requests to private *.camelai.app deployments. Set it as a cookie
 * on the browser context so Playwright can access your deployed app.
 *
 * Usage:
 *   import { chromium } from "playwright";
 *
 *   const browser = await chromium.launch();
 *   const context = await browser.newContext();
 *
 *   // Authenticate with private deployed apps
 *   if (process.env.CHIRIDION_APP_SESSION) {
 *     await context.addCookies([{
 *       name: "chiridion_run_session",
 *       value: process.env.CHIRIDION_APP_SESSION,
 *       domain: ".camelai.app",
 *       path: "/",
 *       httpOnly: true,
 *     }]);
 *   }
 *
 *   const page = await context.newPage();
 *   await page.goto("https://my-app.camelai.app");
 */

// import { chromium } from "playwright";
// import { describe, it, expect, beforeAll, afterAll } from "vitest";
//
// // ── Replace with your deployed app URL after `bun run deploy` ──
// const APP_URL = "https://my-app.camelai.app";
//
// let browser;
// let context;
// let page;
//
// beforeAll(async () => {
//   browser = await chromium.launch();
//   context = await browser.newContext();
//
//   // Set auth cookie for private apps
//   if (process.env.CHIRIDION_APP_SESSION) {
//     await context.addCookies([{
//       name: "chiridion_run_session",
//       value: process.env.CHIRIDION_APP_SESSION,
//       domain: ".camelai.app",
//       path: "/",
//       httpOnly: true,
//     }]);
//   }
//
//   page = await context.newPage();
// });
//
// afterAll(async () => {
//   await browser?.close();
// });
//
// describe("smoke tests", () => {
//   it("homepage loads successfully", async () => {
//     const response = await page.goto(APP_URL);
//     expect(response.status()).toBe(200);
//   });
//
//   it("page has expected title", async () => {
//     await page.goto(APP_URL);
//     const title = await page.title();
//     expect(title).toBeTruthy();
//   });
// });
