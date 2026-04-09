/**
 * GET /api/client/[clientId]
 *
 * Returns public-safe client config for the widget.
 * Note: params is a Promise in Next.js 16 — must be awaited.
 */

import { NextRequest } from 'next/server';
import { getClientConfig } from '@/lib/clientRegistry';

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

  const config = getClientConfig(clientId);
  if (!config) {
    return Response.json(
      { error: `Client "${clientId}" not found` },
      { status: 404, headers: CORS }
    );
  }

  // Only expose what the widget needs — never send full scraped content
  return Response.json({
    clientId: config.clientId,
    name: config.name,
    primaryColor: config.primaryColor,
    accentColor: config.accentColor,
    greeting: config.greeting,
    quickReplies: config.quickReplies,
  }, { status: 200, headers: CORS });
}
