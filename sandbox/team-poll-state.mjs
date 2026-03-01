const TEAM_POLL_STATE_VERSION = 1;
const TEAM_CONSUMED_KEY_LIMIT = 512;

function isObjectRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function normalizeTeamDirName(teamName) {
  if (typeof teamName !== 'string') return '';
  return teamName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

export function messageKey(msg) {
  if (!isObjectRecord(msg)) return '';
  const { read: _ignored, ...rest } = msg;
  return JSON.stringify(rest);
}

export function inboxMessageSender(msg) {
  if (!isObjectRecord(msg)) return 'unknown';
  if (typeof msg.from === 'string' && msg.from) return msg.from;
  if (typeof msg.sender === 'string' && msg.sender) return msg.sender;
  if (typeof msg.teammate_id === 'string' && msg.teammate_id) return msg.teammate_id;
  return 'unknown';
}

export function inboxMessageText(msg) {
  if (!isObjectRecord(msg)) return '';
  if (typeof msg.text === 'string') return msg.text;
  if (typeof msg.content === 'string') return msg.content;
  if (typeof msg.message === 'string') return msg.message;
  return '';
}

export function formatTeammateMessage(msg) {
  const teammate = inboxMessageSender(msg);
  const content = inboxMessageText(msg);
  return `<teammate-message teammate_id="${teammate}">\n${content}\n</teammate-message>`;
}

export function toolResultToolUseId(block) {
  if (!isObjectRecord(block)) return '';
  return typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
}

function parseJsonSafe(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function teamNameFromConfigPath(pathValue) {
  if (typeof pathValue !== 'string' || !pathValue) return '';
  const normalized = pathValue.replace(/\\/g, '/');
  const explicitMatch = normalized.match(/\/\.claude\/teams\/([^/]+)\/config\.json$/);
  if (explicitMatch?.[1]) return explicitMatch[1];
  const segments = normalized.split('/').filter(Boolean);
  const teamsIdx = segments.lastIndexOf('teams');
  if (teamsIdx === -1 || !segments[teamsIdx + 1]) return '';
  return segments[teamsIdx + 1];
}

function teamNameFromTeamCreatePayload(payload) {
  if (!isObjectRecord(payload)) return '';
  const data = isObjectRecord(payload.data) ? payload.data : null;
  const teamName = payload.team_name ?? data?.team_name;
  if (typeof teamName === 'string' && teamName) return teamName;
  const teamFilePath = payload.team_file_path ?? data?.team_file_path;
  return teamNameFromConfigPath(teamFilePath);
}

export function teamNameFromTeamCreateResultContent(content) {
  if (typeof content === 'string') {
    const parsed = parseJsonSafe(content);
    if (parsed) return teamNameFromTeamCreatePayload(parsed);
    return '';
  }
  if (isObjectRecord(content)) {
    return teamNameFromTeamCreatePayload(content);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isObjectRecord(block)) continue;
      if (typeof block.text === 'string') {
        const fromText = teamNameFromTeamCreateResultContent(block.text);
        if (fromText) return fromText;
      }
      if (isObjectRecord(block.content)) {
        const fromObjectContent = teamNameFromTeamCreateResultContent(block.content);
        if (fromObjectContent) return fromObjectContent;
      }
      if (typeof block.content === 'string') {
        const fromStringContent = teamNameFromTeamCreateResultContent(block.content);
        if (fromStringContent) return fromStringContent;
      }
    }
  }
  return '';
}

function coerceTeamKey(teamName) {
  return normalizeTeamDirName(teamName);
}

function sanitizeConsumedKeysByTeam(rawValue) {
  if (!isObjectRecord(rawValue)) return {};
  const output = {};
  for (const [teamName, value] of Object.entries(rawValue)) {
    const teamKey = coerceTeamKey(teamName);
    if (!teamKey || !Array.isArray(value)) continue;
    const seen = new Set();
    for (const item of value) {
      if (typeof item !== 'string' || !item || seen.has(item)) continue;
      seen.add(item);
    }
    output[teamKey] = [...seen].slice(-TEAM_CONSUMED_KEY_LIMIT);
  }
  return output;
}

export class TeamPollState {
  constructor(rawState = null) {
    this._ownedTeams = new Set();
    this._consumedKeysByTeam = new Map();
    this.load(rawState);
  }

  load(rawState) {
    if (!isObjectRecord(rawState)) return;
    const rawOwnedTeams = Array.isArray(rawState.ownedTeams) ? rawState.ownedTeams : [];
    for (const teamName of rawOwnedTeams) {
      if (typeof teamName !== 'string') continue;
      this.registerOwnedTeam(teamName);
    }

    const consumedKeysByTeam = sanitizeConsumedKeysByTeam(rawState.consumedKeysByTeam);
    for (const [teamName, keys] of Object.entries(consumedKeysByTeam)) {
      this._consumedKeysByTeam.set(teamName, keys);
    }
  }

  registerOwnedTeam(teamName) {
    const teamKey = coerceTeamKey(teamName);
    if (!teamKey) return '';
    this._ownedTeams.add(teamKey);
    if (!this._consumedKeysByTeam.has(teamKey)) {
      this._consumedKeysByTeam.set(teamKey, []);
    }
    return teamKey;
  }

  isOwnedTeam(teamName) {
    const teamKey = coerceTeamKey(teamName);
    if (!teamKey) return false;
    return this._ownedTeams.has(teamKey);
  }

  listOwnedTeams() {
    return [...this._ownedTeams];
  }

  hasConsumed(teamName, key) {
    if (typeof key !== 'string' || !key) return false;
    const teamKey = coerceTeamKey(teamName);
    if (!teamKey) return false;
    const keys = this._consumedKeysByTeam.get(teamKey) ?? [];
    return keys.includes(key);
  }

  markConsumed(teamName, key) {
    if (typeof key !== 'string' || !key) return false;
    const teamKey = this.registerOwnedTeam(teamName);
    if (!teamKey) return false;
    const keys = this._consumedKeysByTeam.get(teamKey) ?? [];
    if (keys.includes(key)) return false;
    keys.push(key);
    if (keys.length > TEAM_CONSUMED_KEY_LIMIT) {
      keys.splice(0, keys.length - TEAM_CONSUMED_KEY_LIMIT);
    }
    this._consumedKeysByTeam.set(teamKey, keys);
    return true;
  }

  toJSON() {
    const consumedKeysByTeam = {};
    for (const [teamName, keys] of this._consumedKeysByTeam.entries()) {
      if (!this._ownedTeams.has(teamName)) continue;
      consumedKeysByTeam[teamName] = keys.slice(-TEAM_CONSUMED_KEY_LIMIT);
    }
    return {
      version: TEAM_POLL_STATE_VERSION,
      ownedTeams: this.listOwnedTeams().sort(),
      consumedKeysByTeam,
    };
  }
}
