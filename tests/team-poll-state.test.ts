import { describe, expect, it } from 'vitest';

import {
  TeamPollState,
  messageKey,
  normalizeTeamDirName,
  toolResultToolUseId,
  teamNameFromTeamCreateResultContent,
} from '../sandbox/team-poll-state.mjs';

describe('TeamPollState', () => {
  it('normalizes owned teams and survives round-trip serialization', () => {
    const state = new TeamPollState();

    state.registerOwnedTeam('My Team');
    state.registerOwnedTeam('my-team');
    state.registerOwnedTeam('My_Team');

    expect(state.listOwnedTeams()).toEqual(['my-team']);
    expect(state.isOwnedTeam('My Team')).toBe(true);
    expect(state.isOwnedTeam('my-team')).toBe(true);
    expect(state.isOwnedTeam('other-team')).toBe(false);

    const reloaded = new TeamPollState(state.toJSON());
    expect(reloaded.listOwnedTeams()).toEqual(['my-team']);
    expect(reloaded.isOwnedTeam('My Team')).toBe(true);
  });

  it('persists consumed message keys across reloads', () => {
    const state = new TeamPollState();
    state.registerOwnedTeam('Team Alpha');
    state.markConsumed('Team Alpha', 'k1');

    expect(state.hasConsumed('team-alpha', 'k1')).toBe(true);
    expect(state.hasConsumed('team-alpha', 'k2')).toBe(false);

    const reloaded = new TeamPollState(state.toJSON());
    expect(reloaded.hasConsumed('Team Alpha', 'k1')).toBe(true);
  });

  it('caps persisted consumed keys per team', () => {
    const state = new TeamPollState();
    state.registerOwnedTeam('big-team');
    for (let i = 0; i < 700; i += 1) {
      state.markConsumed('big-team', `k${i}`);
    }

    const payload = state.toJSON() as { consumedKeysByTeam: Record<string, string[]> };
    expect(payload.consumedKeysByTeam['big-team'].length).toBe(512);
    expect(payload.consumedKeysByTeam['big-team'][0]).toBe('k188');
    expect(payload.consumedKeysByTeam['big-team'][511]).toBe('k699');
  });
});

describe('team-poll helpers', () => {
  it('normalizes team names consistently', () => {
    expect(normalizeTeamDirName('My Team')).toBe('my-team');
    expect(normalizeTeamDirName('Team__A')).toBe('team--a');
  });

  it('builds stable message keys independent of read flag', () => {
    const unread = { from: 'agent-a', text: 'done', timestamp: '2026-03-01T12:00:00Z', read: false };
    const read = { from: 'agent-a', text: 'done', timestamp: '2026-03-01T12:00:00Z', read: true };
    expect(messageKey(unread)).toBe(messageKey(read));
  });

  it('extracts tool use id from tool_result content blocks', () => {
    expect(toolResultToolUseId({ tool_use_id: 'tool_1' })).toBe('tool_1');
    expect(toolResultToolUseId({ toolUseId: 'tool_2' })).toBe('');
    expect(toolResultToolUseId({ source_tool_use_id: 'tool_3' })).toBe('');
  });

  it('extracts canonical team names from TeamCreate tool results', () => {
    expect(teamNameFromTeamCreateResultContent('{"data":{"team_name":"My Team"}}')).toBe('My Team');
    expect(
      teamNameFromTeamCreateResultContent(
        '{"team_file_path":"/home/claude/.claude/teams/my-team-2/config.json"}'
      )
    ).toBe('my-team-2');
    expect(
      teamNameFromTeamCreateResultContent([
        {
          type: 'text',
          text: '{"team_file_path":"C:\\\\Users\\\\claude\\\\.claude\\\\teams\\\\my-team-3\\\\config.json"}',
        },
      ])
    ).toBe('my-team-3');
    expect(teamNameFromTeamCreateResultContent('not json')).toBe('');
  });
});
