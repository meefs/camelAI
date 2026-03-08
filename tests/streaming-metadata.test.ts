import { describe, expect, it } from 'vitest';

import { extractToolEventMetaInfo } from '@/lib/streaming';

describe('extractToolEventMetaInfo', () => {
  it('reads camel-case parentToolUseID from top-level events', () => {
    const meta = extractToolEventMetaInfo({
      type: 'user',
      parentToolUseID: 'tool_parent_top_level',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool_child', content: 'ok' }],
      },
    } as never);

    expect(meta.sourceToolUseID).toBe('tool_parent_top_level');
    expect(meta.isMeta).toBe(false);
  });

  it('reads camel-case parentToolUseId from nested message payloads', () => {
    const meta = extractToolEventMetaInfo({
      type: 'user',
      message: {
        content: [{ type: 'text', text: 'sidechain prompt' }],
        parentToolUseId: 'tool_parent_nested',
      },
    } as never);

    expect(meta.sourceToolUseID).toBe('tool_parent_nested');
  });
});
