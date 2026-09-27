import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceCronDO } from "../src/workspace-cron";
import { guardDurableObjectClass, installAlarmGuard } from "../src/user-app-alarm-guard-runtime.js";
import {
  USER_APP_ALARM_GUARD_MODULE,
  USER_APP_GUARD_ENTRY_MODULE,
  alarmGuardEntryModule,
  userAppCostControlsConfig,
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
});

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

  it("persists the daily budget in SQLite across re-instantiation and no-ops once spent", async () => {
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
      expect(thirdSetAlarm).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();

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
      expect(originalSetAlarm).not.toHaveBeenCalled();
    });
  });

  it("resets the budget at the next UTC day", async () => {
    await runInDurableObject(freshObject(), async (_instance, state) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-27T23:59:00Z"));
      const view = storageView(state.storage, "sql");
      const setAlarm = view.setAlarm;
      const guard = installAlarmGuard(view, { minIntervalMs: 0, dailyBudget: 1 })!;
      await guard.recordAlarm();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await view.setAlarm(Date.now() + 1_000);
      expect(setAlarm).not.toHaveBeenCalled();

      vi.setSystemTime(new Date("2026-09-28T00:00:01Z"));
      await view.setAlarm(Date.now() + 1_000);
      expect(setAlarm).toHaveBeenCalledTimes(1);
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
      // The second alarm spent the budget, so it could not re-arm.
      expect(originalSetAlarm).toHaveBeenCalledTimes(2);
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

  it("defaults to a 30s alarm interval, 3,000 alarms/day and 1s of CPU", () => {
    expect(config).toEqual({ alarmMinIntervalMs: 30_000, alarmDailyBudget: 3_000, cpuMs: 1_000 });
    expect(userAppCostControlsConfig({
      USER_APP_ALARM_MIN_INTERVAL_MS: "5000",
      USER_APP_ALARM_DAILY_BUDGET: "0",
      USER_APP_CPU_MS: "garbage",
    })).toEqual({ alarmMinIntervalMs: 5_000, alarmDailyBudget: 0, cpuMs: 1_000 });
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
    expect(result.metadata.limits).toEqual({ subrequests: 50, cpu_ms: 1_000 });
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
    expect(result.metadata).toEqual({ main_module: "index.js", bindings: [], limits: { cpu_ms: 1_000 } });
    expect(result.modules).toBe(userModules);
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
    const off = { alarmMinIntervalMs: 0, alarmDailyBudget: 0, cpuMs: 0 };
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
