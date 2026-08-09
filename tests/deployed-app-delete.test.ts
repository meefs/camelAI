import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareEnv } from "@/lib/cloudflare.server";
import {
  deleteDeployedAppRuntime,
  getDispatchScriptName,
} from "@/lib/deployed-app-delete.server";
import {
  selfhostAssetObjectKey,
  selfhostAssetsKey,
} from "../workers/main/src/selfhost-assets-registry";
import { selfhostWorkerKey } from "../workers/main/src/selfhost-worker-registry";

const { deleteDispatchScriptMock } = vi.hoisted(() => ({
  deleteDispatchScriptMock: vi.fn(),
}));

vi.mock("../workers/main/src/cf-api-proxy", () => ({
  deleteDispatchScript: deleteDispatchScriptMock,
}));

function makeEnv(input: {
  accountId: string;
  namespace: string;
  apiToken?: string;
  kv?: Map<string, string>;
  deletedObjects?: string[];
}): CloudflareEnv {
  const kv = input.kv ?? new Map<string, string>();
  const deletedObjects = input.deletedObjects ?? [];
  return {
    CF_ACCOUNT_ID: input.accountId,
    CF_DISPATCH_NAMESPACE: input.namespace,
    CF_API_TOKEN: input.apiToken,
    APP_KV: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      delete: vi.fn(async (key: string) => {
        kv.delete(key);
      }),
    },
    R2_BUCKET: {
      delete: vi.fn(async (keys: string | string[]) => {
        deletedObjects.push(...(Array.isArray(keys) ? keys : [keys]));
      }),
    },
  } as unknown as CloudflareEnv;
}

describe("deployed app runtime deletion", () => {
  beforeEach(() => {
    deleteDispatchScriptMock.mockReset();
  });

  it("uses the canonical script--org dispatch name", () => {
    expect(getDispatchScriptName("token-trail", "valmark")).toBe(
      "token-trail--valmark",
    );
  });

  it("deletes self-host worker metadata and its unique R2 assets without Cloudflare credentials", async () => {
    const dispatchScriptName = "token-trail--valmark";
    const kv = new Map<string, string>([
      [selfhostWorkerKey(dispatchScriptName), "worker"],
      [
        selfhostAssetsKey(dispatchScriptName),
        JSON.stringify({
          schemaVersion: 1,
          appId: dispatchScriptName,
          createdAt: "2026-08-09T00:00:00.000Z",
          manifest: {
            "index.html": { hash: "hash-a" },
            "duplicate.html": { hash: "hash-a" },
            "assets/app.js": { hash: "hash-b" },
          },
        }),
      ],
    ]);
    const deletedObjects: string[] = [];
    const env = makeEnv({
      accountId: "selfhost",
      namespace: "selfhost",
      kv,
      deletedObjects,
    });

    await expect(
      deleteDeployedAppRuntime(env, {
        scriptName: "token-trail",
        orgSlug: "valmark",
      }),
    ).resolves.toBe(dispatchScriptName);

    expect(kv.has(selfhostWorkerKey(dispatchScriptName))).toBe(false);
    expect(kv.has(selfhostAssetsKey(dispatchScriptName))).toBe(false);
    expect(deletedObjects).toEqual([
      selfhostAssetObjectKey(dispatchScriptName, "hash-a"),
      selfhostAssetObjectKey(dispatchScriptName, "hash-b"),
    ]);
    expect(deleteDispatchScriptMock).not.toHaveBeenCalled();
  });

  it("does not discard self-host metadata when asset cleanup cannot be verified", async () => {
    const dispatchScriptName = "token-trail--valmark";
    const workerKey = selfhostWorkerKey(dispatchScriptName);
    const assetsKey = selfhostAssetsKey(dispatchScriptName);
    const kv = new Map<string, string>([
      [workerKey, "worker"],
      [assetsKey, "not-json"],
    ]);
    const env = makeEnv({
      accountId: "selfhost",
      namespace: "selfhost",
      kv,
    });

    await expect(
      deleteDeployedAppRuntime(env, {
        scriptName: "token-trail",
        orgSlug: "valmark",
      }),
    ).rejects.toThrow("Self-host asset metadata is invalid");
    expect(kv.has(workerKey)).toBe(true);
    expect(kv.has(assetsKey)).toBe(true);
  });

  it("deletes the canonical namespaced script in hosted environments", async () => {
    deleteDispatchScriptMock.mockResolvedValue(true);
    const env = makeEnv({
      accountId: "account-1",
      namespace: "production",
      apiToken: "secret",
    });

    await deleteDeployedAppRuntime(env, {
      scriptName: "token-trail",
      orgSlug: "valmark",
    });

    expect(deleteDispatchScriptMock).toHaveBeenCalledWith(
      "account-1",
      "production",
      "token-trail--valmark",
      "secret",
    );
  });

  it("fails before metadata deletion when hosted credentials are missing", async () => {
    const env = makeEnv({
      accountId: "account-1",
      namespace: "production",
    });

    await expect(
      deleteDeployedAppRuntime(env, {
        scriptName: "token-trail",
        orgSlug: "valmark",
      }),
    ).rejects.toThrow("Missing Cloudflare credentials");
    expect(deleteDispatchScriptMock).not.toHaveBeenCalled();
  });
});
