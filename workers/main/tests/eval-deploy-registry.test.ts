import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  getEvalDeployApp,
  listEvalDeployAppsForContainer,
  recordEvalDeployApp,
  setEvalDeployAppPublic,
  upsertEvalDeployContext,
} from "../src/eval-deploy-registry";

type EvalRegistryTestEnv = {
  APP_DB?: D1Database;
};

const testEnv = env as unknown as EvalRegistryTestEnv;

describe("eval deploy registry", () => {
  it("updates visibility for eval-only deployed apps", async () => {
    const db = testEnv.APP_DB;
    expect(db).toBeDefined();

    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const containerId = `container-${suffix}`;
    const workspaceId = `workspace-${suffix}`;
    const orgId = `org-${suffix}`;
    const scriptName = `eval-app-${suffix}`;

    await upsertEvalDeployContext(db, {
      containerId,
      workspaceId,
      orgId,
      userId: `user-${suffix}`,
      threadId: `thread-${suffix}`,
      projectId: `project-${suffix}`,
    });

    const created = await recordEvalDeployApp(db, {
      containerId,
      accountId: "account-id",
      dispatchNamespace: "chiridion",
      scriptName,
      query: "excludeScript=true&bindings_inherit=strict",
      contentType: "multipart/form-data",
      contentLength: "123",
    });

    expect(created).toMatchObject({
      script_name: scriptName,
      workspace_id: workspaceId,
      is_public: true,
      eval: true,
    });

    const updated = await setEvalDeployAppPublic(db, workspaceId, scriptName, false);
    expect(updated).toMatchObject({
      script_name: scriptName,
      workspace_id: workspaceId,
      is_public: false,
      eval: true,
    });

    await expect(
      getEvalDeployApp(db, workspaceId, scriptName),
    ).resolves.toMatchObject({
      is_public: false,
    });

    await expect(
      setEvalDeployAppPublic(db, workspaceId, "missing-app", true),
    ).resolves.toBeNull();
  });

  it("does not use another eval run when the container context is missing", async () => {
    const db = testEnv.APP_DB;
    expect(db).toBeDefined();

    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    await upsertEvalDeployContext(db, {
      containerId: `known-container-${suffix}`,
      workspaceId: `workspace-${suffix}`,
      orgId: `org-${suffix}`,
      userId: `user-${suffix}`,
      threadId: `thread-${suffix}`,
      projectId: `project-${suffix}`,
    });

    await expect(
      recordEvalDeployApp(db, {
        containerId: `missing-container-${suffix}`,
        accountId: "account-id",
        dispatchNamespace: "chiridion",
        scriptName: `eval-app-${suffix}`,
        query: "excludeScript=true&bindings_inherit=strict",
        contentType: "multipart/form-data",
        contentLength: "123",
      }),
    ).resolves.toBeNull();

    await expect(
      listEvalDeployAppsForContainer(db, `missing-container-${suffix}`),
    ).resolves.toEqual([]);
  });
});
