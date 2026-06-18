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

-- Cross-device conversation list. Powers GET /api/conversations so a chat started
-- on one device is discoverable on another (true bidirectional history, not just a
-- per-conversation backup). Derived entirely from `messages`, so there's nothing
-- extra to write: title = the conversation's first user turn; updated_at = its most
-- recent turn. Re-run this file after updating the app to create/refresh the view.
create or replace view public.conversation_summaries as
select
  conversation_id,
  count(*)::int                                          as message_count,
  min(created_at)                                        as created_at,
  max(created_at)                                        as updated_at,
  (array_agg(content order by created_at)
     filter (where role = 'user'))[1]                    as title
from public.messages
group by conversation_id;

-- The API reads the view with the service-role key; grant it explicitly so the
-- view works regardless of the project's default view grants.
grant select on public.conversation_summaries to service_role;

-- ---------------------------------------------------------------------------
-- Conversation improvement pipeline — added for daily brain enrichment loop.
-- ---------------------------------------------------------------------------

-- User thumbs-up / thumbs-down on assistant responses. Powers quality signals
-- for the nightly enrichment automation to know which answers were helpful.
create table if not exists public.message_feedback (
  id              uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  message_id      text not null,
  rating          smallint not null check (rating in (-1, 1)),
  created_at      timestamptz not null default now()
);

create index if not exists message_feedback_conv_idx
  on public.message_feedback (conversation_id);

-- Unique on message_id so a user can change their rating (upsert-replace semantics).
create unique index if not exists message_feedback_message_id_key
  on public.message_feedback (message_id);

alter table public.message_feedback enable row level security;
