import {
  runAuxiliaryAiChatCompletion,
  type AuxiliaryAiBinding,
} from '@/lib/auxiliary-ai.server';
import type { CloudflareEnv } from '@/lib/cloudflare.server';

const HELP_SUBJECT_SYSTEM_PROMPT =
  'Summarize the following support request into a short subject line (under 80 characters). Respond with only the subject line, no quotes or extra punctuation.';

function normalizeSubject(value: string | undefined | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, 100);
}

export async function generateHelpSubject(
  env: Pick<CloudflareEnv, 'AI'>,
  description: string,
  fallbackCategoryLabel: string
): Promise<string> {
  try {
    const subject = await runAuxiliaryAiChatCompletion(
      env.AI as AuxiliaryAiBinding,
      {
        systemPrompt: HELP_SUBJECT_SYSTEM_PROMPT,
        userMessage: description,
        maxTokens: 30,
      },
    );
    return normalizeSubject(subject) ?? fallbackCategoryLabel;
  } catch (error) {
    console.error('Help subject generation failed:', error);
    return fallbackCategoryLabel;
  }
}
