import { defineSoftware } from "@rivet-dev/agent-os-core";
import { resolve } from "node:path";

const packageDir = resolve(
  process.cwd(),
  "desktop-agentos/vendor/agent-os-pi-local",
);

const piLocal = defineSoftware({
  name: "pi",
  type: "agent" as const,
  packageDir,
  requires: ["@rivet-dev/agent-os-pi-local", "@mariozechner/pi-coding-agent"],
  agent: {
    id: "pi",
    acpAdapter: "@rivet-dev/agent-os-pi-local",
    agentPackage: "@mariozechner/pi-coding-agent",
    prepareInstructions: async (kernel, _cwd, additionalInstructions, opts) => {
      const parts: string[] = [];
      if (!opts?.skipBase) {
        const data = await kernel.readFile("/etc/agentos/instructions.md");
        parts.push(new TextDecoder().decode(data));
      }
      if (additionalInstructions) {
        parts.push(additionalInstructions);
      }
      if (opts?.toolReference) {
        parts.push(opts.toolReference);
      }
      parts.push("---");
      const instructions = parts.join("\n\n");
      if (!instructions) {
        return {};
      }
      return { args: ["--append-system-prompt", instructions] };
    },
  },
});

export default piLocal;
