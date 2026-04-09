/**
 * POST /api/lead
 * Saves a lead capture submission to Supabase.
 */
import { NextRequest } from 'next/server';
import { getSupabase } from '@/lib/supabase';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { clientId: string; name: string; email: string; phone?: string };
    const { clientId, name, email, phone } = body;
    if (!clientId || !name || !email) {
      return Response.json({ error: 'clientId, name and email are required' }, { status: 400, headers: CORS });
    }
    const supabase = getSupabase();
    const { error } = await supabase.from('leads').insert({
      client_id: clientId,
      name,
      email,
      phone: phone || null,
    });
    if (error) {
      console.error('[/api/lead]', error.message);
      return Response.json({ error: 'Failed to save lead' }, { status: 500, headers: CORS });
    }
    return Response.json({ ok: true }, { status: 200, headers: CORS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[/api/lead]', msg);
    return Response.json({ error: msg }, { status: 500, headers: CORS });
  }
}
