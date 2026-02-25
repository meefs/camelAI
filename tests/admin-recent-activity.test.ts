import { describe, expect, it } from 'vitest';
import {
  deriveCheapRecentActivityCounts,
  deriveCheapRecentCount,
} from '@/lib/admin-recent-activity';

describe('deriveCheapRecentCount', () => {
  it('returns exact count when recent results are below the page limit', () => {
    expect(deriveCheapRecentCount(3, 10)).toBe(3);
    expect(deriveCheapRecentCount(0, 10)).toBe(0);
  });

  it('returns null when recent results hit the limit (total is unknown)', () => {
    expect(deriveCheapRecentCount(10, 10)).toBeNull();
    expect(deriveCheapRecentCount(12, 10)).toBeNull();
  });

  it('normalizes invalid inputs defensively', () => {
    expect(deriveCheapRecentCount(Number.NaN, 10)).toBe(0);
    expect(deriveCheapRecentCount(2.9, 2.2)).toBeNull();
  });
});

describe('deriveCheapRecentActivityCounts', () => {
  it('derives thread/app counts independently from recent list sizes', () => {
    expect(
      deriveCheapRecentActivityCounts({
        recentThreadCount: 5,
        threadLimit: 10,
        recentAppCount: 10,
        appLimit: 10,
      })
    ).toEqual({
      threadCount: 5,
      appCount: null,
    });
  });
});
