// Alarm throttle injected into every deployed user app that declares Durable
// Objects (see user-app-cost-controls.ts). This file ships verbatim as an
// uploaded module, so it must stay plain, dependency-free JavaScript.
//
// It patches setAlarm on the object's real storage before the user constructor
// runs (the runtime rejects a proxied ctx), clamps every requested alarm to at
// least now + minIntervalMs, and counts alarm invocations per UTC day in the
// object's own storage. Once the daily budget is spent, setAlarm defers to the
// start of the next UTC day plus a per-object jitter, so the object keeps
// working tomorrow without every throttled object waking at 00:00.

const GUARD_NAME = "__camelai_guard";
const DAY_MS = 86_400_000;
const DEFAULT_DEFER_JITTER_MS = 300_000;

// Stable per-object offset in [0, maxMs] (FNV-1a of the object id).
function jitterFor(key, maxMs) {
  if (!maxMs) return 0;
  if (!key) return Math.floor(Math.random() * (maxMs + 1));
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % (maxMs + 1);
}

function utcDay() {
  return Math.floor(Date.now() / DAY_MS);
}

function sqlStorage(storage) {
  try {
    const sql = storage.sql;
    // KV-backed classes throw on first SQL use rather than on property access.
    void sql.databaseSize;
    return sql;
  } catch {
    return null;
  }
}

export function installAlarmGuard(storage, options = {}, objectId) {
  if (!storage || typeof storage.setAlarm !== "function") return null;
  if (storage[GUARD_NAME]) return storage[GUARD_NAME];
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 0);
  const dailyBudget = Math.max(0, Math.floor(Number(options.dailyBudget) || 0));
  const deferJitterMs = jitterFor(
    objectId,
    Math.max(0, Math.floor(Number(options.deferJitterMs ?? DEFAULT_DEFER_JITTER_MS) || 0)),
  );
  let sql;
  let state = null;
  let loading = null;
  let warnedDay = -1;

  function sqlOrNull() {
    if (sql === undefined) sql = sqlStorage(storage);
    return sql;
  }

  // Returns the current day's state synchronously when possible (SQLite, or
  // KV already loaded) so setAlarm keeps its ordering relative to later
  // storage calls; otherwise returns undefined and the caller awaits load().
  function current() {
    const today = utcDay();
    if (!state) {
      const db = sqlOrNull();
      if (!db) return undefined;
      let row;
      try {
        row = db.exec(`SELECT day, count FROM ${GUARD_NAME} WHERE key = 'alarms'`).toArray()[0];
      } catch {
        row = undefined;
      }
      state = row ? { day: Number(row.day), count: Number(row.count) } : { day: today, count: 0 };
    }
    if (state.day !== today) state = { day: today, count: 0 };
    return state;
  }

  async function load() {
    const ready = current();
    if (ready) return ready;
    loading ??= storage.get(GUARD_NAME).then((stored) => {
      state ??= stored && typeof stored === "object"
        ? { day: Number(stored.day), count: Number(stored.count) }
        : { day: utcDay(), count: 0 };
    }).finally(() => {
      loading = null;
    });
    await loading;
    return current();
  }

  function save() {
    const db = sqlOrNull();
    if (db) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${GUARD_NAME} (key TEXT PRIMARY KEY, day INTEGER NOT NULL, count INTEGER NOT NULL)`);
      db.exec(
        `INSERT INTO ${GUARD_NAME} (key, day, count) VALUES ('alarms', ?, ?) ON CONFLICT(key) DO UPDATE SET day = excluded.day, count = excluded.count`,
        state.day,
        state.count,
      );
      return undefined;
    }
    return storage.put(GUARD_NAME, { day: state.day, count: state.count });
  }

  function overBudget(s) {
    if (!dailyBudget || s.count < dailyBudget) return false;
    if (warnedDay !== s.day) {
      warnedDay = s.day;
      console.warn(`[camelai] Durable Object alarm budget of ${dailyBudget}/day reached; alarms are deferred to the next UTC day.`);
    }
    return true;
  }

  function clamp(scheduledTime) {
    const time = scheduledTime instanceof Date ? scheduledTime.getTime() : Number(scheduledTime);
    if (!Number.isFinite(time)) return scheduledTime;
    return Math.max(time, Date.now() + minIntervalMs);
  }

  // Requests already past the next UTC midnight need no deferral.
  function deferToNextDay(time, s) {
    const nextDay = (s.day + 1) * DAY_MS;
    if (typeof time !== "number" || time >= nextDay) return time;
    return nextDay + deferJitterMs;
  }

  function guardSetAlarm(target) {
    const setAlarm = target.setAlarm;
    function guardedSetAlarm(scheduledTime, alarmOptions) {
      const s = dailyBudget ? current() : null;
      if (s === undefined) return load().then(() => guardedSetAlarm(scheduledTime, alarmOptions));
      const time = clamp(scheduledTime);
      return setAlarm.call(target, s && overBudget(s) ? deferToNextDay(time, s) : time, alarmOptions);
    }
    Object.defineProperty(target, "setAlarm", { value: guardedSetAlarm, configurable: true, writable: true });
  }

  guardSetAlarm(storage);
  if (typeof storage.transaction === "function") {
    const transaction = storage.transaction;
    Object.defineProperty(storage, "transaction", {
      value(closure, ...rest) {
        return transaction.call(storage, (txn, ...args) => {
          if (txn && typeof txn.setAlarm === "function") guardSetAlarm(txn);
          return closure(txn, ...args);
        }, ...rest);
      },
      configurable: true,
      writable: true,
    });
  }

  const guard = {
    // Counts one alarm invocation (retries included) against today's budget.
    async recordAlarm() {
      if (!dailyBudget) return;
      const s = await load();
      s.count += 1;
      await save();
      // Commit before the handler runs: an invocation killed for exceeding
      // its CPU limit rolls back its unflushed writes, and those retries are
      // exactly the ones the budget must see.
      if (typeof storage.sync === "function") await storage.sync();
    },
    wrapAlarmHandler(instance) {
      const handler = instance.alarm;
      if (typeof handler !== "function") return;
      instance.alarm = async function alarm(...args) {
        await guard.recordAlarm();
        return handler.apply(this, args);
      };
    },
  };
  Object.defineProperty(storage, GUARD_NAME, { value: guard });
  return guard;
}

export function guardDurableObjectClass(Base, options) {
  if (typeof Base !== "function" || !Base.prototype) return Base;
  class Guarded extends Base {
    constructor(ctx, env, ...rest) {
      const guard = installAlarmGuard(ctx && ctx.storage, options, ctx && ctx.id && String(ctx.id));
      super(ctx, env, ...rest);
      if (guard) guard.wrapAlarmHandler(this);
    }
  }
  Object.defineProperty(Guarded, "name", { value: Base.name });
  return Guarded;
}
