import { describe, expect, it } from 'vitest';
import { formatAttributedUserMessage } from '../workers/main/src/chat-author-attribution';

describe('formatAttributedUserMessage', () => {
  it('uses the provided author identity for regular user messages', () => {
    expect(
      formatAttributedUserMessage('Can you review this diff?', {
        userName: 'Alice',
        userEmail: 'alice@example.com',
      })
    ).toBe('[Alice (alice@example.com)]: Can you review this diff?');

    expect(
      formatAttributedUserMessage('Can you review this diff?', {
        userName: 'Bob',
        userEmail: 'bob@example.com',
      })
    ).toBe('[Bob (bob@example.com)]: Can you review this diff?');
  });

  it('preserves camelai system messages while attributing visible user content', () => {
    expect(
      formatAttributedUserMessage(
        '<camelai system message>hidden context</camelai system message>\n\nHello there',
        {
          userName: 'Alice',
          userEmail: 'alice@example.com',
        }
      )
    ).toBe(
      '<camelai system message>hidden context</camelai system message>\n\n[Alice (alice@example.com)]: Hello there'
    );
  });

  it('does not prefix supported slash commands', () => {
    expect(
      formatAttributedUserMessage('/compact', {
        userName: 'Alice',
        userEmail: 'alice@example.com',
      })
    ).toBe('/compact');
  });
});
