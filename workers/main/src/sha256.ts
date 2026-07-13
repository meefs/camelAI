export async function sha256Hex(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const content = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", content);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
