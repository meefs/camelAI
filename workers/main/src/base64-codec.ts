const BASE64_ENCODE_CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (
    let index = 0;
    index < bytes.length;
    index += BASE64_ENCODE_CHUNK_SIZE
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, index + BASE64_ENCODE_CHUNK_SIZE),
    );
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
