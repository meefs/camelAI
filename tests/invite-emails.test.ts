import { describe, expect, it } from "vitest";

import {
  normalizeInviteEmail,
  parseInviteEmails,
} from "@/lib/invite-emails";

describe("invite email parsing", () => {
  it("tokenizes comma, semicolon, newline, tab, and whitespace separated emails", () => {
    expect(
      parseInviteEmails(
        "ana@example.com, ben@example.com; cam@example.com\ndan@example.com\teri@example.com frank@example.com",
      ).emails,
    ).toEqual([
      "ana@example.com",
      "ben@example.com",
      "cam@example.com",
      "dan@example.com",
      "eri@example.com",
      "frank@example.com",
    ]);
  });

  it("normalizes emails to lowercase", () => {
    expect(normalizeInviteEmail("ANA@EXAMPLE.COM")).toBe("ana@example.com");
  });

  it("deduplicates valid emails while preserving order", () => {
    expect(
      parseInviteEmails("ana@example.com ANA@example.com ben@example.com").emails,
    ).toEqual(["ana@example.com", "ben@example.com"]);
  });

  it("returns invalid tokens separately", () => {
    expect(parseInviteEmails("ana@example.com nope ben@example.com")).toEqual({
      emails: ["ana@example.com", "ben@example.com"],
      rejectedTokens: ["nope"],
    });
  });

  it("accepts harmless angle wrapping", () => {
    expect(parseInviteEmails("<ana@example.com>").emails).toEqual([
      "ana@example.com",
    ]);
  });
});
