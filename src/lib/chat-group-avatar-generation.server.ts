import {
  runAuxiliaryAiChatCompletion,
  type AuxiliaryAiBinding,
  type AuxiliaryAiMetadata,
  type AuxiliaryAiRunContext,
} from "./auxiliary-ai.server";
import { isEmoji } from "./avatar";

const CHAT_GROUP_EMOJI_GENERATION_SYSTEM_PROMPT = [
  "Choose one emoji that best represents this chat group title.",
  "Respond with exactly one emoji and no words, punctuation, markdown, or quotes.",
  "If the title is generic, choose 💬.",
].join(" ");

const CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS = 8;

export type ChatGroupEmojiGenerationMetadata = AuxiliaryAiMetadata;
export type ChatGroupEmojiGenerationContext = AuxiliaryAiRunContext;

export function sanitizeGeneratedChatGroupEmoji(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const unquoted = trimmed.replace(/^["'`]+|["'`.]+$/g, "").trim();
  return isEmoji(unquoted) ? unquoted : null;
}

export async function generateChatGroupEmojiWithOpenAI(
  ai: AuxiliaryAiBinding | undefined | null,
  titleOrName: string,
  metadata?: ChatGroupEmojiGenerationMetadata,
  context?: ChatGroupEmojiGenerationContext,
): Promise<string | null> {
  const title = titleOrName.trim();
  if (!title) return null;
  const generated = await runAuxiliaryAiChatCompletion(ai, {
    systemPrompt: CHAT_GROUP_EMOJI_GENERATION_SYSTEM_PROMPT,
    userMessage: title,
    maxTokens: CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS,
    metadata,
    context,
  });

  return sanitizeGeneratedChatGroupEmoji(generated);
}
