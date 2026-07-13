import { stripMentionAnnotations } from "@/lib/mentions";

const SYSTEM_MESSAGE_TAG_REGEX =
  /<camelai system message>[\s\S]*?<\/camelai system message>/g;

export function stripSystemMessageTags(text: string): string {
  return stripMentionAnnotations(
    text.replace(SYSTEM_MESSAGE_TAG_REGEX, ""),
  ).trim();
}
