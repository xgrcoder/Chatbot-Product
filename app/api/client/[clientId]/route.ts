/**
 * GET /api/client/[clientId]
 *
 * Returns public-safe client config for the widget to load
 * brand colours, greeting, and quick replies.
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

  if (!/^[a-z0-9-]+$/.test(clientId)) {
    return Response.json({ error: 'Invalid client ID' }, { status: 400, headers: CORS });
  }

  try {
    // public/clients/ is always available on Vercel
    const filePath = path.join(process.cwd(), 'public', 'clients', `${clientId}.json`);
    const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    return Response.json({
      clientId: config.clientId,
      name: config.name,
      primaryColor: config.primaryColor,
      accentColor: config.accentColor,
      greeting: config.greeting,
      quickReplies: config.quickReplies,
    }, { status: 200, headers: CORS });
  } catch {
    return Response.json(
      { error: `Client "${clientId}" not found` },
      { status: 404, headers: CORS }
    );
  }
}
