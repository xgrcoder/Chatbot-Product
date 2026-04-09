/**
 * POST /api/chat
 *
 * Accepts: { clientId: string, messages: { role: string, content: string }[] }
 * Returns: { reply: string, ragUsed: boolean }
 */

import { NextRequest } from 'next/server';
import Groq from 'groq-sdk';
import { getClientConfig } from '@/lib/getClient';
import { retrieveContext } from '@/lib/rag';

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
      return Response.json({ error: 'Server misconfiguration' }, { status: 500, headers: CORS });
    }

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

    const client = await getClientConfig(clientId);
    if (!client) {
      return Response.json(
        { error: `Client "${clientId}" not found` },
        { status: 404, headers: CORS }
      );
    }

    // Use RAG to retrieve the most relevant chunks for this query
    const lastUserMessage = messages[messages.length - 1]?.content ?? '';
    const { context, ragUsed } = await retrieveContext(clientId, lastUserMessage, 6);

    // RAG chunks when available; raw content slice as fallback
    const contextBlock = ragUsed
      ? `Relevant information from our knowledge base:\n\n${context}`
      : `Website content for reference:\n${client.content.slice(0, 8000)}`;

    const systemPrompt = `You are a helpful, friendly AI assistant for ${client.name}.

Your job is to answer questions from website visitors accurately and concisely.
Be professional, warm, and on-brand. Keep answers to 2-4 sentences unless more detail is needed.
If asked about prices, opening times, services or specific details — use the information provided below.
If you genuinely don't know something, say so honestly and suggest they contact the team directly.
Never make up information not in the provided context.

${contextBlock}`;

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      ],
      temperature: 0.4,
      max_tokens: 500,
    });

    const reply = completion.choices[0]?.message?.content ?? 'Sorry, I could not generate a response.';
    return Response.json({ reply, ragUsed }, { status: 200, headers: CORS });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/chat] Error:', message);
    return Response.json({ error: 'Internal server error' }, { status: 500, headers: CORS });
  }
}
