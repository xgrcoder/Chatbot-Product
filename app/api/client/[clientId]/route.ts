/**
 * GET /api/client/[clientId]
 *
 * Returns public-safe client config so the widget loads brand colours,
 * greeting, and quick replies.
 *
 * Note: `params` is a Promise in Next.js 16 — must be awaited.
 */

import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const { clientId } = await params;

  // Sanitise — only allow alphanumeric + hyphens to prevent path traversal
  if (!/^[a-z0-9-]+$/.test(clientId)) {
    return Response.json({ error: 'Invalid client ID' }, { status: 400, headers: CORS });
  }

  try {
    const filePath = path.join(process.cwd(), 'data', 'clients', `${clientId}.json`);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw);

    // Only expose what the widget needs — never send scraped content or keys
    const publicConfig = {
      clientId: config.clientId,
      name: config.name,
      primaryColor: config.primaryColor,
      accentColor: config.accentColor,
      greeting: config.greeting,
      quickReplies: config.quickReplies,
    };

    return Response.json(publicConfig, { status: 200, headers: CORS });
  } catch {
    return Response.json(
      { error: `Client "${clientId}" not found` },
      { status: 404, headers: CORS }
    );
  }
}
