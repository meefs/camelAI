import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadLatestReleaseManifest,
  SELFHOST_IMAGE_ENV_BY_MANIFEST_KEY,
} from "../scripts/selfhost-latest-release.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("latest self-host release", () => {
  it("downloads the latest manifest and returns its immutable release ref", async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "camelai-latest-release-test-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    const manifest = {
      schema: 1,
      release: "selfhost-v1.2.3",
      revision: "a".repeat(40),
      images: Object.fromEntries(
        Object.keys(SELFHOST_IMAGE_ENV_BY_MANIFEST_KEY).map((key) => [
          key,
          `example.invalid/${key}@sha256:${"b".repeat(64)}`,
        ]),
      ),
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(manifest), { status: 200 }),
    );

    const result = await downloadLatestReleaseManifest({
      fetchImpl,
      manifestUrl: "https://releases.example/latest/selfhost-release.json",
      temporaryDirectory,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://releases.example/latest/selfhost-release.json",
      expect.objectContaining({ redirect: "follow" }),
    );
    expect(result.releaseRef).toBe("selfhost-v1.2.3");
    expect(JSON.parse(await fs.readFile(result.manifestPath, "utf8"))).toEqual(
      manifest,
    );
  });

  it("rejects a response that is not a release manifest", async () => {
    await expect(
      downloadLatestReleaseManifest({
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              schema: 1,
              release: "main",
              revision: "a".repeat(40),
            }),
            { status: 200 },
          ),
      }),
    ).rejects.toThrow("latest self-host release manifest is invalid");
  });

  it("rejects a release whose coordinated images are not all digest-pinned", async () => {
    await expect(
      downloadLatestReleaseManifest({
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              schema: 1,
              release: "selfhost-v1.2.3",
              revision: "a".repeat(40),
              images: { app: "example.invalid/app:latest" },
            }),
            { status: 200 },
          ),
      }),
    ).rejects.toThrow("image app is not pinned by digest");
  });

  it("reports GitHub download failures before changing the checkout", async () => {
    await expect(
      downloadLatestReleaseManifest({
        fetchImpl: async () => new Response("unavailable", { status: 503 }),
      }),
    ).rejects.toThrow("HTTP 503");
  });
});
