import { describe, expect, it } from 'vitest';
import { parseTeammateMessage } from '@/lib/teammate-message';

describe('parseTeammateMessage', () => {
  it('ignores connection mention annotations outside the teammate payload', () => {
    const raw = [
      '<teammate-message teammate_id="alice">',
      'I checked @camel.',
      '</teammate-message>',
      ' ⟦ref: other "Camel" id=conn_123⟧',
    ].join('\n');

    expect(parseTeammateMessage(raw)).toEqual({
      teammateId: 'alice',
      content: 'I checked @camel.',
    });
  });
});
