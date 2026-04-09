/**
 * Client Registry
 *
 * All client configs are statically imported here so they are bundled
 * by Turbopack at build time. This is the most reliable way to serve
 * client data on Vercel — no filesystem access needed at runtime.
 *
 * When the scraper adds a new client, it updates this file automatically.
 */

import organicTrust from '../public/clients/organic-trust.json';

export interface ClientConfig {
  clientId: string;
  name: string;
  url: string;
  primaryColor: string;
  accentColor: string;
  greeting: string;
  quickReplies: string[];
  content: string;
  scrapedAt?: string;
  chunkCount?: number;
}

// Registry of all known clients — keyed by clientId
const registry: Record<string, ClientConfig> = {
  'organic-trust': organicTrust as ClientConfig,
};

export function getClientConfig(clientId: string): ClientConfig | null {
  return registry[clientId] ?? null;
}
