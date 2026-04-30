import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useMentionTrigger } from '@/components/connection-mention-menu/use-mention-trigger';

function detect(value: string, caretPos = value.length) {
  return renderHook(() =>
    useMentionTrigger({
      value,
      caretPos,
      enabled: true,
    }),
  ).result.current;
}

describe('useMentionTrigger', () => {
  it('keeps the trigger open for natural spaced search phrases', () => {
    expect(detect('Use @sales db')).toMatchObject({
      open: true,
      query: 'sales db',
      triggerStart: 4,
      triggerEnd: 13,
    });
  });

  it('keeps slug-style queries open', () => {
    expect(detect('Use @sales_db')).toMatchObject({
      open: true,
      query: 'sales_db',
      triggerStart: 4,
      triggerEnd: 13,
    });
  });

  it('closes on hard boundaries', () => {
    expect(detect('Use @sales\ndb').open).toBe(false);
    expect(detect('Use @sales.db').open).toBe(false);
  });

  it('does not open for mid-word @ characters', () => {
    expect(detect('email@example.com').open).toBe(false);
  });
});
