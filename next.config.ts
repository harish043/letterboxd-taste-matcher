import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/match": ["./node_modules/node-curl-impersonate/**/*"],
  },
};

export default nextConfig;
