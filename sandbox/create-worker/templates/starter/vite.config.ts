import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig(({ command }) => ({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    alias: {
      "~": resolve(__dirname, "./app"),
      // Workaround: @cloudflare/ai-chat imports { agentContext } from "agents/internal_context"
      // but agents@0.6.0 removed the subpath from its exports map and renamed the export
      // to __DO_NOT_USE_WILL_BREAK__agentContext. Rolldown (Vite 8) enforces strict exports
      // resolution, so we alias it to a shim that re-exports under the old name.
      "agents/internal_context": resolve(__dirname, "workers/agents-internal-context-shim.ts"),
    },
  },
  // Configure SSR environment to use Cloudflare's worker entry as the rollup input
  // This ensures Durable Object exports are included in the bundle
  environments: {
    ssr: {
      build: {
        rollupOptions: {
          input: "virtual:cloudflare/worker-entry",
        },
      },
    },
  },
  // Polyfill globals for @cloudflare/codemode (uses zod-to-ts → TypeScript compiler)
  // __filename: TypeScript compiler reads it; process.argv: TS calls process.argv.slice()
  define: {
    __filename: "'index.ts'",
    "process.argv": "['node', 'index.ts']",
  },
  // Disable dep discovery during builds to avoid WebSocket error in @cloudflare/vite-plugin
  optimizeDeps: command === "build" ? { noDiscovery: true } : {},
}));
