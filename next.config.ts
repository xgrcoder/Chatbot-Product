import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * These packages use Node.js native modules and must not be bundled.
   * They are only ever imported in server-side code (API routes, scripts).
   */
  serverExternalPackages: [
    '@xenova/transformers',
    'puppeteer',
    'sharp',
    'onnxruntime-node',
  ],

  /**
   * outputFileTracingIncludes tells Vercel's file-tracing bundler to include
   * the data/clients/ directory in the serverless function output.
   * Without this, fs.readFileSync on those files returns ENOENT on Vercel
   * even though the files are committed to the repo.
   */
  outputFileTracingIncludes: {
    '/api/chat': ['./data/clients/**'],
    '/api/client/[clientId]': ['./data/clients/**'],
  },
};

export default nextConfig;
