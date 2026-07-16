import { spawn } from "node:child_process";

const args = [
  "playwright",
  "test",
  "--config=playwright.staging-billing.config.ts",
  ...process.argv.slice(2),
];

const child = spawn("bunx", args, {
  stdio: "inherit",
  env: { ...process.env, STAGING_BILLING_E2E: "1" },
});
const signal = await new Promise((resolve) => {
  child.once("exit", (code, nextSignal) => resolve({ code, signal: nextSignal }));
  child.once("error", (error) => {
    console.error(error);
    resolve({ code: 1, signal: null });
  });
});

if (signal.signal) process.kill(process.pid, signal.signal);
process.exitCode = signal.code ?? 1;

