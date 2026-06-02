import { describe, expect, it } from "vitest";
import { parseCreditGrantAmountCents } from "@/lib/admin-credit-grants";

describe("parseCreditGrantAmountCents", () => {
  it.each([
    ["5", 500],
    ["5.00", 500],
    ["$5.00", 500],
    ["0.10", 10],
  ])("parses %s", (input, amountCents) => {
    expect(parseCreditGrantAmountCents(input)).toEqual({ amountCents });
  });

  it.each(["", "0", "-1", "1.234", "abc", "10000.01"])(
    "rejects %s",
    (input) => {
      expect(parseCreditGrantAmountCents(input).error).toEqual(
        expect.any(String),
      );
    },
  );

  it("rejects null input", () => {
    expect(parseCreditGrantAmountCents(null).error).toEqual(expect.any(String));
  });
});
