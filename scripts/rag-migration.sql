-- ============================================================
-- Zempotis Chat — Supabase Migration
-- Run this once in the Supabase SQL editor.
-- ============================================================

-- 1. Enable the pgvector extension
create extension if not exists vector with schema extensions;

-- 2. Client embeddings table
create table if not exists public.client_embeddings (
  id          uuid primary key default gen_random_uuid(),
  client_id   text        not null,
  heading     text        not null default '',
  content     text        not null,
  embedding   vector(384) not null,
  created_at  timestamptz not null default now()
);

-- HNSW index for fast cosine similarity search
create index if not exists client_embeddings_embedding_idx
  on public.client_embeddings
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists client_embeddings_client_id_idx
  on public.client_embeddings (client_id);

alter table public.client_embeddings enable row level security;

-- 3. match_embeddings RPC
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

-- 4. Client configs table
--    Stores brand config for each scraped client.
--    The widget API reads from this table at runtime.
create table if not exists public.clients (
  id            uuid primary key default gen_random_uuid(),
  client_id     text        not null unique,
  name          text        not null,
  url           text,
  primary_color text        not null default '#2563eb',
  accent_color  text        not null default '#7c3aed',
  greeting      text,
  quick_replies jsonb       not null default '[]',
  content       text        not null default '',
  chunk_count   int         not null default 0,
  scraped_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists clients_client_id_idx
  on public.clients (client_id);

alter table public.clients enable row level security;
-- Service-role key bypasses RLS — no policy needed for server-side access.
