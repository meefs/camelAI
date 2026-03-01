import { describe, expect, it } from 'vitest';
import { getNextCronRunAt, matchesCronExpression, parseCronExpression } from '../workers/main/src/cron-schedule';

describe('cron-schedule', () => {
  it('parses a valid expression and computes next run time', () => {
    const parsed = parseCronExpression('*/15 * * * *');
    const from = Date.UTC(2026, 1, 24, 10, 7, 13);
    const next = getNextCronRunAt(parsed, from);
    expect(next).toBe(Date.UTC(2026, 1, 24, 10, 15, 0));
  });

  it('supports day-of-week value 7 as Sunday', () => {
    const from = Date.UTC(2026, 1, 24, 10, 0, 0); // Tue Feb 24, 2026
    const next = getNextCronRunAt('0 9 * * 7', from);
    expect(next).toBe(Date.UTC(2026, 2, 1, 9, 0, 0)); // Sun Mar 1, 2026
  });

  it('uses Vixie-style OR semantics when both DOM and DOW are restricted', () => {
    const expression = '0 9 1 * 1';
    const monday = Date.UTC(2026, 1, 23, 9, 0, 0); // Monday, Feb 23, 2026
    const firstOfMonth = Date.UTC(2026, 2, 1, 9, 0, 0); // Sunday, Mar 1, 2026
    expect(matchesCronExpression(expression, monday)).toBe(true);
    expect(matchesCronExpression(expression, firstOfMonth)).toBe(true);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCronExpression('bad expression')).toThrow();
    expect(() => parseCronExpression('60 * * * *')).toThrow();
    expect(() => parseCronExpression('* * *')).toThrow();
  });
});
