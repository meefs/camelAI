import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable static exports for Cloudflare
  output: "standalone",
};

export default nextConfig;
