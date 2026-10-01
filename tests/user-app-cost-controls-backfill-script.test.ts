import { describe, expect, it, vi } from "vitest";

import {
  alarmInvocationsByScript,
  parseBackfillArgs,
  runBackfill,
  selectBackfillCandidates,
  summarizeBackfill,
  type BackfillDeps,
} from "../scripts/lib/user-app-cost-controls-backfill";
import {
  classifyCostControlsBackfill,
  userAppCostControlsConfig,
  userAppCostControlsForScript,
  type CostControlsBackfillGuardState,
} from "../workers/main/src/user-app-cost-controls-policy";

const config = userAppCostControlsConfig({});
const doBinding = { type: "durable_object_namespace", name: "ROOM", class_name: "Room" };

function guardState(name: string, overrides: Partial<CostControlsBackfillGuardState> = {}): CostControlsBackfillGuardState {
  return {
    app_id: `org:${name}`,
    org_id: "org",
    workspace_id: "ws",
    script_name: name,
    status: "active",
    artifact_cache_key: `deploy-artifacts/${name}.json`,
    ...overrides,
  };
}

describe("parseBackfillArgs", () => {
  it("defaults to a dry run and requires --env", () => {
    expect(parseBackfillArgs(["--env", "staging"])).toEqual({
      env: "staging",
      apply: false,
      scripts: null,
      limit: null,
      order: "name",
      delayMs: 2_000,
    });
    expect(() => parseBackfillArgs(["--apply"])).toThrow("--env staging|prod is required");
    expect(() => parseBackfillArgs(["--env", "dev"])).toThrow("--env must be staging or prod");
  });

  it("parses the allowlist, limit, order and delay in both flag styles", () => {
    expect(parseBackfillArgs(["--env=prod", "--apply", "--scripts", "a, b,a", "--limit=5", "--order", "alarm-spend", "--delay-ms=0"]))
      .toEqual({ env: "prod", apply: true, scripts: ["a", "b"], limit: 5, order: "alarm-spend", delayMs: 0 });
    expect(() => parseBackfillArgs(["--env", "prod", "--limit", "0"])).toThrow("--limit expects a positive integer");
    expect(() => parseBackfillArgs(["--env", "prod", "--order", "cost"])).toThrow("--order must be name or alarm-spend");
    expect(() => parseBackfillArgs(["--env", "prod", "--force"])).toThrow("Unknown argument: --force");
  });
});

describe("selectBackfillCandidates", () => {
  const alarms = alarmInvocationsByScript([
    { dimensions: { scriptName: "b", type: "alarm" }, sum: { requests: 10 } },
    { dimensions: { scriptName: "c", type: "alarm" }, sum: { requests: 500 } },
    { dimensions: { scriptName: "c", type: "fetch" }, sum: { requests: 9_999 } },
  ]);

  it("sums only alarm invocations per script", () => {
    expect([...alarms]).toEqual([["b", 10], ["c", 500]]);
  });

  it("orders by alarm spend, then name, and reports allowlisted scripts that are not live", () => {
    expect(selectBackfillCandidates(["a", "b", "c", "d"], { scripts: null, order: "alarm-spend" }, alarms))
      .toEqual({ candidates: ["c", "b", "a", "d"], notLive: [] });
    expect(selectBackfillCandidates(["d", "a"], { scripts: null, order: "name" }))
      .toEqual({ candidates: ["a", "d"], notLive: [] });
    expect(selectBackfillCandidates(["a", "b", "c"], { scripts: ["c", "gone", "a"], order: "alarm-spend" }, alarms))
      .toEqual({ candidates: ["c", "a"], notLive: ["gone"] });
  });
});

describe("classifyCostControlsBackfill", () => {
  const base = { live: true, leaseExpiresAt: null, config, now: 1_000 };

  it("skips in priority order and only applies when controls are missing", () => {
    expect(classifyCostControlsBackfill({ ...base, live: false, guardState: guardState("a") }))
      .toEqual({ action: "skip", reason: "not-live" });
    expect(classifyCostControlsBackfill({ ...base, guardState: null }))
      .toEqual({ action: "skip", reason: "no-artifact-record" });
    expect(classifyCostControlsBackfill({ ...base, guardState: guardState("a", { artifact_cache_key: null }) }))
      .toEqual({ action: "skip", reason: "no-artifact-record" });
    for (const status of ["suspending", "suspended", "error"]) {
      expect(classifyCostControlsBackfill({ ...base, guardState: guardState("a", { status }) }))
        .toEqual({ action: "skip", reason: "suspended" });
    }
    expect(classifyCostControlsBackfill({ ...base, guardState: guardState("a"), leaseExpiresAt: 2_000 }))
      .toEqual({ action: "skip", reason: "lease-held" });
    expect(classifyCostControlsBackfill({ ...base, guardState: guardState("a"), leaseExpiresAt: 500 }))
      .toEqual({ action: "apply" });
    expect(classifyCostControlsBackfill({
      ...base,
      guardState: guardState("a"),
      settings: { bindings: [{ type: "plain_text", name: "CAMELAI_USAGE_GUARD_QUARANTINE", text: "v" }] },
    })).toEqual({ action: "skip", reason: "quarantined" });
  });

  it("treats a script as already applied only with the current CPU limit and, for Durable Objects, the guard entry", () => {
    const decide = (settings: Record<string, unknown>, entrypoint: string | null) =>
      classifyCostControlsBackfill({ ...base, guardState: guardState("a"), settings, entrypoint });
    expect(decide({ limits: { cpu_ms: 15_000 } }, null)).toEqual({ action: "skip", reason: "already-applied" });
    expect(decide({ limits: { cpu_ms: 2000 } }, null)).toEqual({ action: "apply" });
    // Apps backfilled with the old 1 s default get the new one.
    expect(decide({ limits: { cpu_ms: 1000 } }, null)).toEqual({ action: "apply" });
    expect(decide({}, null)).toEqual({ action: "apply" });
    expect(decide({ limits: { cpu_ms: 15_000 }, bindings: [doBinding] }, "index.js")).toEqual({ action: "apply" });
    expect(decide({ limits: { cpu_ms: 15_000 }, bindings: [doBinding] }, "__camelai_entry.js"))
      .toEqual({ action: "skip", reason: "already-applied" });
    expect(decide({ limits: { cpu_ms: 15_000 }, bindings: [{ ...doBinding, script_name: "other" }] }, null))
      .toEqual({ action: "skip", reason: "already-applied" });
  });

  it("compares against the app's resolved CPU override, where 0 means no limit", () => {
    const overridden = userAppCostControlsConfig({ USER_APP_CPU_MS_OVERRIDES: "heavy=30000 unlimited=0" });
    const decide = (name: string, settings: Record<string, unknown>) => classifyCostControlsBackfill({
      ...base,
      config: userAppCostControlsForScript(overridden, name),
      guardState: guardState(name),
      settings,
      entrypoint: null,
    });
    expect(decide("heavy", { limits: { cpu_ms: 30_000 } })).toEqual({ action: "skip", reason: "already-applied" });
    expect(decide("heavy", { limits: { cpu_ms: 15_000 } })).toEqual({ action: "apply" });
    expect(decide("unlimited", {})).toEqual({ action: "skip", reason: "already-applied" });
    expect(decide("unlimited", { limits: {} })).toEqual({ action: "skip", reason: "already-applied" });
    expect(decide("unlimited", { limits: { cpu_ms: 1000 } })).toEqual({ action: "apply" });
    expect(decide("other", { limits: { cpu_ms: 15_000 } })).toEqual({ action: "skip", reason: "already-applied" });
  });
});

describe("runBackfill", () => {
  function deps(overrides: Partial<BackfillDeps> = {}): BackfillDeps & { lines: string[] } {
    const lines: string[] = [];
    return {
      guardStates: new Map(["guarded", "bare", "suspended", "leased", "broken", "later"].map((name) => [
        name,
        guardState(name, name === "suspended" ? { status: "suspended" } : {}),
      ])),
      leaseExpiresAt: (appId) => appId === "org:leased" ? Date.now() + 60_000 : null,
      readSettings: vi.fn(async (name: string) => name === "guarded"
        ? { limits: { cpu_ms: 15_000 }, bindings: [doBinding] }
        : { bindings: [doBinding] }),
      readEntrypoint: vi.fn(async (name: string) => name === "guarded" ? "__camelai_entry.js" : "index.js"),
      applyOne: vi.fn(async (name: string) => {
        if (name === "broken") throw new Error("HTTP 502");
        return { status: "applied" as const, scriptVersion: `${name}-v2` };
      }),
      sleep: vi.fn(async () => undefined),
      log: (line) => lines.push(line),
      now: () => Date.now(),
      lines,
      ...overrides,
    };
  }
  const candidates = ["unregistered", "guarded", "suspended", "leased", "bare", "broken", "later"];

  it("dry run never applies and lists what it would redeploy", async () => {
    const d = deps();
    const outcomes = await runBackfill(candidates, { apply: false, limit: null, delayMs: 2_000 }, config, d);
    expect(d.applyOne).not.toHaveBeenCalled();
    expect(summarizeBackfill(outcomes)).toEqual({
      applied: 0,
      wouldApply: 3,
      failed: 0,
      skipped: { "no-artifact-record": 1, "already-applied": 1, suspended: 1, "lease-held": 1 },
    });
    expect(d.lines).toContain("would-apply  bare");
    expect(d.lines).toContain("skipped      unregistered (no-artifact-record)");
    // Cheap skips never cost a per-script Cloudflare read.
    expect(d.readSettings).not.toHaveBeenCalledWith("unregistered");
    expect(d.readSettings).not.toHaveBeenCalledWith("suspended");
  });

  it("applies sequentially with a delay, records failures, and honors --limit", async () => {
    const d = deps();
    const outcomes = await runBackfill(candidates, { apply: true, limit: 2, delayMs: 1_500 }, config, d);
    expect(outcomes.filter((outcome) => outcome.result !== "skipped")).toEqual([
      { dispatchScriptName: "bare", result: "applied", scriptVersion: "bare-v2" },
      { dispatchScriptName: "broken", result: "failed", error: "HTTP 502" },
    ]);
    expect(d.applyOne).not.toHaveBeenCalledWith("later");
    expect(d.sleep).toHaveBeenCalledTimes(1);
    expect(d.sleep).toHaveBeenCalledWith(1_500);
    expect(summarizeBackfill(outcomes)).toMatchObject({ applied: 1, failed: 1 });
    expect(d.lines).toContain("FAILED       broken: HTTP 502");
  });

  it("resolves each app's CPU override before deciding", async () => {
    const d = deps({
      readSettings: vi.fn(async (name: string) => ({ limits: { cpu_ms: name === "guarded" ? 30_000 : 1000 } })),
    });
    const overridden = userAppCostControlsConfig({ USER_APP_CPU_MS_OVERRIDES: "guarded=30000,bare=1000" });
    const outcomes = await runBackfill(["guarded", "bare", "later"], { apply: false, limit: null, delayMs: 0 }, overridden, d);
    expect(outcomes).toEqual([
      { dispatchScriptName: "guarded", result: "skipped", reason: "already-applied" },
      { dispatchScriptName: "bare", result: "skipped", reason: "already-applied" },
      { dispatchScriptName: "later", result: "would-apply" },
    ]);
  });

  it("reports server-side skips from the apply call", async () => {
    const d = deps({ applyOne: vi.fn(async () => ({ status: "skipped" as const, reason: "lease-held" as const })) });
    const outcomes = await runBackfill(["bare"], { apply: true, limit: null, delayMs: 0 }, config, d);
    expect(outcomes).toEqual([{ dispatchScriptName: "bare", result: "skipped", reason: "lease-held" }]);
  });
});
