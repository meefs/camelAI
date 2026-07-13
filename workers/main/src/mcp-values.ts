export function textToolResult(value: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function objectArg(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseJsonObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    return objectArg(JSON.parse(value));
  } catch {
    return {};
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${field} is required`), { status: 400 });
  }
  return value.trim();
}
