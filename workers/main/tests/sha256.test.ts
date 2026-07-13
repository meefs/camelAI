import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/sha256";

const ABC_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256Hex", () => {
  it("hashes byte views without including bytes outside the view", async () => {
    const bytes = new TextEncoder().encode("_abc_").subarray(1, 4);

    await expect(sha256Hex(bytes)).resolves.toBe(ABC_SHA256);
  });

  it("hashes strings as UTF-8", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(ABC_SHA256);
  });

  it("returns the standard empty digest", async () => {
    await expect(sha256Hex(new Uint8Array())).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
