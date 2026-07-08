import type { NextConfig } from "next";

// The backend (apps/api) runs on :3001. We reverse-proxy /api and the health
// probes through the Next dev/prod server so the browser sees a single origin
// (localhost:3000). This keeps the httpOnly `mx2_session` cookie first-party
// (sameSite=strict works) and avoids any CORS configuration on the backend.
const API_TARGET = process.env.API_PROXY_TARGET ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // ESLint for the web app is intentionally not wired into `next build` yet —
  // the monorepo root uses ESLint 9 flat config and ignores apps/web. Type
  // safety is still enforced via `tsc --noEmit`. (Tracked as a follow-up.)
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_TARGET}/api/:path*` },
      { source: "/healthz", destination: `${API_TARGET}/healthz` },
      { source: "/readyz", destination: `${API_TARGET}/readyz` },
    ];
  },
  async redirects() {
    return [
      // Legacy IA (pre Smart Orders pivot). Remove after beta users migrate.
      { source: "/rules", destination: "/smart-orders", permanent: false },
    ];
  },
};

export default nextConfig;
