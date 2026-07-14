import type { ContentBlock } from '../types';

export interface ParsedMessageAuthor {
  name: string | null;
  email: string | null;
  displayName: string;
}

export interface ParsedMessageAuthorResult<T extends string | ContentBlock[]> {
  content: T;
  author: ParsedMessageAuthor | null;
  source: string | null;
}

const AUTHOR_PREFIX_WITH_EMAIL_REGEX = /^\[([^\]]+)\s+\(([^)]+)\)\]:\s*/;
const AUTHOR_PREFIX_WITH_SOURCE_REGEX = /^\[([a-z0-9 _-]+)\s+message(?:\s+from(?:\s+([^\]]*))?)?\]:\s*/i;
const AUTHOR_PREFIX_SIMPLE_REGEX = /^\[([^\]]+)\]:\s*/;
const SYSTEM_MESSAGE_TAG_REGEX = /<camelai system message>[\s\S]*?<\/camelai system message>/g;

function normalizedNonEmptyString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

/** Resolve a presentation-only author label without inventing an identity. */
export function resolveMessageAuthorDisplayName(
  name: string | null | undefined,
  email: string | null | undefined,
): string | null {
  return normalizedNonEmptyString(name) ?? normalizedNonEmptyString(email);
}

/** Remove model-only camelAI context tags before parsing or rendering text. */
export function stripSystemMessageTagsOnly(text: string): string {
  return text.replace(SYSTEM_MESSAGE_TAG_REGEX, '').trim();
}

function parsedAuthor(
  name: string | null | undefined,
  email: string | null | undefined,
): ParsedMessageAuthor | null {
  const normalizedName = normalizedNonEmptyString(name);
  const normalizedEmail = normalizedNonEmptyString(email);
  const displayName = resolveMessageAuthorDisplayName(
    normalizedName,
    normalizedEmail,
  );
  return displayName
    ? { name: normalizedName, email: normalizedEmail, displayName }
    : null;
}

function parseMessageAuthorText(
  rawContent: string,
): ParsedMessageAuthorResult<string> {
  const withoutSystemTags = rawContent.replace(SYSTEM_MESSAGE_TAG_REGEX, '');
  const removedSystemTag = withoutSystemTags !== rawContent;
  // Prefix matching historically tolerates surrounding whitespace. Preserve
  // the original bytes only when there is no model-only content to remove.
  const content = withoutSystemTags.trim();

  const matchWithSource = content.match(AUTHOR_PREFIX_WITH_SOURCE_REGEX);
  if (matchWithSource) {
    const authorText = matchWithSource[2]?.trim() || '';
    const authorWithEmail = authorText.match(/^(.+?)\s+\(([^)]+)\)$/);
    const author = authorWithEmail
      ? parsedAuthor(authorWithEmail[1], authorWithEmail[2])
      : authorText.includes('@')
        ? parsedAuthor(null, authorText)
        : parsedAuthor(authorText, null);
    return {
      author,
      source: normalizedNonEmptyString(matchWithSource[1])?.toLowerCase() ?? null,
      content: content.slice(matchWithSource[0].length),
    };
  }

  const matchWithEmail = content.match(AUTHOR_PREFIX_WITH_EMAIL_REGEX);
  if (matchWithEmail) {
    return {
      author: parsedAuthor(matchWithEmail[1], matchWithEmail[2]),
      source: null,
      content: content.slice(matchWithEmail[0].length),
    };
  }

  const matchSimple = content.match(AUTHOR_PREFIX_SIMPLE_REGEX);
  if (matchSimple) {
    const value = matchSimple[1]?.trim() || '';
    return {
      author: value.includes('@')
        ? parsedAuthor(null, value)
        : parsedAuthor(value, null),
      source: null,
      content: content.slice(matchSimple[0].length),
    };
  }

  return {
    author: null,
    source: null,
    content: removedSystemTag ? content : rawContent,
  };
}

export function parseMessageAuthor(
  rawContent: string,
): ParsedMessageAuthorResult<string>;
export function parseMessageAuthor(
  rawContent: ContentBlock[],
): ParsedMessageAuthorResult<ContentBlock[]>;
export function parseMessageAuthor(
  rawContent: string | ContentBlock[],
): ParsedMessageAuthorResult<string | ContentBlock[]>;
export function parseMessageAuthor(
  rawContent: string | ContentBlock[],
): ParsedMessageAuthorResult<string | ContentBlock[]> {
  if (typeof rawContent === 'string') {
    return parseMessageAuthorText(rawContent);
  }

  const firstTextIndex = rawContent.findIndex((block) => block.type === 'text');
  if (firstTextIndex === -1) {
    return { author: null, source: null, content: rawContent };
  }

  const firstTextBlock = rawContent[firstTextIndex];
  if (firstTextBlock.type !== 'text') {
    return { author: null, source: null, content: rawContent };
  }

  const parsed = parseMessageAuthorText(firstTextBlock.text);
  if (parsed.content === firstTextBlock.text) {
    return { ...parsed, content: rawContent };
  }

  const content = [...rawContent];
  content[firstTextIndex] = { ...firstTextBlock, text: parsed.content };
  return { ...parsed, content };
}
