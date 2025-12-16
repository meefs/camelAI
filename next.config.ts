import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig: NextConfig = {
	/* config options here */
	turbopack: {
		// Keep Turbopack rooted to this project even if a parent directory has a lockfile.
		root: process.cwd(),
	},
};

export default function config(phase: string) {
	// Enable calling `getCloudflareContext()` in `next dev` only.
	// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
	if (phase === PHASE_DEVELOPMENT_SERVER) {
		// Use dynamic import so the dev helper doesn't execute during builds.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { initOpenNextCloudflareForDev } = require("@opennextjs/cloudflare");
		// Use a minimal wrangler config during `next dev` to avoid container/DO
		// startup errors; runtime DO/WS behavior runs in a separate `wrangler dev`.
		initOpenNextCloudflareForDev({ configPath: "wrangler.nextdev.jsonc" });

		return {
			...nextConfig,
			async rewrites() {
				// Proxy API requests to the local Cloudflare worker so the frontend can
				// hot-reload while Durable Objects/WebSockets run under wrangler.
				return [
					{
						source: "/__backend/:path*",
						destination: "http://localhost:8788/:path*",
					},
				];
			},
		} satisfies NextConfig;
	}

	return nextConfig;
}
