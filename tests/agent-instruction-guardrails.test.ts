import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readRepoFile = (path: string) => readFile(resolve(process.cwd(), path), "utf8");

describe("agent instruction guardrails", () => {
  it("keeps the data-analysis provenance and publication contracts explicit", async () => {
    const skill = await readRepoFile("sandbox/skills/data-analysis/SKILL.md");

    expect(skill).toContain("## Evidence and provenance contract");
    expect(skill).toContain("Never invent missing rows, prompts, campaigns, categories, URLs, fields");
    expect(skill).toContain("does **not** authorize publishing");
    expect(skill).toContain('publish_intent="user_requested"');
  });

  it("does not send agents through retired project VM paths", async () => {
    const [fileSharing, testingDebugging, developingSoftware, chat] = await Promise.all([
      readRepoFile("sandbox/skills/file-sharing/SKILL.md"),
      readRepoFile("sandbox/skills/testing-debugging/SKILL.md"),
      readRepoFile("sandbox/skills/developing-software/SKILL.md"),
      readRepoFile("src/components/Chat.tsx"),
    ]);

    expect(fileSharing).not.toContain('location: "vm"');
    expect(fileSharing).not.toContain("vm.exec");
    expect(testingDebugging).not.toContain("bun deploy");
    expect(developingSoftware).toContain("Never silently replace requested live data");
    expect(chat).not.toContain("VM checkout at /workspace");
    expect(chat).not.toContain("look for either wrangler.toml or wrangler.jsonc");
  });

  it("keeps deployed connection calls on the invoke-backed proxy", async () => {
    const reference = await readRepoFile(
      "sandbox/skills/developing-software/CONNECTIONS-AND-STORAGE.md",
    );

    expect(reference).toContain('import { createConnections } from "~/lib/connections"');
    expect(reference).toContain("const connections = createConnections(context.cloudflare.env)");
    expect(reference).toContain("const response = await connections[custom.alias].fetch");
    expect(reference).not.toContain("context.cloudflare.env.CONNECTIONS[stripe.alias]");
    expect(reference).toContain(
      "Cloudflare RPC interprets the alias as an RPC method name",
    );
  });
});
