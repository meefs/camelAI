import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";
import { iconNames } from "lucide-react/dynamic";

import { DEFAULT_CHAT_GROUP_ICON } from "@/lib/chat-group-icons";
import {
  LUCIDE_ICON_METADATA,
  LUCIDE_ICON_METADATA_VERSION,
} from "@/lib/lucide-icon-metadata.generated";
import {
  parseGeneratedPictogramTerms,
  resolveLucideIconTerms,
  searchLucideIconMetadata,
} from "@/lib/lucide-icon-metadata";

const require = createRequire(import.meta.url);
const installedLucideVersion = (
  require("lucide-react/package.json") as { version: string }
).version;

describe("lucide icon metadata snapshot", () => {
  it("matches the installed version and contains unique renderable canonical names", () => {
    expect(LUCIDE_ICON_METADATA_VERSION).toBe(installedLucideVersion);
    const names = LUCIDE_ICON_METADATA.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    const renderableNames = new Set<string>(iconNames);
    expect(names.every((name) => renderableNames.has(name))).toBe(true);
  });

  it("keeps deprecated familiar aliases searchable on canonical icons", () => {
    expect(resolveLucideIconTerms(["bar chart 3"])).toEqual({
      icon: "chart-column",
      outcome: "metadata_match",
      term: "bar chart 3",
    });
  });

  it("never offers the automatic default as a metadata candidate", () => {
    expect(searchLucideIconMetadata("messages square", 2)).not.toContainEqual(
      expect.objectContaining({ name: DEFAULT_CHAT_GROUP_ICON }),
    );
    expect(resolveLucideIconTerms(["messages square"]).icon).not.toBe(
      DEFAULT_CHAT_GROUP_ICON,
    );
  });
});

describe("Lucide metadata search", () => {
  it("uses Lucide tags to map wave to hand", () => {
    expect(searchLucideIconMetadata("wave", 1)[0]).toMatchObject({
      name: "hand",
      reason: "exact_tag",
    });
    expect(resolveLucideIconTerms(["waving hand"]).icon).toBe("hand");
  });

  it("resolves exact multi-word names and semantic tags", () => {
    expect(resolveLucideIconTerms(["map pin"]).icon).toBe("map-pin");
    expect(resolveLucideIconTerms(["snake"]).icon).toBe("worm");
  });

  it("skips weak or ambiguous terms in favor of a later exact alternative", () => {
    expect(resolveLucideIconTerms(["envelope", "email", "mail"])).toEqual({
      icon: "mail",
      outcome: "metadata_match",
      term: "mail",
    });
    expect(
      resolveLucideIconTerms(["mobile app", "languages", "globe"]).icon,
    ).toBe("languages");
  });

  it("allows only high-signal ambiguous results as a final fallback", () => {
    expect(resolveLucideIconTerms(["wave"])).toEqual({
      icon: "hand",
      outcome: "ambiguous_fallback",
      term: "wave",
    });
    expect(resolveLucideIconTerms(["frobnicate"])).toEqual({
      icon: null,
      outcome: "no_metadata_match",
      term: null,
    });
  });

  it("prefers stable base icons and does not stem metadata gerunds", () => {
    expect(resolveLucideIconTerms(["speech bubbles"])).toEqual({
      icon: "message-circle",
      outcome: "ambiguous_fallback",
      term: "speech bubbles",
    });
    expect(searchLucideIconMetadata("talking heads", 5)).not.toContainEqual(
      expect.objectContaining({ name: "heading" }),
    );
  });
});

describe("pictogram output parsing", () => {
  it("accepts common harmless formatting variations", () => {
    expect(parseGeneratedPictogramTerms("Waving Hand, HAND, Smile")).toEqual([
      "waving hand",
      "hand",
      "smile",
    ]);
    expect(
      parseGeneratedPictogramTerms("1. Rocket\n2. Cloud Upload\n3. Server"),
    ).toEqual(["rocket", "cloud upload", "server"]);
    expect(
      parseGeneratedPictogramTerms('{"pictograms":["Mail","Mailbox","Send"]}'),
    ).toEqual(["mail", "mailbox", "send"]);
    expect(
      parseGeneratedPictogramTerms(
        '```json\n["globe","flag","languages"]\n```',
      ),
    ).toEqual(["globe", "flag", "languages"]);
    expect(
      parseGeneratedPictogramTerms(
        "Here are three symbols:\n1. Rocket\n2. Cloud Upload\n3. Server",
      ),
    ).toEqual(["rocket", "cloud upload", "server"]);
  });

  it("caps phrase count and rejects empty, emoji-only, or prose-length values", () => {
    expect(parseGeneratedPictogramTerms("one, two, three, four")).toHaveLength(
      3,
    );
    expect(parseGeneratedPictogramTerms(null)).toEqual([]);
    expect(parseGeneratedPictogramTerms("💬")).toEqual([]);
    expect(
      parseGeneratedPictogramTerms(
        "this is a long explanatory answer that does not name one pictogram",
      ),
    ).toEqual([]);
  });
});
