import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ADMIN_API_KEY_PATTERN = /^\s*ADMIN_API_KEY\s*=(.*)$/;

function decodeEnvValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export async function ensureSelfhostAdminApiKey(envPath) {
  let text = await fs.readFile(envPath, "utf8");
  const lines = text.split(/\r?\n/);
  const definitions = lines.flatMap((line, index) => {
    const match = line.match(ADMIN_API_KEY_PATTERN);
    return match ? [{ index, value: decodeEnvValue(match[1]) }] : [];
  });
  const existingValue = definitions.at(-1)?.value ?? "";

  if (existingValue) {
    await fs.chmod(envPath, 0o600);
    return { created: false };
  }

  const value = randomBytes(32).toString("base64url");
  const line = `ADMIN_API_KEY=${value}`;
  if (definitions.length > 0) {
    const definitionIndexes = new Set(definitions.map((definition) => definition.index));
    const firstIndex = definitions[0].index;
    text = lines
      .flatMap((existingLine, index) => {
        if (index === firstIndex) return [line];
        return definitionIndexes.has(index) ? [] : [existingLine];
      })
      .join("\n");
  } else {
    text = `${text.trimEnd()}\n${line}\n`;
  }
  await atomicWritePrivateFile(envPath, text);
  return { created: true };
}

async function atomicWritePrivateFile(filePath, contents) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
