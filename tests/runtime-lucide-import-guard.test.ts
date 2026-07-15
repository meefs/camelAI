import { describe, expect, it } from "vitest";

import { findForbiddenLucideModuleReferences } from "../scripts/check-runtime-lucide-imports";

describe("runtime Lucide import guard", () => {
  it.each([
    'import { DynamicIcon } from "lucide-react/dynamic";',
    "const loadIcon = () => import('lucide-react/dynamic.mjs');",
    "await import(`lucide-react/dynamicIconImports`);",
  ])("finds forbidden static and dynamic module strings", (source) => {
    expect(findForbiddenLucideModuleReferences(source)).toEqual([
      expect.objectContaining({
        moduleName: expect.stringMatching(/^lucide-react\/dynamic/),
        line: 1,
      }),
    ]);
  });

  it("allows ordinary static Lucide icon imports", () => {
    expect(
      findForbiddenLucideModuleReferences(
        'import { Search } from "lucide-react";',
      ),
    ).toEqual([]);
  });
});
