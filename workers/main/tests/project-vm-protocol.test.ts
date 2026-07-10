import { describe, expect, it } from "vitest";
import { normalizeGlobalProjectId } from "../src/project-vm-protocol.js";
import { artifactVanityRemote } from "../src/workspace-filesystem-do.js";

describe("global project ids", () => {
  it("preserves globally unique project ids in artifact vanity remotes", () => {
    const projectId = "ca-aeada699b1234c3d8ab01edf70fdc855-simple-counter-1v0p";

    expect(normalizeGlobalProjectId(projectId)).toBe(projectId);
    expect(artifactVanityRemote(projectId)).toBe(
      "https://artifacts.camelai.internal/git/ca-aeada699b1234c3d8ab01edf70fdc855-simple-counter-1v0p.git",
    );
  });
});
