import { spawn } from "node:child_process";
import path from "node:path";
import { applyCloudflareContainerEgressWorkaround } from "./cloudflare-container-egress.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const env = { ...process.env };
applyCloudflareContainerEgressWorkaround(env);

const child = spawn("wrangler", ["dev", ...process.argv.slice(2)], {
  cwd: repoRoot,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal === "SIGINT") process.exit(130);
  if (signal === "SIGTERM") process.exit(143);
  process.exit(code ?? 0);
});
