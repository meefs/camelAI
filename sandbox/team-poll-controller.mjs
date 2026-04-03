import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import {
  TeamPollState,
  normalizeTeamDirName,
  messageKey,
  inboxMessageSender,
  inboxMessageText,
  formatTeammateMessage,
  toolResultToolUseId,
  teamNameFromTeamCreateResultContent,
} from './team-poll-state.mjs';

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_POLL_MAX_ITERATIONS = 600; // 5 min cap
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const TEAMS_BASE_DIR = () => join(CLAUDE_CONFIG_DIR, 'teams');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function discoverTeams() {
  try {
    const entries = await readdir(TEAMS_BASE_DIR(), { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

async function readTeamConfig(teamName) {
  try {
    const configPath = join(TEAMS_BASE_DIR(), teamName, 'config.json');
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readInboxMessages(teamName, agentName) {
  try {
    const inboxPath = join(TEAMS_BASE_DIR(), teamName, 'inboxes', `${agentName}.json`);
    const raw = await readFile(inboxPath, 'utf-8');
    const messages = JSON.parse(raw);
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

export class TeamPollingController {
  constructor({
    threadId,
    trace,
    canPoll,
    injectMessage,
    broadcastStreamingResumed,
    onSettled,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollMaxIterations = DEFAULT_POLL_MAX_ITERATIONS,
  }) {
    this.threadId = threadId;
    this.trace = typeof trace === 'function' ? trace : () => {};
    this.canPoll = typeof canPoll === 'function' ? canPoll : () => false;
    this.injectMessage = injectMessage;
    this.broadcastStreamingResumed = broadcastStreamingResumed;
    this.onSettled = onSettled;
    this.pollIntervalMs = pollIntervalMs;
    this.pollMaxIterations = pollMaxIterations;

    this._state = new TeamPollState();
    this._stateLoaded = false;
    this._statePersistChain = Promise.resolve();

    this._pendingTeamCreateToolUseIds = new Map();
    this._pollRequested = false;
    this._runPromise = null;
    this._stopped = false;
  }

  isRunning() {
    return this._runPromise !== null;
  }

  shutdown() {
    this._stopped = true;
    this._pollRequested = false;
  }

  statePath() {
    const projectPath = process.cwd().replace(/\//g, '-');
    return join(CLAUDE_CONFIG_DIR, 'projects', projectPath, `${this.threadId}.team-poll-state.json`);
  }

  _trace(event, details = {}) {
    this.trace(event, {
      threadId: this.threadId,
      ...details,
    });
  }

  async init() {
    if (this._stateLoaded) return;
    this._stateLoaded = true;
    if (!this.threadId) return;

    const statePath = this.statePath();
    try {
      const raw = await readFile(statePath, 'utf-8');
      const parsed = JSON.parse(raw);
      this._state = new TeamPollState(parsed);
      this._trace('team_poll_state_loaded', {
        statePath,
        ownedTeams: this._state.listOwnedTeams(),
      });
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : undefined;
      if (code !== 'ENOENT') {
        console.error(`[ControlPlane] failed to load team poll state thread=${this.threadId}:`, err);
      }
      this._trace('team_poll_state_defaulted', { statePath });
    }
  }

  _persistState(reason) {
    if (!this.threadId) return;
    const statePath = this.statePath();
    const payload = JSON.stringify(this._state.toJSON());
    this._statePersistChain = this._statePersistChain
      .catch(() => {})
      .then(async () => {
        try {
          await mkdir(dirname(statePath), { recursive: true });
          await writeFile(statePath, payload, 'utf-8');
          this._trace('team_poll_state_persisted', { reason, statePath });
        } catch (err) {
          console.error(`[ControlPlane] failed to persist team poll state thread=${this.threadId}:`, err);
        }
      });
  }

  _registerOwnedTeam(teamName, metadata = {}) {
    const normalizedTeamName = this._state.registerOwnedTeam(teamName);
    if (!normalizedTeamName) return '';
    this._trace('session_team_registered', {
      teamName,
      normalizedTeamName,
      ownedTeams: this._state.listOwnedTeams(),
      ...metadata,
    });
    this._persistState('owned_team_update');
    return normalizedTeamName;
  }

  _rememberConsumed(teamName, key, reason) {
    if (!key) return;
    const changed = this._state.markConsumed(teamName, key);
    if (changed) this._persistState(reason);
  }

  onSdkEvent(event) {
    if (!event || !Array.isArray(event.message?.content)) return;

    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block?.type !== 'tool_use' || block.name !== 'TeamCreate') continue;
        const requestedTeamName = typeof block.input?.team_name === 'string' ? block.input.team_name : '';
        if (!requestedTeamName) continue;
        if (typeof block.id !== 'string' || !block.id) continue;
        this._pendingTeamCreateToolUseIds.set(block.id, requestedTeamName);
        this._trace('team_create_pending', {
          toolUseId: block.id,
          requestedTeamName,
        });
      }
      return;
    }

    if (event.type !== 'user') return;
    for (const block of event.message.content) {
      if (block?.type !== 'tool_result') continue;
      const sourceToolUseId = toolResultToolUseId(block);
      if (!sourceToolUseId) continue;

      const pendingTeamName = this._pendingTeamCreateToolUseIds.get(sourceToolUseId);
      if (!pendingTeamName) continue;

      if (block?.is_error === true) {
        this._trace('team_create_result_error', {
          sourceToolUseId,
          pendingTeamName,
        });
        this._pendingTeamCreateToolUseIds.delete(sourceToolUseId);
        continue;
      }

      const canonicalTeamName = teamNameFromTeamCreateResultContent(block.content);
      const resolvedTeamName = canonicalTeamName || pendingTeamName;
      if (resolvedTeamName) {
        this._registerOwnedTeam(resolvedTeamName, {
          source: canonicalTeamName ? 'tool_result_canonical' : 'tool_result_fallback',
          sourceToolUseId,
          pendingTeamName,
        });
      }
      this._pendingTeamCreateToolUseIds.delete(sourceToolUseId);
    }
  }

  requestPoll() {
    if (this._stopped) return;
    this._pollRequested = true;
    if (!this._runPromise) {
      this._runPromise = this._runLoop().finally(() => {
        this._runPromise = null;
        if (this._stopped) return;
        if (this._pollRequested) {
          this.requestPoll();
          return;
        }
        this.onSettled?.();
      });
    }
  }

  async _runLoop() {
    try {
      await this.init();
      while (!this._stopped && this._pollRequested) {
        this._pollRequested = false;
        const injected = await this._pollOnce();
        if (injected) return;
      }
    } catch (err) {
      console.error(`[ControlPlane] team polling error thread=${this.threadId}:`, err);
    }
  }

  async _pollOnce() {
    const ownedTeams = this._state.listOwnedTeams();
    if (ownedTeams.length === 0) {
      this._trace('team_poll_no_owned_teams', { ownedTeams });
      return false;
    }

    for (let i = 0; i < this.pollMaxIterations; i++) {
      if (this._stopped || this._pollRequested || !this.canPoll()) return false;

      await sleep(this.pollIntervalMs);
      if (this._stopped || this._pollRequested || !this.canPoll()) return false;

      const allTeams = await discoverTeams();
      const teams = allTeams.filter(team => this._state.isOwnedTeam(team));
      if (teams.length === 0) continue;

      for (const teamName of teams) {
        const normalizedTeamName = normalizeTeamDirName(teamName);
        const config = await readTeamConfig(teamName);
        if (!Array.isArray(config?.members) || config.members.length === 0) continue;

        const leadName = config.members[0]?.name;
        if (!leadName) continue;

        const allMessages = await readInboxMessages(teamName, leadName);
        if (allMessages.length === 0) continue;

        const actionable = this._firstActionableMessage(normalizedTeamName, allMessages);
        if (!actionable) continue;

        const { msg, key } = actionable;
        this._trace('team_poll_message_found', {
          teamName,
          normalizedTeamName,
          sender: inboxMessageSender(msg),
          iteration: i,
        });

        this.broadcastStreamingResumed?.();
        await this.injectMessage(formatTeammateMessage(msg));
        this._rememberConsumed(normalizedTeamName, key, 'actionable_teammate_message');
        return true;
      }
    }

    this._trace('team_poll_complete');
    return false;
  }

  _firstActionableMessage(normalizedTeamName, messages) {
    for (const msg of messages) {
      if (msg?.read === true) continue;
      const key = messageKey(msg);
      if (!key) continue;
      if (this._state.hasConsumed(normalizedTeamName, key)) continue;

      const rawText = inboxMessageText(msg);
      if (rawText) {
        try {
          const parsed = JSON.parse(rawText);
          if (parsed?.type === 'idle_notification') {
            this._rememberConsumed(normalizedTeamName, key, 'idle_notification');
            continue;
          }
        } catch {
          // Non-JSON content is considered actionable.
        }
      }

      return { msg, key };
    }
    return null;
  }
}
