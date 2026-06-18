import {
  runAuxiliaryAiChatCompletion,
  type AuxiliaryAiBinding,
  type AuxiliaryAiMetadata,
  type AuxiliaryAiRunContext,
} from "./auxiliary-ai.server";
import {
  sanitizeGeneratedThreadTitle,
  THREAD_TITLE_GENERATION_SYSTEM_PROMPT,
} from "./thread-title";

export { AUXILIARY_AI_MODEL as THREAD_TITLE_GENERATION_MODEL } from "./auxiliary-ai.server";

const THREAD_TITLE_MAX_OUTPUT_TOKENS = 50;

export type ThreadTitleGenerationMetadata = AuxiliaryAiMetadata;
export type ThreadTitleGenerationContext = AuxiliaryAiRunContext;

export async function generateThreadTitleWithOpenAI(
  ai: AuxiliaryAiBinding | undefined | null,
  message: string,
  metadata?: ThreadTitleGenerationMetadata,
  context?: ThreadTitleGenerationContext,
): Promise<string | null> {
  const generated = await runAuxiliaryAiChatCompletion(ai, {
    systemPrompt: THREAD_TITLE_GENERATION_SYSTEM_PROMPT,
    userMessage: message,
    maxTokens: THREAD_TITLE_MAX_OUTPUT_TOKENS,
    metadata,
    context,
  });

  return sanitizeGeneratedThreadTitle(generated, { titleCase: true });
}
