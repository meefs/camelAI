export function boundedInteger(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number,
  field: string
): number;
export function boundedInteger(value: unknown, min: number, max: number, field: string): number;
export function boundedInteger(
  value: unknown,
  defaultValueOrMin: number,
  minOrMax: number,
  maxOrField: number | string,
  maybeField?: string
): number {
  const hasDefault = maybeField !== undefined;
  const defaultValue = hasDefault ? defaultValueOrMin : undefined;
  const min = hasDefault ? minOrMax : defaultValueOrMin;
  const max = hasDefault ? (maxOrField as number) : minOrMax;
  const field = hasDefault ? maybeField : (maxOrField as string);

  if (hasDefault && value == null) return defaultValue!;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw Object.assign(new Error(`${field} must be an integer from ${min} to ${max}.`), {
      status: 400,
    });
  }
  return parsed;
}
