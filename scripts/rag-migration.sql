-- ============================================================
-- Zempotis Chat — Supabase RAG Migration
-- Run this once in the Supabase SQL editor before scraping.
-- ============================================================

-- 1. Enable the pgvector extension
create extension if not exists vector with schema extensions;

-- 2. Client embeddings table
--    Stores text chunks + 384-dim embeddings for every scraped client site.
create table if not exists public.client_embeddings (
  id          uuid primary key default gen_random_uuid(),
  client_id   text        not null,
  heading     text        not null default '',
  content     text        not null,
  embedding   vector(384) not null,
  created_at  timestamptz not null default now()
);

-- 3. HNSW index for fast approximate nearest-neighbour search
--    cosine distance is the right metric for normalised sentence embeddings.
create index if not exists client_embeddings_embedding_idx
  on public.client_embeddings
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Plain B-tree index so WHERE client_id = ? is fast
create index if not exists client_embeddings_client_id_idx
  on public.client_embeddings (client_id);

-- 4. Row Level Security
alter table public.client_embeddings enable row level security;

-- Service-role key bypasses RLS automatically; no policy needed for
-- server-side access. Add read policies here if you expose this via anon key.

-- 5. match_embeddings RPC
--    Returns the top `match_count` chunks for a given client ordered by
--    cosine similarity (highest = most relevant).
create or replace function public.match_embeddings(
  query_embedding   vector(384),
  match_client_id   text,
  match_count       int default 5
)
returns table (
  id          uuid,
  heading     text,
  content     text,
  similarity  float
)
language sql stable
as $$
  select
    id,
    heading,
    content,
    1 - (embedding <=> query_embedding) as similarity
  from public.client_embeddings
  where client_id = match_client_id
  order by embedding <=> query_embedding
  limit match_count;
$$;
