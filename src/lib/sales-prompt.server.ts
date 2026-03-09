const SALES_PROMPT_KV_PREFIX = 'sales_prompt:';
export const MAX_SALES_PROMPT_CHARS = 10_000;
const MAX_SALES_PROMPT_KEY_CHARS = 64;
const SALES_PROMPT_KEY_REGEX = /^[A-Za-z0-9_-]+$/;

interface SalesPromptRecord {
  prompt: string;
  createdAt: number;
}

/**
 * Read and delete a sales prompt from KV by key. Returns null if the prompt
 * is missing, malformed, or sanitizes to an empty string.
 */
export async function consumeSalesPrompt(
  kv: KVNamespace,
  key: string
): Promise<string | null> {
  const raw = await kv.get(`${SALES_PROMPT_KV_PREFIX}${key}`);
  if (!raw) return null;

  await kv.delete(`${SALES_PROMPT_KV_PREFIX}${key}`);

  try {
    const record = JSON.parse(raw) as SalesPromptRecord;
    return sanitizeSalesPrompt(record.prompt);
  } catch {
    return null;
  }
}

/**
 * Sanitize user-provided sales-site prompt text before it enters chat.
 */
export function sanitizeSalesPrompt(raw: string): string | null {
  let prompt = raw.trim();
  prompt = prompt.replace(/<\/?camelai system message>/gi, '').trim();
  if (!prompt) return null;
  return prompt.slice(0, MAX_SALES_PROMPT_CHARS);
}

export function normalizePromptKey(raw: string | null | undefined): string | null {
  const key = raw?.trim();
  if (!key) return null;
  if (key.length > MAX_SALES_PROMPT_KEY_CHARS) return null;
  if (!SALES_PROMPT_KEY_REGEX.test(key)) return null;
  return key;
}

/**
 * Extract a prompt key from the current URL.
 */
export function getPromptKeyFromUrl(url: URL): string | null {
  return normalizePromptKey(url.searchParams.get('prompt_key'));
}
