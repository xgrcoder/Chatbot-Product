import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * These packages use Node.js native modules (onnxruntime-node, chromium
   * binaries, etc.) and must not be bundled by Turbopack/webpack.
   * They are only ever imported in server-side code (API routes, scripts).
   */
  serverExternalPackages: [
    '@xenova/transformers',
    'puppeteer',
    'sharp',
    'onnxruntime-node',
  ],
};

export default nextConfig;
