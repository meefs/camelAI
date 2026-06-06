import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deployed wrangler migration config", () => {
  it.each(["wrangler.staging.jsonc", "wrangler.prod.jsonc"])(
    "%s enables legacy workspace migration gating",
    (configPath) => {
      const source = readFileSync(configPath, "utf8");

      expect(source).toContain('"ENABLE_LEGACY_WORKSPACE_MIGRATION": "1"');
    },
  );
});
