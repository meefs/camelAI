const TEAMMATE_MESSAGE_REGEX = /^<teammate-message\s+teammate_id="([^"]+)">\n?([\s\S]*?)\n?<\/teammate-message>$/;

export interface ParsedTeammateMessage {
  teammateId: string;
  content: string;
}

/**
 * Strip camelAI system message tags from content.
 * Duplicated here to avoid circular dependency with message-bubble.tsx.
 */
function stripSystemMessageTags(text: string): string {
  return text.replace(/<camelai system message>[\s\S]*?<\/camelai system message>/g, '').trim();
}

export function parseTeammateMessage(rawContent: string): ParsedTeammateMessage | null {
  const stripped = stripSystemMessageTags(rawContent).trim();
  const match = stripped.match(TEAMMATE_MESSAGE_REGEX);
  if (!match) return null;
  return {
    teammateId: match[1] ?? '',
    content: (match[2] ?? '').trim(),
  };
}

export function stripTeammateMessageTags(text: string): string {
  return text
    .replace(/<teammate-message\s+teammate_id="[^"]*">\n?/g, '')
    .replace(/<\/teammate-message>/g, '')
    .trim();
}
