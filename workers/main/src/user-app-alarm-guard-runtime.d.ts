export interface AlarmGuardOptions {
  minIntervalMs?: number;
  dailyBudget?: number;
  deferJitterMs?: number;
}

export interface AlarmGuard {
  recordAlarm(): Promise<void>;
  wrapAlarmHandler(instance: object): void;
}

interface GuardableStorage {
  setAlarm(scheduledTime: number | Date, options?: unknown): Promise<void>;
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  transaction?: unknown;
}

export function installAlarmGuard(
  storage: GuardableStorage | null | undefined,
  options?: AlarmGuardOptions,
  objectId?: string,
): AlarmGuard | null;

export function guardDurableObjectClass<T>(Base: T, options: AlarmGuardOptions): T;
