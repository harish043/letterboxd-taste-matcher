import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/match": ["./node_modules/apify-node-curl-impersonate/**/*"],
  },
};

export default nextConfig;
