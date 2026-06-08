import { describe, expect, it } from "vitest";
import {
  normalizeGlobalProjectId,
  projectRuntimeConnectionsRpcUrl,
  projectRuntimeDeployProxyUrl,
  projectRuntimeDockerProxyBaseUrl,
  runtimeArtifactsProxyRemote,
} from "../src/project-vm-protocol.js";
import { artifactVanityRemote } from "../src/workspace-filesystem-do.js";

describe("project VM protocol IDs", () => {
  it("preserves globally unique project ids in artifact vanity remotes", () => {
    const projectId = "ca-aeada699b1234c3d8ab01edf70fdc855-simple-counter-1v0p";

    expect(normalizeGlobalProjectId(projectId)).toBe(projectId);
    expect(artifactVanityRemote(projectId)).toBe(
      "https://artifacts.camelai.internal/git/ca-aeada699b1234c3d8ab01edf70fdc855-simple-counter-1v0p.git",
    );
  });
});

describe("project VM protocol proxy URLs", () => {
  it("defaults to the project-runtime Docker proxy port", () => {
    expect(projectRuntimeDockerProxyBaseUrl(undefined)).toBe("http://host.docker.internal:8089");
  });

  it("normalizes a configured project-runtime Docker proxy base URL", () => {
    expect(projectRuntimeDockerProxyBaseUrl("http://host.docker.internal:4411/")).toBe(
      "http://host.docker.internal:4411",
    );
  });

  it("builds Wrangler deploy proxy URLs from the runtime Docker proxy", () => {
    expect(projectRuntimeDeployProxyUrl(undefined)).toBe(
      "http://host.docker.internal:8089/p/camelai-cloudflare-api/client/v4",
    );
    expect(projectRuntimeDeployProxyUrl("http://host.docker.internal:4411")).toBe(
      "http://host.docker.internal:4411/p/camelai-cloudflare-api/client/v4",
    );
    expect(projectRuntimeDeployProxyUrl("http://host.docker.internal:4411/p/camelai-cloudflare-api/client/v4")).toBe(
      "http://host.docker.internal:4411/p/camelai-cloudflare-api/client/v4",
    );
  });

  it("builds connections RPC proxy URLs from the runtime Docker proxy", () => {
    expect(projectRuntimeConnectionsRpcUrl(undefined)).toBe(
      "http://host.docker.internal:8089/p/camelai-connections-rpc/rpc/connections",
    );
    expect(projectRuntimeConnectionsRpcUrl("http://host.docker.internal:4411")).toBe(
      "http://host.docker.internal:4411/p/camelai-connections-rpc/rpc/connections",
    );
    expect(projectRuntimeConnectionsRpcUrl("http://host.docker.internal:4411/p/camelai-connections-rpc/rpc/connections")).toBe(
      "http://host.docker.internal:4411/p/camelai-connections-rpc/rpc/connections",
    );
  });

  it("builds artifact proxy remotes from the configured runtime Docker proxy", () => {
    expect(
      runtimeArtifactsProxyRemote(
        undefined,
        "http://host.docker.internal:4411/",
      ),
    ).toBe(
      "http://host.docker.internal:4411/p/camelai-artifacts/git/origin.git",
    );
  });
});
