import type { NextConfig } from "next";
 
const nextConfig: NextConfig = {
	turbopack: {
		// Keep Turbopack rooted to this project even if a parent directory has a lockfile.
		root: process.cwd(),
	},
};
 
export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev({ configPath: "wrangler.dev.jsonc" });
