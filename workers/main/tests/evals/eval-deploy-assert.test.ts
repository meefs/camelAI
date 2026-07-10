import { describe, expect, it } from "vitest";

import {
  assertDeployedApp,
  assertJsonSubset,
  countWorkspaceApps,
  resolveEvalFetchAttempts,
} from "./eval-deploy-assert";

const app = (name: string, host: string) => ({ name, url: `https://${host}` });

describe("assertDeployedApp", () => {
  it("throws when the eval deployed no app", () => {
    expect(() => assertDeployedApp({ deployedApps: [] })).toThrow(/no deployed app/i);
    expect(() => assertDeployedApp({})).toThrow(/no deployed app/i);
  });

  it("returns the first app when no name is required", () => {
    const a = app("dash", "dash.evals.camelai.app");
    expect(assertDeployedApp({ deployedApps: [a] })).toBe(a);
  });

  it("throws when a required app name is missing", () => {
    expect(() =>
      assertDeployedApp({ deployedApps: [app("a", "a.evals.camelai.app")] }, { name: "b" }),
    ).toThrow(/named "b"/);
  });

  it("finds the named app among several", () => {
    const apps = [app("a", "a.evals.camelai.app"), app("b", "b.evals.camelai.app")];
    expect(assertDeployedApp({ deployedApps: apps }, { name: "b" }).name).toBe("b");
  });

  it("enforces host prefix/suffix", () => {
    const a = app("fake-data-dashboard", "fake-data-dashboard.evals.camelai.app");
    expect(
      assertDeployedApp(
        { deployedApps: [a] },
        { hostPrefix: "fake-data-dashboard", hostSuffix: ".evals.camelai.app" },
      ),
    ).toBe(a);
    expect(() =>
      assertDeployedApp({ deployedApps: [a] }, { hostSuffix: ".example.com" }),
    ).toThrow(/does not end with/);
    expect(() =>
      assertDeployedApp({ deployedApps: [app("x", "other.evals.camelai.app")] }, { hostPrefix: "x" }),
    ).toThrow(/does not start with/);
  });
});

describe("countWorkspaceApps", () => {
  const stub = (n: number) => ({
    listWorkerScriptsByWorkspace: async () => Array.from({ length: n }, () => ({})),
  });

  it("counts registered workspace apps", async () => {
    expect(await countWorkspaceApps(stub(0), "ws")).toBe(0);
    expect(await countWorkspaceApps(stub(3), "ws")).toBe(3);
  });

  it("supports a before/after +1 assertion", async () => {
    const before = await countWorkspaceApps(stub(0), "ws");
    expect(await countWorkspaceApps(stub(1), "ws")).toBe(before + 1);
  });
});

describe("assertJsonSubset", () => {
  it("deep-compares only expected object keys", () => {
    expect(assertJsonSubset(
      { total: 3, nested: { count: 2, ignored: true }, extra: "ok" },
      { total: 3, nested: { count: 2 } },
      "summary",
    )).toEqual([]);
  });

  it("returns readable nested mismatches", () => {
    expect(assertJsonSubset(
      { byCategory: { gear: { totalCents: 10 } } },
      { byCategory: { gear: { totalCents: 20 } } },
      "summary",
    )).toEqual(["summary.byCategory.gear.totalCents expected 20, got 10"]);
  });
});

describe("eval fetch retry policy", () => {
  it("does not retry mutations unless attempts are explicitly requested", () => {
    expect(resolveEvalFetchAttempts({ method: "POST" })).toBe(1);
    expect(resolveEvalFetchAttempts({ method: "PATCH" })).toBe(1);
    expect(resolveEvalFetchAttempts({ method: "GET" })).toBeUndefined();
    expect(resolveEvalFetchAttempts({ method: "POST" }, 3)).toBe(3);
  });
});
