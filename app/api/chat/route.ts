/**
 * POST /api/chat
 *
 * Accepts: { clientId: string, messages: { role: string, content: string }[] }
 * Returns: { reply: string, ragUsed: boolean }
 */

import { NextRequest } from 'next/server';
import Groq from 'groq-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { retrieveContext } from '@/lib/rag';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

interface ClientConfig {
  clientId: string;
  name: string;
  url: string;
  primaryColor: string;
  accentColor: string;
  greeting: string;
  quickReplies: string[];
  content: string;
}

function loadClientConfig(clientId: string): ClientConfig | null {
  if (!/^[a-z0-9-]+$/.test(clientId)) return null;
  // public/clients/ is always included in Vercel's static output
  const filePath = path.join(process.cwd(), 'public', 'clients', `${clientId}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ClientConfig;
  } catch {
    return null;
  }
}

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function POST(request: NextRequest) {
  try {
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

    const client = loadClientConfig(clientId);
    if (!client) {
      return Response.json(
        { error: `Client "${clientId}" not found` },
        { status: 404, headers: CORS }
      );
    }

    const latestUser = [...messages].reverse().find(m => m.role === 'user');
    const userQuery = latestUser?.content ?? '';

    const { context, ragUsed } = await retrieveContext(clientId, userQuery, 5);

    const contextSection = ragUsed
      ? `\n\nRelevant information from ${client.name}'s website:\n${context}`
      : `\n\nWebsite content for reference:\n${client.content.slice(0, 8000)}`;

    const systemPrompt = `You are a helpful, friendly AI assistant for ${client.name}.
Answer questions from website visitors accurately and concisely.
Be professional, warm, and on-brand. Keep answers brief — 2-4 sentences unless more detail is needed.
If you don't know something, say so honestly and suggest they contact the team directly.
Never make up information not in the provided context.
${contextSection}`;

    const completion = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
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

    return Response.json({ reply, ragUsed }, { status: 200, headers: CORS });
  } catch (err) {
    console.error('[/api/chat] Error:', err);
    return Response.json(
      { error: 'Internal server error' },
      { status: 500, headers: CORS }
    );
  }
}
