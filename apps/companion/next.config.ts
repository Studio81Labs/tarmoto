import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@tarmoto/shared"],
  // Allow loopback hosts for local development and Playwright E2E. Next 16
  // tightens cross-origin asset requests in dev mode and blocks anything
  // not on this list, which breaks tests served via 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
