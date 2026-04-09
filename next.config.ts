import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * These packages use Node.js native modules and must not be bundled.
   * Only used in server-side scripts, never in API routes.
   */
  serverExternalPackages: [
    '@xenova/transformers',
    'puppeteer',
    'sharp',
    'onnxruntime-node',
  ],
};

export default nextConfig;
