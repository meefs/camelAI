import { SUPPORTED_SLASH_COMMANDS } from '../../../src/lib/slash-commands';

export interface ChatAuthorIdentity {
  userName?: string | null;
  userEmail?: string | null;
}

const CAMELAI_SYSTEM_MESSAGE_REGEX =
  /<camelai system message>([\s\S]*?)<\/camelai system message>/gi;
const SLASH_COMMANDS = new Set<string>(SUPPORTED_SLASH_COMMANDS);

export function formatAuthorPrefix(
  userName: string | null | undefined,
  userEmail: string | null | undefined
): string {
  if (userName && userEmail) return `[${userName} (${userEmail})]: `;
  if (userName) return `[${userName}]: `;
  if (userEmail) return `[${userEmail}]: `;
  return '';
}

export function formatAttributedUserMessage(
  content: string,
  author?: ChatAuthorIdentity | null
): string {
  if (!content) return '';

  const contextMessages: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = CAMELAI_SYSTEM_MESSAGE_REGEX.exec(content)) !== null) {
    const value = typeof match[1] === 'string' ? match[1].trim() : '';
    if (value) {
      contextMessages.push(value);
    }
  }
  CAMELAI_SYSTEM_MESSAGE_REGEX.lastIndex = 0;

  const userMessage = content
    .replace(CAMELAI_SYSTEM_MESSAGE_REGEX, '')
    .trim();
  CAMELAI_SYSTEM_MESSAGE_REGEX.lastIndex = 0;

  const isSlashCommand = SLASH_COMMANDS.has(userMessage);
  const authorPrefix = isSlashCommand
    ? ''
    : formatAuthorPrefix(author?.userName ?? null, author?.userEmail ?? null);
  const attributedUserMessage = userMessage ? `${authorPrefix}${userMessage}` : '';

  const contextualPrefix = contextMessages.length > 0
    ? contextMessages
        .map((messageText) => `<camelai system message>${messageText}</camelai system message>`)
        .join('\n\n')
    : '';

  return [contextualPrefix, attributedUserMessage]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}
