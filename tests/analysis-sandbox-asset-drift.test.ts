import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The analysis container's Dockerfile COPYs a build-context copy of the canonical
 * validate-notebook script (wrangler's container build context is workers/main, so
 * it can't reach ../../sandbox). This guards the two from drifting: update both
 * sandbox/validate-notebook.py and workers/main/analysis-sandbox-assets/ together.
 */
describe("analysis-sandbox validate-notebook asset", () => {
  it("is byte-identical to the canonical sandbox/validate-notebook.py", () => {
    const canonical = readFileSync(resolve(process.cwd(), "sandbox/validate-notebook.py"));
    const baked = readFileSync(resolve(process.cwd(), "workers/main/analysis-sandbox-assets/validate-notebook.py"));
    expect(baked.equals(canonical)).toBe(true);
  });
});
