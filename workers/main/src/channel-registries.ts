import { DurableObject } from "cloudflare:workers";
import {
  TELEGRAM_SETUP_TTL_SECONDS,
  getTelegramRegistryName,
  type TelegramChatBinding,
  type TelegramSetupRecord,
} from "../../../src/lib/telegram-channel.js";

export interface SlackTeamInstallationRecord {
  workspace_id: string;
  org_id: string;
  integration_id: string;
  team_id: string;
  bot_user_id?: string;
  updated_at: number;
}

export interface StoredTelegramSetupRecord extends TelegramSetupRecord {
  expiresAt: number;
}

export interface StoredTelegramChatBinding extends TelegramChatBinding {
  boundAt: number;
}

export interface TelegramRegistryD1MigrationExport {
  exportVersion: 1;
  exportedAt: number;
  setupTokens: Array<{ token: string; record: StoredTelegramSetupRecord }>;
  chatBindings: Array<{ chatId: string; binding: StoredTelegramChatBinding }>;
}

export interface SlackTeamRegistryD1MigrationExport {
  exportVersion: 1;
  exportedAt: number;
  installations: SlackTeamInstallationRecord[];
}

const TELEGRAM_SETUP_PREFIX = "setup:";
const TELEGRAM_CHAT_PREFIX = "chat:";
const SLACK_INSTALLATIONS_KEY = "installations";
const MAX_SLACK_TEAM_INSTALLATIONS = 20;

function telegramSetupKey(token: string): string {
  return `${TELEGRAM_SETUP_PREFIX}${token}`;
}

function telegramChatKey(chatId: string): string {
  return `${TELEGRAM_CHAT_PREFIX}${chatId}`;
}

function isSlackTeamInstallationRecord(
  value: unknown,
): value is SlackTeamInstallationRecord {
  const record = value as Partial<SlackTeamInstallationRecord> | null;
  return Boolean(
    record &&
      typeof record.workspace_id === "string" &&
      typeof record.org_id === "string" &&
      typeof record.integration_id === "string" &&
      typeof record.team_id === "string" &&
      typeof record.updated_at === "number" &&
      (record.bot_user_id === undefined ||
        typeof record.bot_user_id === "string"),
  );
}

export class TelegramRegistryDO extends DurableObject {
  putSetupToken(
    token: string,
    record: TelegramSetupRecord,
    ttlSeconds = TELEGRAM_SETUP_TTL_SECONDS,
  ): void {
    if (!token.trim()) {
      throw new Error("Telegram setup token is required");
    }
    this.ctx.storage.kv.put(telegramSetupKey(token), {
      ...record,
      expiresAt: Date.now() + ttlSeconds * 1000,
    } satisfies StoredTelegramSetupRecord);
  }

  consumeSetupToken(token: string): TelegramSetupRecord | null {
    if (!token.trim()) return null;
    const key = telegramSetupKey(token);
    const record = this.ctx.storage.kv.get<StoredTelegramSetupRecord>(key);
    if (!record) return null;
    this.ctx.storage.kv.delete(key);
    if (record.expiresAt <= Date.now()) return null;
    const { expiresAt: _expiresAt, ...setup } = record;
    return setup;
  }

  bindChat(chatId: string, binding: TelegramChatBinding): void {
    if (!chatId.trim()) {
      throw new Error("Telegram chat id is required");
    }
    this.ctx.storage.kv.put(telegramChatKey(chatId), {
      ...binding,
      boundAt: Date.now(),
    } satisfies StoredTelegramChatBinding);
  }

  getChatBinding(chatId: string): TelegramChatBinding | null {
    if (!chatId.trim()) return null;
    const record = this.ctx.storage.kv.get<StoredTelegramChatBinding>(
      telegramChatKey(chatId),
    );
    if (!record) return null;
    const { boundAt: _boundAt, ...binding } = record;
    return binding;
  }

  exportD1MigrationRecords(): TelegramRegistryD1MigrationExport {
    const setupTokens: TelegramRegistryD1MigrationExport["setupTokens"] = [];
    const chatBindings: TelegramRegistryD1MigrationExport["chatBindings"] = [];
    for (const [key, value] of this.ctx.storage.kv.list<unknown>()) {
      if (key.startsWith(TELEGRAM_SETUP_PREFIX)) {
        setupTokens.push({
          token: key.slice(TELEGRAM_SETUP_PREFIX.length),
          record: value as StoredTelegramSetupRecord,
        });
      } else if (key.startsWith(TELEGRAM_CHAT_PREFIX)) {
        chatBindings.push({
          chatId: key.slice(TELEGRAM_CHAT_PREFIX.length),
          binding: value as StoredTelegramChatBinding,
        });
      }
    }
    return {
      exportVersion: 1,
      exportedAt: Date.now(),
      setupTokens,
      chatBindings,
    };
  }
}

export class SlackTeamRegistryDO extends DurableObject {
  listInstallations(): SlackTeamInstallationRecord[] {
    const records = this.ctx.storage.kv.get<unknown>(SLACK_INSTALLATIONS_KEY);
    if (!Array.isArray(records)) return [];
    return records.filter(isSlackTeamInstallationRecord);
  }

  replaceInstallations(records: SlackTeamInstallationRecord[]): void {
    const valid = records
      .filter(isSlackTeamInstallationRecord)
      .slice(0, MAX_SLACK_TEAM_INSTALLATIONS);
    this.ctx.storage.kv.put(SLACK_INSTALLATIONS_KEY, valid);
  }

  upsertInstallation(record: SlackTeamInstallationRecord): void {
    if (!isSlackTeamInstallationRecord(record)) {
      throw new Error("Invalid Slack team installation record");
    }
    const records = this.listInstallations();
    const deduped = records.filter(
      (candidate) => candidate.integration_id !== record.integration_id,
    );
    deduped.unshift(record);
    this.replaceInstallations(deduped);
  }

  exportD1MigrationRecords(): SlackTeamRegistryD1MigrationExport {
    return {
      exportVersion: 1,
      exportedAt: Date.now(),
      installations: this.listInstallations(),
    };
  }
}

export function getTelegramRegistryStub(env: {
  TELEGRAM_REGISTRY?: DurableObjectNamespace<TelegramRegistryDO>;
  TELEGRAM_BOT_USERNAME?: string;
}): TelegramRegistryDO {
  if (!env.TELEGRAM_REGISTRY) {
    throw new Error("Telegram registry Durable Object is not configured");
  }
  const id = env.TELEGRAM_REGISTRY.idFromName(
    getTelegramRegistryName(env.TELEGRAM_BOT_USERNAME),
  );
  return env.TELEGRAM_REGISTRY.get(id) as unknown as TelegramRegistryDO;
}

export function getSlackTeamRegistryStub(
  env: { SLACK_TEAM_REGISTRY?: DurableObjectNamespace<SlackTeamRegistryDO> },
  teamId: string,
): SlackTeamRegistryDO {
  if (!env.SLACK_TEAM_REGISTRY) {
    throw new Error("Slack team registry Durable Object is not configured");
  }
  const normalizedTeamId = teamId.trim();
  if (!normalizedTeamId) {
    throw new Error("Slack team id is required");
  }
  return env.SLACK_TEAM_REGISTRY.get(
    env.SLACK_TEAM_REGISTRY.idFromName(normalizedTeamId),
  ) as unknown as SlackTeamRegistryDO;
}
