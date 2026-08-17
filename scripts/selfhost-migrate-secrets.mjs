#!/usr/bin/env node
import path from "node:path";
import { envFile, readSelfhostEnv, repoRoot } from "./selfhost-common.mjs";
import { ensureSelfhostAdminApiKey } from "./selfhost-secret-migrations.mjs";

await readSelfhostEnv(true);
const result = await ensureSelfhostAdminApiKey(envFile);
console.log(
  result.created
    ? `Added ADMIN_API_KEY to ${path.relative(repoRoot, envFile)}.`
    : `Self-host secrets are current in ${path.relative(repoRoot, envFile)}.`,
);
