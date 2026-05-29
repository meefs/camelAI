import { SUPPORTED_SLASH_COMMANDS } from '../../../src/lib/slash-commands';

export interface ChatAuthorIdentity {
  userName?: string | null;
  userEmail?: string | null;
  messageSource?: string | null;
}

const CAMELAI_SYSTEM_MESSAGE_REGEX =
  /<camelai system message>([\s\S]*?)<\/camelai system message>/gi;
const SLASH_COMMANDS = new Set<string>(SUPPORTED_SLASH_COMMANDS);

export function formatAuthorPrefix(
  userName: string | null | undefined,
  userEmail: string | null | undefined,
  messageSource: string | null | undefined = 'web',
): string {
  const source = formatMessageSource(messageSource);
  const displayName = userName?.trim();
  const email = userEmail?.trim();
  if (displayName && email) {
    return `[${source} message from ${displayName} (${email})]: `;
  }
  if (displayName) return `[${source} message from ${displayName}]: `;
  if (email) return `[${source} message from ${email}]: `;
  return `[${source} message]: `;
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
    : formatAuthorPrefix(
        author?.userName ?? null,
        author?.userEmail ?? null,
        author?.messageSource ?? null,
      );
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

function formatMessageSource(value: string | null | undefined): string {
  const normalized = (value || 'web')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _-]+/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || 'web';
}
