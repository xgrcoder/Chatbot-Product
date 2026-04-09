/**
 * POST /api/chat
 *
 * Accepts: { clientId: string, messages: { role: string, content: string }[] }
 * Returns: { reply: string, ragUsed: boolean }
 */

import { NextRequest } from 'next/server';
import Groq from 'groq-sdk';
import { getClientConfig } from '@/lib/clientRegistry';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(request: NextRequest) {
  try {
    if (!process.env.GROQ_API_KEY) {
      console.error('[/api/chat] GROQ_API_KEY is not set');
      return Response.json({ error: 'Server misconfiguration' }, { status: 500, headers: CORS });
    }
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const body = await request.json() as {
      clientId: string;
      messages: { role: string; content: string }[];
    };

    const { clientId, messages } = body;

    if (!clientId || !Array.isArray(messages) || messages.length === 0) {
      return Response.json(
        { error: 'clientId and messages are required' },
        { status: 400, headers: CORS }
      );
    }

    const client = getClientConfig(clientId);
    if (!client) {
      return Response.json(
        { error: `Client "${clientId}" not found` },
        { status: 404, headers: CORS }
      );
    }

    const contextSection = `\n\nWebsite content for reference:\n${client.content.slice(0, 8000)}`;

    const systemPrompt = `You are a helpful, friendly AI assistant for ${client.name}.
Answer questions from website visitors accurately and concisely.
Be professional, warm, and on-brand. Keep answers to 2-4 sentences unless more detail is needed.
If you don't know something, say so honestly and suggest they contact the team directly.
Never make up information not in the provided context.
${contextSection}`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      ],
      temperature: 0.5,
      max_tokens: 400,
    });

    const reply = completion.choices[0]?.message?.content ?? 'Sorry, I could not generate a response.';

    return Response.json({ reply }, { status: 200, headers: CORS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/chat] Error:', message, err);
    return Response.json(
      { error: 'Internal server error', detail: message },
      { status: 500, headers: CORS }
    );
  }
}
