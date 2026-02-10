export const SUPPORTED_SLASH_COMMANDS = [
  '/compact',
  '/context',
  '/debug',
  '/insights',
  '/security-review',
] as const;

export type SupportedSlashCommand = (typeof SUPPORTED_SLASH_COMMANDS)[number];

const SUPPORTED_SLASH_COMMANDS_SET = new Set<string>(SUPPORTED_SLASH_COMMANDS);

export function isSupportedSlashCommand(value: string): value is SupportedSlashCommand {
  return SUPPORTED_SLASH_COMMANDS_SET.has(value);
}

export const MANUAL_COMPACT_COMMAND: SupportedSlashCommand = '/compact';

export function isManualCompactCommand(value: string): boolean {
  return value.trim() === MANUAL_COMPACT_COMMAND;
}
