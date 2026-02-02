import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ command }) => ({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
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
  // Disable dep discovery during builds to avoid WebSocket error in @cloudflare/vite-plugin
  optimizeDeps: command === "build" ? { noDiscovery: true } : {},
}));
