import {
  fetchWithRetry,
  resolveFetchAttempts,
} from "./project-eval-helpers";

// Reusable assertions for "did this eval actually deploy a live app?".
//
// Agent eval sessions surface deployed apps via AgentEvalSessionResult.deployedApps (populated
// from the workspace's registered worker scripts — i.e. real deploys, not static set_preview).
// An eval that is supposed to deploy should fail loudly if nothing landed, so these helpers throw
// descriptive errors (which fail the vitest `it`) rather than returning a soft result.

export interface EvalDeployedApp {
  name: string;
  url: string;
}

/**
 * Count the apps (registered worker scripts) for a workspace — the same source the eval result's
 * deployedApps comes from. Snapshot before the eval and compare after to assert a deploy happened,
 * independent of the app's name or a live fetch:
 *
 *   const before = await countWorkspaceApps(orgStub, workspaceId);
 *   ... run the agent eval ...
 *   expect(await countWorkspaceApps(orgStub, workspaceId)).toBe(before + 1);
 */
export async function countWorkspaceApps(
  orgStub: { listWorkerScriptsByWorkspace(workspaceId: string): Promise<{ length: number }> },
  workspaceId: string,
): Promise<number> {
  return (await orgStub.listWorkerScriptsByWorkspace(workspaceId)).length;
}

interface HasDeployedApps {
  deployedApps?: EvalDeployedApp[];
}

export interface AssertDeployedAppOptions {
  /** Require a specific app name (e.g. the name the prompt told the agent to use). */
  name?: string;
  /** Require the deployed app's host to start with this (usually the app name). */
  hostPrefix?: string;
  /** Require the deployed app's host to end with this (e.g. ".evals.camelai.app"). */
  hostSuffix?: string;
}

/**
 * Assert the eval produced a deployed app and return it. Throws with a clear message when no app
 * was deployed (the common "the agent never actually deployed" regression), when a required name
 * is missing, or when the URL host doesn't match the expected testing-grounds shape.
 */
export function assertDeployedApp(
  result: HasDeployedApps,
  options: AssertDeployedAppOptions = {},
): EvalDeployedApp {
  const apps = result.deployedApps ?? [];
  if (apps.length === 0) {
    throw new Error(
      "Eval produced no deployed app: result.deployedApps is empty. The agent did not deploy " +
        "an app (or the deploy failed) — a deploy eval must end with at least one live app.",
    );
  }

  const app = options.name
    ? apps.find((candidate) => candidate.name === options.name)
    : apps[0];
  if (!app) {
    throw new Error(
      `Eval did not deploy an app named "${options.name}". Deployed apps: ` +
        apps.map((candidate) => candidate.name).join(", "),
    );
  }

  if (options.hostPrefix || options.hostSuffix) {
    let host: string;
    try {
      host = new URL(app.url).host;
    } catch {
      throw new Error(`Deployed app "${app.name}" has an invalid URL: ${app.url}`);
    }
    if (options.hostPrefix && !host.startsWith(options.hostPrefix)) {
      throw new Error(
        `Deployed app host "${host}" does not start with "${options.hostPrefix}"`,
      );
    }
    if (options.hostSuffix && !host.endsWith(options.hostSuffix)) {
      throw new Error(
        `Deployed app host "${host}" does not end with "${options.hostSuffix}"`,
      );
    }
  }

  return app;
}

/**
 * Assert a deployed app is actually reachable: fetch it and require a non-empty 200. Confirms the
 * deploy is live, not just registered.
 */
export async function assertDeployedAppLive(app: EvalDeployedApp): Promise<void> {
  const response = await fetch(app.url, { redirect: "follow" });
  if (response.status !== 200) {
    throw new Error(
      `Deployed app "${app.name}" (${app.url}) is not reachable: HTTP ${response.status}`,
    );
  }
  const body = await response.text();
  if (body.length === 0) {
    throw new Error(`Deployed app "${app.name}" (${app.url}) returned an empty body`);
  }
}

export async function fetchJsonWithRetry(
  url: string,
  init?: RequestInit,
  attempts?: number,
): Promise<{ status: number; json: unknown }> {
  const response = await fetchWithRetry(
    url,
    init,
    resolveEvalFetchAttempts(init, attempts),
  );
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

export function resolveEvalFetchAttempts(
  init?: RequestInit,
  attempts?: number,
): number | undefined {
  return resolveFetchAttempts(init, attempts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function assertJsonSubset(
  actual: unknown,
  expected: Record<string, unknown>,
  label: string,
): string[] {
  const failures: string[] = [];
  const compare = (current: unknown, wanted: unknown, path: string): void => {
    if (isRecord(wanted)) {
      if (!isRecord(current)) {
        failures.push(`${path} expected an object, got ${describeValue(current)}`);
        return;
      }
      for (const [key, value] of Object.entries(wanted)) {
        compare(current[key], value, `${path}.${key}`);
      }
      return;
    }
    if (Array.isArray(wanted)) {
      if (!Array.isArray(current)) {
        failures.push(`${path} expected an array, got ${describeValue(current)}`);
        return;
      }
      wanted.forEach((value, index) => compare(current[index], value, `${path}[${index}]`));
      return;
    }
    if (!Object.is(current, wanted)) {
      failures.push(
        `${path} expected ${describeValue(wanted)}, got ${describeValue(current)}`,
      );
    }
  };
  compare(actual, expected, label);
  return failures;
}
