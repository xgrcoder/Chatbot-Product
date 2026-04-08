/**
 * GET /api/client/[clientId]
 *
 * Returns the public-safe portions of the client config so the widget
 * can load brand colours, greeting, and quick replies.
 *
 * Note: `params` is a Promise in Next.js 16 — must be awaited.
 */

import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const { clientId } = await params;

  try {
    const filePath = path.resolve(process.cwd(), 'data', 'clients', `${clientId}.json`);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw);

    // Return only the fields needed by the widget (never expose full scraped content)
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
