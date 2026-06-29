import { Sandbox } from "@cloudflare/sandbox";

import type { Env } from "./types.js";

/**
 * Warm per-org build container for DO+R2-backed projects.
 *
 * This is intentionally separate from WarehouseSandbox: builds execute arbitrary
 * package install/build code and need npm registry egress, while warehouse code
 * is sealed. Callers still run only fixed platform-issued commands here.
 */
export class ProjectBuildSandbox extends Sandbox<Env> {}
