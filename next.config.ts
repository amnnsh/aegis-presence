import type { NextConfig } from "next";

const config: NextConfig = {
  // No API routes, server actions, database, or runtime application server.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
};
export default config;
