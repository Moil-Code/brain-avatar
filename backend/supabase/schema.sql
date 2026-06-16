-- Brain Avatar — chat history schema.
-- Run this in the Supabase SQL editor (or `supabase db` / psql) once.

create extension if not exists pgcrypto;

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  role            text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content         text not null,
  created_at      timestamptz not null default now()
);

create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at);

-- Lock the table down: the Vercel API uses the service-role key (which bypasses
-- RLS). Enabling RLS with no public policies means the anon/public key cannot
-- read or write this table directly.
alter table public.messages enable row level security;
