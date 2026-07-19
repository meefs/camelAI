import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function parseBunLock(content: string): {
  packages: Record<string, [resolved: string, ...unknown[]]>;
} {
  return JSON.parse(content.replace(/,(\s*[}\]])/g, "$1"));
}

function readGeneratedScaffoldLock(): string {
  const source = readFileSync(
    resolve(process.cwd(), "workers/main/src/project-scaffold-lock.generated.ts"),
    "utf8",
  );
  const prefix = "export const DEFAULT_CRUD_BUN_LOCK = ";
  const declaration = source.split("\n").find((line) => line.startsWith(prefix));
  if (!declaration?.endsWith(";")) throw new Error("Malformed generated CRUD scaffold lock module");
  return JSON.parse(declaration.slice(prefix.length, -1));
}

describe("project dependency locks", () => {
  it("bakes the exact default CRUD scaffold lock into the warm image", () => {
    const generatedScaffoldLock = readGeneratedScaffoldLock();
    const imageScaffoldLock = readFileSync(
      resolve(process.cwd(), "workers/main/project-build-sandbox-warmup/crud/bun.lock"),
      "utf8",
    );
    const scaffoldLock = parseBunLock(generatedScaffoldLock);

    expect(Object.keys(scaffoldLock.packages).length).toBeGreaterThan(0);
    expect(imageScaffoldLock).toBe(generatedScaffoldLock);
  });
});
