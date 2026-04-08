/**
 * RAG (Retrieval Augmented Generation) system.
 *
 * Uses Xenova/all-MiniLM-L6-v2 to generate 384-dim embeddings locally
 * (no OpenAI required), then performs cosine similarity search via Supabase
 * pgvector to retrieve the most relevant content chunks.
 */
import { supabase } from './supabase';

// Singleton pipeline — loaded once per server process.
// Typed as unknown to avoid conflicts with Xenova's generated types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embeddingPipeline: ((texts: string[], options?: object) => Promise<any>) | null = null;

/**
 * Lazily initialise the Xenova feature-extraction pipeline.
 * The model is downloaded on first call and cached to disk automatically.
 */
async function getPipeline() {
  if (!embeddingPipeline) {
    // Dynamic import keeps Xenova out of the client bundle entirely
    const { pipeline } = await import('@xenova/transformers');
    // Cast through unknown to avoid overlapping-type TS error with Xenova's return type
    embeddingPipeline = (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')) as unknown as typeof embeddingPipeline;
  }
  return embeddingPipeline!;
}

/**
 * Generate a 384-dimensional embedding for a piece of text.
 * Mean-pools the token embeddings returned by the model.
 */
export async function embedText(text: string): Promise<number[]> {
  const pipe = await getPipeline();

  // pooling: 'mean', normalize: true matches the sentence-transformers convention
  const output = await pipe([text], { pooling: 'mean', normalize: true });

  // output[0].data is a Float32Array — convert to plain number[]
  return Array.from(output[0].data as Float32Array);
}

export interface RetrievedChunk {
  id: string;
  content: string;
  heading: string;
  similarity: number;
}

/**
 * Retrieve the top-k most relevant chunks for a given query from Supabase.
 * Falls back to an empty array if Supabase is unavailable or has no data.
 */
export async function retrieveChunks(
  clientId: string,
  query: string,
  k = 5
): Promise<RetrievedChunk[]> {
  try {
    const queryEmbedding = await embedText(query);

    const { data, error } = await supabase.rpc('match_embeddings', {
      query_embedding: queryEmbedding,
      match_client_id: clientId,
      match_count: k,
    });

    if (error) {
      console.error('[RAG] Supabase RPC error:', error.message);
      return [];
    }

    return (data ?? []) as RetrievedChunk[];
  } catch (err) {
    console.error('[RAG] retrieveChunks failed:', err);
    return [];
  }
}

/**
 * Retrieve the top-k chunks and format them into a clean context block
 * ready to be injected into the system prompt.
 */
export async function retrieveContext(
  clientId: string,
  query: string,
  k = 5
): Promise<{ context: string; ragUsed: boolean }> {
  const chunks = await retrieveChunks(clientId, query, k);

  if (chunks.length === 0) {
    return { context: '', ragUsed: false };
  }

  const context = chunks
    .map((c, i) => {
      const heading = c.heading ? `[${c.heading}]\n` : '';
      return `--- Relevant excerpt ${i + 1} ---\n${heading}${c.content}`;
    })
    .join('\n\n');

  return { context, ragUsed: true };
}
