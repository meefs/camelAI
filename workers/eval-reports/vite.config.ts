import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: import.meta.dirname,
	plugins: [react(), cloudflare({ configPath: "./wrangler.jsonc" })],
	css: { postcss: path.resolve(import.meta.dirname, "../..") },
	resolve: {
		alias: { "@": path.resolve(import.meta.dirname, "../../src") },
		dedupe: ["react", "react-dom"],
	},
	server: { port: 8789 },
});
