import { describe, expect, it } from 'vitest';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import {
  getToolStatus,
  ratchetToolStatus,
  ratchetToolStatusForIdentity,
} from '@/components/tool-call/tool-status';

function makeTool(name: string = 'Read'): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool-1',
    name,
    input: {},
  };
}

function makeResult(overrides: Record<string, unknown> = {}): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'tool-1',
    content: 'ok',
    ...overrides,
  } as ToolResultBlock;
}

describe('getToolStatus', () => {
  it('returns running when no result exists yet', () => {
    expect(getToolStatus(makeTool(), undefined, [], false)).toBe('running');
  });

  it('returns complete when a result exists', () => {
    expect(getToolStatus(makeTool(), makeResult(), [makeResult()], false)).toBe('complete');
  });

  it('returns error when result is flagged as error', () => {
    const errorResult = makeResult({ is_error: true });
    expect(getToolStatus(makeTool(), errorResult, [errorResult], false)).toBe('error');
  });

  it('treats agent continuation as completion when result is temporarily missing', () => {
    expect(getToolStatus(makeTool(), undefined, [], true)).toBe('complete');
  });

  it('treats orphaned tool calls as complete after the assistant message finalizes', () => {
    expect(getToolStatus(makeTool(), undefined, [], false, false)).toBe('complete');
  });
});

describe('ratchetToolStatus', () => {
  it('does not allow complete status to regress back to running', () => {
    const next = ratchetToolStatus('complete', 'running');
    expect(next).toBe('complete');
  });

  it('does not allow error status to regress back to running', () => {
    const next = ratchetToolStatus('error', 'running');
    expect(next).toBe('error');
  });

  it('allows forward progress from running to complete', () => {
    const next = ratchetToolStatus('running', 'complete');
    expect(next).toBe('complete');
  });
});

describe('ratchetToolStatusForIdentity', () => {
  it('resets ratchet when tool identity changes', () => {
    const next = ratchetToolStatusForIdentity('complete', 'msg-1:tool:a', 'running', 'msg-2:tool:a');
    expect(next).toBe('running');
  });

  it('keeps ratchet when identity is unchanged', () => {
    const next = ratchetToolStatusForIdentity('complete', 'msg-1:tool:a', 'running', 'msg-1:tool:a');
    expect(next).toBe('complete');
  });
});
