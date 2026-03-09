const SALES_PROMPT_KV_PREFIX = 'sales_prompt:';
export const MAX_SALES_PROMPT_CHARS = 10_000;

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

/**
 * Extract a prompt key from the current URL.
 */
export function getPromptKeyFromUrl(url: URL): string | null {
  return url.searchParams.get('prompt_key')?.trim() || null;
}
