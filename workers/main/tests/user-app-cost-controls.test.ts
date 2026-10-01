import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceCronDO } from "../src/workspace-cron";
import { guardDurableObjectClass, installAlarmGuard } from "../src/user-app-alarm-guard-runtime.js";
import {
  USER_APP_ALARM_GUARD_MODULE,
  USER_APP_GUARD_ENTRY_MODULE,
  alarmGuardEntryModule,
  userAppCostControlsConfig,
  userAppCostControlsForScript,
  withUserAppCostControls,
} from "../src/user-app-cost-controls";

const testEnv = env as unknown as { WORKSPACE_CRON: DurableObjectNamespace<WorkspaceCronDO> };

// Any SQLite-backed test Durable Object with an alarm() handler works; the
// guard only touches its storage.
function freshObject() {
  return testEnv.WORKSPACE_CRON.get(testEnv.WORKSPACE_CRON.idFromName(`alarm-guard-${crypto.randomUUID()}`));
}

// A stand-in for a new instance of the same object: fresh JS wrapper and
// guard state, same underlying storage.
function storageView(storage: DurableObjectStorage, backend: "sql" | "kv") {
  return {
    get sql() {
      if (backend === "kv") throw new Error("This Durable Object is not backed by SQLite storage");
      return storage.sql;
    },
    get: (key: string) => storage.get(key),
    put: (key: string, value: unknown) => storage.put(key, value),
    setAlarm: vi.fn(async (_time: number | Date) => undefined),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DAY_MS = 86_400_000;
const JITTER_MS = 300_000;

function nextUtcMidnight(now = Date.now()) {
  return (Math.floor(now / DAY_MS) + 1) * DAY_MS;
}

function expectDeferredToNextDay(time: unknown, now = Date.now()) {
  expect(time).toBeGreaterThanOrEqual(nextUtcMidnight(now));
  expect(time).toBeLessThanOrEqual(nextUtcMidnight(now) + JITTER_MS);
}

describe("alarm guard runtime", () => {
  it("patches setAlarm on real Durable Object storage and clamps Date and number times", async () => {
    await runInDurableObject(freshObject(), async (_instance, state) => {
      installAlarmGuard(state.storage, { minIntervalMs: 30_000, dailyBudget: 10 });

      const beforeDate = Date.now();
      await state.storage.setAlarm(new Date(beforeDate + 200));
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(beforeDate + 30_000);

      const beforeNumber = Date.now();
      await state.storage.setAlarm(beforeNumber + 200);
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(beforeNumber + 30_000);

      // Times already past the minimum are left alone.
      const later = Date.now() + 3_600_000;
      await state.storage.setAlarm(later);
      expect(await state.storage.getAlarm()).toBe(later);

      await state.storage.deleteAlarm();
    });
  });

  it("persists the daily budget in SQLite across re-instantiation and defers once spent", async () => {
    await runInDurableObject(freshObject(), async (_instance, state) => {
      const first = storageView(state.storage, "sql");
      const firstSetAlarm = first.setAlarm;
      const guard = installAlarmGuard(first, { minIntervalMs: 0, dailyBudget: 2 })!;
      await guard.recordAlarm();
      await first.setAlarm(Date.now() + 1_000);
      expect(firstSetAlarm).toHaveBeenCalledTimes(1);

      const second = storageView(state.storage, "sql");
      const secondSetAlarm = second.setAlarm;
      const secondGuard = installAlarmGuard(second, { minIntervalMs: 0, dailyBudget: 2 })!;
      await second.setAlarm(Date.now() + 1_000);
      expect(secondSetAlarm).toHaveBeenCalledTimes(1);
      await secondGuard.recordAlarm();

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const third = storageView(state.storage, "sql");
      const thirdSetAlarm = third.setAlarm;
      installAlarmGuard(third, { minIntervalMs: 0, dailyBudget: 2 });
      await third.setAlarm(Date.now() + 1_000);
      await third.setAlarm(new Date(Date.now() + 1_000));
      expect(thirdSetAlarm).toHaveBeenCalledTimes(2);
      expectDeferredToNextDay(thirdSetAlarm.mock.calls[0]![0]);
      expectDeferredToNextDay(thirdSetAlarm.mock.calls[1]![0]);
      expect(warn).toHaveBeenCalledTimes(1);

      expect(state.storage.sql.exec("SELECT count FROM __camelai_guard WHERE key = 'alarms'").one().count).toBe(2);
      // KV-API reads never see the guard's SQLite row.
      expect([...(await state.storage.list()).keys()]).not.toContain("__camelai_guard");
    });
  });

  it("falls back to a KV key for classes without SQLite storage", async () => {
    await runInDurableObject(freshObject(), async (_instance, state) => {
      const first = storageView(state.storage, "kv");
      const guard = installAlarmGuard(first, { minIntervalMs: 0, dailyBudget: 1 })!;
      await guard.recordAlarm();
      expect(await state.storage.get("__camelai_guard")).toMatchObject({ count: 1 });

      const second = storageView(state.storage, "kv");
      const originalSetAlarm = second.setAlarm;
      installAlarmGuard(second, { minIntervalMs: 0, dailyBudget: 1 });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await second.setAlarm(Date.now() + 1_000);
      expectDeferredToNextDay(originalSetAlarm.mock.calls[0]![0]);
    });
  });

  it("passes through over-budget requests that are already past the next UTC midnight", async () => {
    await runInDurableObject(freshObject(), async (_instance, state) => {
      const view = storageView(state.storage, "sql");
      const setAlarm = view.setAlarm;
      const guard = installAlarmGuard(view, { minIntervalMs: 0, dailyBudget: 1 })!;
      await guard.recordAlarm();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const later = nextUtcMidnight() + 3_600_000;
      await view.setAlarm(later);
      await view.setAlarm(new Date(later));
      expect(setAlarm.mock.calls.map((call) => call[0])).toEqual([later, later]);
    });
  });

  it("jitters deferred alarms per object, stably, within the window", async () => {
    await runInDurableObject(freshObject(), async (_instance, state) => {
      const deferredFor = async (objectId: string) => {
        const view = storageView(state.storage, "sql");
        const setAlarm = view.setAlarm;
        const guard = installAlarmGuard(view, { minIntervalMs: 0, dailyBudget: 1 }, objectId)!;
        await guard.recordAlarm();
        await view.setAlarm(Date.now() + 1_000);
        return setAlarm.mock.calls[0]![0] as number;
      };
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const offsets = await Promise.all(["a".repeat(64), "b".repeat(64), "c".repeat(64), "a".repeat(64)]
        .map(async (id) => (await deferredFor(id)) - nextUtcMidnight()));
      for (const offset of offsets) {
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThanOrEqual(JITTER_MS);
      }
      expect(offsets[3]).toBe(offsets[0]);
      expect(new Set(offsets.slice(0, 3)).size).toBeGreaterThan(1);
    });
  });

  it("resets the budget at the next UTC day", async () => {
    await runInDurableObject(freshObject(), async (_instance, state) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-27T23:59:00Z"));
      const view = storageView(state.storage, "sql");
      const setAlarm = view.setAlarm;
      const guard = installAlarmGuard(view, { minIntervalMs: 0, dailyBudget: 2 })!;
      await guard.recordAlarm();
      await guard.recordAlarm();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await view.setAlarm(Date.now() + 1_000);
      expectDeferredToNextDay(setAlarm.mock.calls[0]![0]);

      // The deferred alarm fires on the new day with a fresh budget.
      vi.setSystemTime(new Date("2026-09-28T00:02:00Z"));
      await guard.recordAlarm();
      expect(state.storage.sql.exec("SELECT day, count FROM __camelai_guard WHERE key = 'alarms'").one())
        .toEqual({ day: Math.floor(Date.now() / DAY_MS), count: 1 });
      const later = Date.now() + 1_000;
      await view.setAlarm(later);
      expect(setAlarm).toHaveBeenLastCalledWith(later, undefined);
    });
  });

  it("guards setAlarm inside storage.transaction()", async () => {
    const txnSetAlarm = vi.fn(async (_time: number) => undefined);
    const storage = {
      get sql(): never {
        throw new Error("no sql");
      },
      get: async () => undefined,
      put: async () => undefined,
      setAlarm: vi.fn(async () => undefined),
      transaction: async (closure: (txn: { setAlarm: typeof txnSetAlarm }) => Promise<void>) =>
        closure({ setAlarm: txnSetAlarm }),
    };
    installAlarmGuard(storage, { minIntervalMs: 60_000, dailyBudget: 0 });
    const now = Date.now();
    await storage.transaction(async (txn) => {
      await txn.setAlarm(now);
    });
    expect(txnSetAlarm.mock.calls[0]![0]).toBeGreaterThanOrEqual(now + 60_000);
  });

  it("wraps a Durable Object class: patches storage before the user constructor and counts alarms", async () => {
    await runInDurableObject(freshObject(), async (_instance, state) => {
      const view = storageView(state.storage, "sql");
      const originalSetAlarm = view.setAlarm;
      const alarmRuns: unknown[] = [];

      class UserObject {
        ctx: { storage: typeof view };
        constructor(ctx: { storage: typeof view }) {
          this.ctx = ctx;
          // A constructor that arms its own loop sees the guarded setAlarm.
          void ctx.storage.setAlarm(Date.now() + 200);
        }
        static kind = "user";
        async alarm(info: unknown) {
          alarmRuns.push(info);
          await this.ctx.storage.setAlarm(Date.now() + 200);
        }
      }

      const Guarded = guardDurableObjectClass(UserObject, { minIntervalMs: 5_000, dailyBudget: 2 });
      expect(Guarded.name).toBe("UserObject");
      expect(Guarded.kind).toBe("user");
      const before = Date.now();
      const object = new Guarded({ storage: view }, {});
      expect(object).toBeInstanceOf(UserObject);
      await vi.waitFor(() => expect(originalSetAlarm).toHaveBeenCalledTimes(1));
      expect(originalSetAlarm.mock.calls[0]![0]).toBeGreaterThanOrEqual(before + 5_000);

      vi.spyOn(console, "warn").mockImplementation(() => {});
      await object.alarm({ retryCount: 0 });
      await object.alarm({ retryCount: 0 });
      expect(alarmRuns).toHaveLength(2);
      // The second alarm spent the budget, so its re-arm moved to tomorrow.
      expect(originalSetAlarm).toHaveBeenCalledTimes(3);
      expect(originalSetAlarm.mock.calls[1]![0]).toBeLessThan(nextUtcMidnight());
      expectDeferredToNextDay(originalSetAlarm.mock.calls[2]![0]);
    });
  });

  it("passes non-class exports through untouched", () => {
    expect(guardDurableObjectClass(undefined, {})).toBeUndefined();
  });
});

describe("withUserAppCostControls", () => {
  const config = userAppCostControlsConfig({});
  const toModule = (name: string, content: string) => ({ name, contentType: "application/javascript+module", content });
  const userModules = [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }];

  it("defaults to a 30s alarm interval, 3,000 alarms/day and 15s of CPU", () => {
    expect(config).toEqual({ alarmMinIntervalMs: 30_000, alarmDailyBudget: 3_000, cpuMs: 15_000, cpuMsOverrides: new Map() });
    expect(userAppCostControlsConfig({
      USER_APP_ALARM_MIN_INTERVAL_MS: "5000",
      USER_APP_ALARM_DAILY_BUDGET: "0",
      USER_APP_CPU_MS: "garbage",
    })).toEqual({ alarmMinIntervalMs: 5_000, alarmDailyBudget: 0, cpuMs: 15_000, cpuMsOverrides: new Map() });
  });

  it("resolves per-app CPU overrides and ignores malformed entries once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = ` heavy--acme=30000,\n unlimited--acme=0  bad--acme=1.5,=5 noequals--acme heavy--acme=x neg--acme=-1 ,${crypto.randomUUID()}=`;
    const withOverrides = userAppCostControlsConfig({ USER_APP_CPU_MS: "2000", USER_APP_CPU_MS_OVERRIDES: raw });
    userAppCostControlsConfig({ USER_APP_CPU_MS_OVERRIDES: raw });

    expect(withOverrides.cpuMsOverrides).toEqual(new Map([["heavy--acme", 30_000], ["unlimited--acme", 0]]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ ignored: expect.arrayContaining(["bad--acme=1.5", "=5", "noequals--acme", "heavy--acme=x", "neg--acme=-1"]) });
    expect(userAppCostControlsForScript(withOverrides, "heavy--acme").cpuMs).toBe(30_000);
    expect(userAppCostControlsForScript(withOverrides, "unlimited--acme").cpuMs).toBe(0);
    expect(userAppCostControlsForScript(withOverrides, "other--acme").cpuMs).toBe(2_000);
    expect(userAppCostControlsConfig({ USER_APP_CPU_MS_OVERRIDES: "  " }).cpuMsOverrides.size).toBe(0);
    warn.mockRestore();
  });

  it("wraps local Durable Object classes behind a generated entry module", () => {
    const result = withUserAppCostControls({
      main_module: "index.js",
      bindings: [
        { type: "durable_object_namespace", name: "ROOM", class_name: "Room" },
        { type: "durable_object_namespace", name: "ROOM_AGAIN", class_name: "Room" },
        { type: "durable_object_namespace", name: "OTHER", class_name: "Remote", script_name: "other-app" },
      ],
      limits: { subrequests: 50 },
    }, userModules, config, toModule);

    expect(result.metadata.main_module).toBe(USER_APP_GUARD_ENTRY_MODULE);
    expect(result.metadata.limits).toEqual({ subrequests: 50, cpu_ms: 15_000 });
    expect(result.modules.map((module) => module.name)).toEqual([
      "index.js",
      USER_APP_ALARM_GUARD_MODULE,
      USER_APP_GUARD_ENTRY_MODULE,
    ]);
    const entry = result.modules.find((module) => module.name === USER_APP_GUARD_ENTRY_MODULE)!.content;
    expect(entry).toBe(alarmGuardEntryModule("index.js", ["Room"], config));
    expect(entry).toContain(`export * from "./index.js";`);
    expect(entry).toContain(`export default app.default;`);
    expect(entry).toContain(`export const Room = guardDurableObjectClass(app.Room, options);`);
    expect(entry).not.toContain("Remote");
    const runtime = result.modules.find((module) => module.name === USER_APP_ALARM_GUARD_MODULE)!.content;
    expect(runtime).toContain("export function guardDurableObjectClass");
    expect(runtime).not.toMatch(/^\s*import /m);
  });

  it("only sets the CPU limit for apps without Durable Objects", () => {
    const result = withUserAppCostControls({ main_module: "index.js", bindings: [] }, userModules, config, toModule);
    expect(result.metadata).toEqual({ main_module: "index.js", bindings: [], limits: { cpu_ms: 15_000 } });
    expect(result.modules).toBe(userModules);
  });

  it("omits limits.cpu_ms entirely when an app's CPU limit is 0", () => {
    const unlimited = userAppCostControlsForScript(
      userAppCostControlsConfig({ USER_APP_CPU_MS_OVERRIDES: "demo--acme=0" }),
      "demo--acme",
    );
    expect(withUserAppCostControls({ main_module: "index.js", bindings: [] }, userModules, unlimited, toModule).metadata)
      .toEqual({ main_module: "index.js", bindings: [] });
    expect(withUserAppCostControls(
      { main_module: "index.js", bindings: [], limits: { cpu_ms: 1_000, subrequests: 50 } },
      userModules,
      unlimited,
      toModule,
    ).metadata).toEqual({ main_module: "index.js", bindings: [], limits: { subrequests: 50 } });
  });

  it("is idempotent for bundles that already carry the guard", () => {
    const metadata = {
      main_module: "index.js",
      bindings: [{ type: "durable_object_namespace", name: "ROOM", class_name: "Room" }],
    };
    const once = withUserAppCostControls(metadata, userModules, config, toModule);
    const twice = withUserAppCostControls(once.metadata, once.modules, config, toModule);
    expect(twice.modules).toEqual(once.modules);
    expect(twice.metadata).toEqual(once.metadata);
  });

  it("can be disabled with zeroes", () => {
    const off = { alarmMinIntervalMs: 0, alarmDailyBudget: 0, cpuMs: 0, cpuMsOverrides: new Map() };
    const metadata = {
      main_module: "index.js",
      bindings: [{ type: "durable_object_namespace", name: "ROOM", class_name: "Room" }],
    };
    const result = withUserAppCostControls(metadata, userModules, off, toModule);
    expect(result.metadata).toEqual(metadata);
    expect(result.modules).toBe(userModules);
  });

  it("rejects class names that are not safe identifiers", () => {
    expect(() => alarmGuardEntryModule("index.js", ["Room; import('x')"], config)).toThrow(/Unsafe Durable Object class name/);
  });
});
