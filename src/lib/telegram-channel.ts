export const TELEGRAM_SETUP_TTL_SECONDS = 30 * 60;

export interface TelegramSetupRecord {
  workspaceId: string;
  orgId: string;
  integrationId: string;
  userId: string;
}

export interface TelegramChatBinding {
  workspaceId: string;
  orgId: string;
  integrationId: string;
}

export function generateTelegramSetupToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function normalizeTelegramBotUsername(value: string | undefined): string {
  return (value || "").trim().replace(/^@/, "");
}

export function getTelegramRegistryName(botUsername: string | undefined): string {
  return `telegram:${normalizeTelegramBotUsername(botUsername) || "default"}`;
}

export function buildTelegramDeepLink(botUsername: string, token: string): string {
  return `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(token)}`;
}
