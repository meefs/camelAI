import type {
  DiscordChannelPayload,
  DiscordGuildMemberPayload,
  DiscordRolePayload,
} from "./types.js";

export const DISCORD_PERMISSIONS = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  ADMINISTRATOR: 1n << 3n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const;

export const DISCORD_REQUIRED_BOT_PERMISSIONS =
  DISCORD_PERMISSIONS.VIEW_CHANNEL |
  DISCORD_PERMISSIONS.SEND_MESSAGES |
  DISCORD_PERMISSIONS.EMBED_LINKS |
  DISCORD_PERMISSIONS.ATTACH_FILES |
  DISCORD_PERMISSIONS.READ_MESSAGE_HISTORY |
  DISCORD_PERMISSIONS.CREATE_PUBLIC_THREADS |
  DISCORD_PERMISSIONS.SEND_MESSAGES_IN_THREADS;

export const DISCORD_REQUIRED_BOT_PERMISSIONS_DECIMAL =
  DISCORD_REQUIRED_BOT_PERMISSIONS.toString();

export const DISCORD_REQUIRED_PERMISSION_NAMES = [
  "VIEW_CHANNEL",
  "SEND_MESSAGES",
  "EMBED_LINKS",
  "ATTACH_FILES",
  "READ_MESSAGE_HISTORY",
  "CREATE_PUBLIC_THREADS",
  "SEND_MESSAGES_IN_THREADS",
] as const;

function permissionValue(value: string | undefined): bigint {
  try {
    return BigInt(value || "0");
  } catch {
    return 0n;
  }
}

function rolePermissions(
  guildId: string,
  roles: DiscordRolePayload[],
  roleIds: Iterable<string>,
): bigint {
  const selected = new Set([guildId, ...roleIds]);
  return roles.reduce(
    (permissions, role) =>
      selected.has(role.id) ? permissions | permissionValue(role.permissions) : permissions,
    0n,
  );
}

export function calculateDiscordChannelPermissions(args: {
  guildId: string;
  roles: DiscordRolePayload[];
  member: DiscordGuildMemberPayload;
  channel: DiscordChannelPayload;
}): bigint {
  const memberId = args.member.user?.id || "";
  const memberRoleIds = args.member.roles || [];
  let permissions = rolePermissions(args.guildId, args.roles, memberRoleIds);
  if ((permissions & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n) {
    return (1n << 63n) - 1n;
  }

  const overwrites = args.channel.permission_overwrites || [];
  const everyone = overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === args.guildId,
  );
  if (everyone) {
    permissions &= ~permissionValue(everyone.deny);
    permissions |= permissionValue(everyone.allow);
  }

  let roleDeny = 0n;
  let roleAllow = 0n;
  const memberRoles = new Set(memberRoleIds);
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || !memberRoles.has(overwrite.id)) continue;
    roleDeny |= permissionValue(overwrite.deny);
    roleAllow |= permissionValue(overwrite.allow);
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const memberOverwrite = overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === memberId,
  );
  if (memberOverwrite) {
    permissions &= ~permissionValue(memberOverwrite.deny);
    permissions |= permissionValue(memberOverwrite.allow);
  }

  if ((permissions & DISCORD_PERMISSIONS.VIEW_CHANNEL) === 0n) return 0n;
  return permissions;
}

export function calculateDiscordEveryonePermissions(args: {
  guildId: string;
  roles: DiscordRolePayload[];
  channel: DiscordChannelPayload;
}): bigint {
  const everyoneRole = args.roles.find((role) => role.id === args.guildId);
  let permissions = permissionValue(everyoneRole?.permissions);
  const everyoneOverwrite = (args.channel.permission_overwrites || []).find(
    (overwrite) => overwrite.type === 0 && overwrite.id === args.guildId,
  );
  if (everyoneOverwrite) {
    permissions &= ~permissionValue(everyoneOverwrite.deny);
    permissions |= permissionValue(everyoneOverwrite.allow);
  }
  if ((permissions & DISCORD_PERMISSIONS.VIEW_CHANNEL) === 0n) return 0n;
  return permissions;
}

export function missingDiscordBotPermissions(permissions: bigint): string[] {
  return DISCORD_REQUIRED_PERMISSION_NAMES.filter(
    (name) => (permissions & DISCORD_PERMISSIONS[name]) === 0n,
  );
}

export function discordEveryoneCanPost(permissions: bigint): boolean {
  const required =
    DISCORD_PERMISSIONS.VIEW_CHANNEL | DISCORD_PERMISSIONS.SEND_MESSAGES;
  return (permissions & required) === required;
}
