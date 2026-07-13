import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../src/base64-codec";

describe("Worker base64 codec", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.of(0, 1, 2, 127, 128, 254, 255);

    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("decodes base64 containing whitespace", () => {
    expect(base64ToBytes(" YW Jj\nZA==\t")).toEqual(
      new TextEncoder().encode("abcd"),
    );
  });

  it("encodes large byte arrays in bounded chunks", () => {
    const bytes = Uint8Array.from(
      { length: 0x8000 * 8 + 17 },
      (_, index) => index % 256,
    );

    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("preserves empty values", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array());
  });
});
