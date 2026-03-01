const MINUTE_MS = 60 * 1000;
const SEARCH_WINDOW_MS = 5 * 366 * 24 * 60 * 60 * 1000; // 5 years

interface ParsedCronField {
  raw: string;
  values: boolean[];
  wildcard: boolean;
}

export interface ParsedCronExpression {
  expression: string;
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

function parseInteger(value: string, fieldName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${fieldName} value "${value}"`);
  }
  return Number.parseInt(value, 10);
}

function createValueArray(max: number): boolean[] {
  return Array.from({ length: max + 1 }, () => false);
}

function parseCronField(
  rawField: string,
  min: number,
  max: number,
  fieldName: string,
  options?: { allowSevenAsSunday?: boolean }
): ParsedCronField {
  const field = rawField.trim();
  if (!field) {
    throw new Error(`Missing ${fieldName} field`);
  }

  const values = createValueArray(max);
  const tokens = field.split(',');
  if (tokens.length === 0) {
    throw new Error(`Invalid ${fieldName} field "${field}"`);
  }

  const allowSevenAsSunday = options?.allowSevenAsSunday ?? false;

  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) {
      throw new Error(`Invalid ${fieldName} token in "${field}"`);
    }

    const parts = token.split('/');
    if (parts.length > 2) {
      throw new Error(`Invalid ${fieldName} token "${token}"`);
    }
    const [basePart, stepPart] = parts;

    const step = stepPart ? parseInteger(stepPart, `${fieldName} step`) : 1;
    if (step <= 0) {
      throw new Error(`Invalid ${fieldName} step "${stepPart}"`);
    }

    let rangeStart: number;
    let rangeEnd: number;

    if (basePart === '*') {
      rangeStart = min;
      rangeEnd = max;
    } else if (basePart.includes('-')) {
      const [rawStart, rawEnd, ...rest] = basePart.split('-');
      if (rest.length > 0 || !rawStart || !rawEnd) {
        throw new Error(`Invalid ${fieldName} range "${basePart}"`);
      }
      rangeStart = parseInteger(rawStart, fieldName);
      rangeEnd = parseInteger(rawEnd, fieldName);
      if (rangeStart > rangeEnd) {
        throw new Error(`Invalid ${fieldName} range "${basePart}"`);
      }
    } else {
      rangeStart = parseInteger(basePart, fieldName);
      rangeEnd = rangeStart;
    }

    if (rangeStart < min || rangeEnd > max) {
      throw new Error(`${fieldName} field out of range "${token}"`);
    }

    for (let value = rangeStart; value <= rangeEnd; value += step) {
      const normalizedValue = allowSevenAsSunday && value === 7 ? 0 : value;
      values[normalizedValue] = true;
    }
  }

  if (!values.some(Boolean)) {
    throw new Error(`No values selected for ${fieldName}`);
  }

  return {
    raw: field,
    values,
    wildcard: field === '*',
  };
}

function getNextAllowed(values: boolean[], start: number, max: number): number | null {
  for (let value = start; value <= max; value += 1) {
    if (values[value]) return value;
  }
  return null;
}

function getFirstAllowed(values: boolean[], min: number, max: number): number {
  const value = getNextAllowed(values, min, max);
  if (value === null) {
    throw new Error('No allowed values in cron field');
  }
  return value;
}

function toNextMinute(fromMs: number): number {
  return Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
}

function matchesDay(parsed: ParsedCronExpression, date: Date): boolean {
  const dayOfMonth = date.getUTCDate();
  const dayOfWeek = date.getUTCDay();
  const domMatches = Boolean(parsed.dayOfMonth.values[dayOfMonth]);
  const dowMatches = Boolean(parsed.dayOfWeek.values[dayOfWeek]);

  // Vixie cron semantics:
  // - If either DOM or DOW is "*", the other field decides.
  // - If both are restricted, either match is accepted.
  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return true;
  if (parsed.dayOfMonth.wildcard) return dowMatches;
  if (parsed.dayOfWeek.wildcard) return domMatches;
  return domMatches || dowMatches;
}

function jumpToNextAllowedMonth(parsed: ParsedCronExpression, current: Date): number {
  const currentMonth = current.getUTCMonth() + 1;
  const nextMonthThisYear = getNextAllowed(parsed.month.values, currentMonth + 1, 12);
  if (nextMonthThisYear !== null) {
    current.setUTCMonth(nextMonthThisYear - 1, 1);
    current.setUTCHours(0, 0, 0, 0);
    return current.getTime();
  }

  const firstMonth = getFirstAllowed(parsed.month.values, 1, 12);
  current.setUTCFullYear(current.getUTCFullYear() + 1, firstMonth - 1, 1);
  current.setUTCHours(0, 0, 0, 0);
  return current.getTime();
}

function jumpToNextAllowedHour(parsed: ParsedCronExpression, current: Date): number {
  const currentHour = current.getUTCHours();
  const nextHour = getNextAllowed(parsed.hour.values, currentHour + 1, 23);
  if (nextHour !== null) {
    current.setUTCHours(nextHour, 0, 0, 0);
    return current.getTime();
  }

  const firstHour = getFirstAllowed(parsed.hour.values, 0, 23);
  current.setUTCDate(current.getUTCDate() + 1);
  current.setUTCHours(firstHour, 0, 0, 0);
  return current.getTime();
}

function jumpToNextAllowedMinute(parsed: ParsedCronExpression, current: Date): number {
  const currentMinute = current.getUTCMinutes();
  const nextMinute = getNextAllowed(parsed.minute.values, currentMinute + 1, 59);
  if (nextMinute !== null) {
    current.setUTCMinutes(nextMinute, 0, 0);
    return current.getTime();
  }

  const firstMinute = getFirstAllowed(parsed.minute.values, 0, 59);
  current.setUTCHours(current.getUTCHours() + 1, firstMinute, 0, 0);
  return current.getTime();
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const normalized = expression.trim().replace(/\s+/g, ' ');
  const parts = normalized.split(' ');
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expression}". Expected 5 fields: minute hour day-of-month month day-of-week`
    );
  }

  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts;
  return {
    expression: normalized,
    minute: parseCronField(minuteRaw, 0, 59, 'minute'),
    hour: parseCronField(hourRaw, 0, 23, 'hour'),
    dayOfMonth: parseCronField(domRaw, 1, 31, 'day-of-month'),
    month: parseCronField(monthRaw, 1, 12, 'month'),
    dayOfWeek: parseCronField(dowRaw, 0, 7, 'day-of-week', { allowSevenAsSunday: true }),
  };
}

export function matchesCronExpression(
  expression: ParsedCronExpression | string,
  atMs: number
): boolean {
  const parsed = typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const date = new Date(atMs);
  const month = date.getUTCMonth() + 1;
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();

  if (!parsed.month.values[month]) return false;
  if (!parsed.hour.values[hour]) return false;
  if (!parsed.minute.values[minute]) return false;
  return matchesDay(parsed, date);
}

export function getNextCronRunAt(
  expression: ParsedCronExpression | string,
  fromMs: number
): number | null {
  const parsed = typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const limit = fromMs + SEARCH_WINDOW_MS;
  let candidate = toNextMinute(fromMs);

  while (candidate <= limit) {
    const date = new Date(candidate);
    const month = date.getUTCMonth() + 1;
    if (!parsed.month.values[month]) {
      candidate = jumpToNextAllowedMonth(parsed, date);
      continue;
    }

    if (!matchesDay(parsed, date)) {
      date.setUTCDate(date.getUTCDate() + 1);
      date.setUTCHours(0, 0, 0, 0);
      candidate = date.getTime();
      continue;
    }

    const hour = date.getUTCHours();
    if (!parsed.hour.values[hour]) {
      candidate = jumpToNextAllowedHour(parsed, date);
      continue;
    }

    const minute = date.getUTCMinutes();
    if (!parsed.minute.values[minute]) {
      candidate = jumpToNextAllowedMinute(parsed, date);
      continue;
    }

    if (matchesCronExpression(parsed, candidate)) {
      return candidate;
    }

    candidate += MINUTE_MS;
  }

  return null;
}
