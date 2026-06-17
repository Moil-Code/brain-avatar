-- Brain Avatar — chat history schema.
-- Run this in the Supabase SQL editor (or `supabase db` / psql) once.

create extension if not exists pgcrypto;

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  role            text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content         text not null,
  -- Stable per-message id supplied by the client (the UI message id). Lets the API
  -- dedup retries / re-syncs so a turn is never written twice. Optional for back-
  -- compat: legacy rows keep NULL (a unique index permits multiple NULLs in Postgres).
  message_id      text,
  created_at      timestamptz not null default now()
);

-- Migration for existing deployments (no-ops if already present): run this whole
-- file again in the Supabase SQL editor after updating the app.
alter table public.messages add column if not exists message_id text;

create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at);

-- The dedup key the POST upsert conflicts on. Must exist before the new client's
-- writes (which always carry a message_id) land.
create unique index if not exists messages_message_id_key
  on public.messages (message_id);

-- Lock the table down: the Vercel API uses the service-role key (which bypasses
-- RLS). Enabling RLS with no public policies means the anon/public key cannot
-- read or write this table directly.
alter table public.messages enable row level security;
