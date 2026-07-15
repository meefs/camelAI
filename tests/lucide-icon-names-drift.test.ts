import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { iconNames } from "lucide-react/dynamic";

import {
  DEFAULT_CHAT_GROUP_ICON,
  POPULAR_CHAT_GROUP_ICONS,
} from "@/lib/chat-group-icons";
import { LUCIDE_ICON_NAMES } from "@/lib/lucide-icon-names.generated";

describe("lucide-icon-names.generated", () => {
  it("stays in sync with the installed lucide-react icon set", () => {
    // If this fails, regenerate the committed list:
    //   bun scripts/generate-lucide-icon-names.mjs
    expect([...LUCIDE_ICON_NAMES].sort()).toEqual([...iconNames].sort());
  });

  it("keeps the generated sprite symbol ids exactly in sync with the name list", () => {
    const sprite = readFileSync(
      resolve(process.cwd(), "src/assets/lucide-icon-sprite.generated.svg"),
      "utf8",
    );
    const symbolIds = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(symbolIds).toEqual(LUCIDE_ICON_NAMES);
    expect(new Set(symbolIds).size).toBe(symbolIds.length);
  });

  it("resolves the curated default and popular icons to real Lucide names", () => {
    const set = new Set(LUCIDE_ICON_NAMES);
    expect(set.has(DEFAULT_CHAT_GROUP_ICON)).toBe(true);
    for (const name of POPULAR_CHAT_GROUP_ICONS) {
      expect(set.has(name)).toBe(true);
    }
  });
});
