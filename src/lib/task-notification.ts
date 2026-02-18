import type { ContentBlock } from '@/types';

const SYSTEM_MESSAGE_TAG_REGEX = /<camelai system message>[\s\S]*?<\/camelai system message>/g;
const TASK_NOTIFICATION_REGEX = /^<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>([\s\S]*)$/;
const TRAILING_INSTRUCTION_REGEX = /^Read the output file to retrieve the result:.*$/i;

export interface ParsedTaskNotification {
  taskId: string;
  outputFile: string;
  status: string;
  summary: string;
}

function stripSystemMessageTags(text: string): string {
  return text.replace(SYSTEM_MESSAGE_TAG_REGEX, '').trim();
}

function extractTagValue(body: string, tag: string): string | null {
  const tagPattern = new RegExp(`<${tag}\\s*>([\\s\\S]*?)<\\/${tag}\\s*>`);
  const match = body.match(tagPattern);
  if (!match) return null;
  return (match[1] ?? '').trim();
}

export function parseTaskNotification(rawContent: string): ParsedTaskNotification | null {
  const stripped = stripSystemMessageTags(rawContent).trim();
  if (!stripped) return null;

  const envelopeMatch = stripped.match(TASK_NOTIFICATION_REGEX);
  if (!envelopeMatch) return null;

  const body = (envelopeMatch[1] ?? '').trim();
  const trailingText = (envelopeMatch[2] ?? '').trim();
  if (trailingText && !TRAILING_INSTRUCTION_REGEX.test(trailingText)) {
    return null;
  }

  const taskId = extractTagValue(body, 'task-id');
  const outputFile = extractTagValue(body, 'output-file');
  const status = extractTagValue(body, 'status');
  const summary = extractTagValue(body, 'summary');

  if (!taskId || !outputFile || !status || summary === null) {
    return null;
  }

  return {
    taskId,
    outputFile,
    status: status.toLowerCase(),
    summary,
  };
}

export function parseTaskNotificationFromContent(
  content: string | ContentBlock[]
): ParsedTaskNotification | null {
  if (typeof content === 'string') {
    return parseTaskNotification(content);
  }

  const rawText = content
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n');

  if (!rawText.trim()) return null;
  return parseTaskNotification(rawText);
}
