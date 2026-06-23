-- ============================================================================
-- DTC PAID ADS — CEO OPERATING SYSTEM  |  Supabase schema (single-user)
-- Run this once in Supabase  →  SQL Editor  →  New query  →  paste  →  Run.
-- It creates one table per data collection, plus a settings table, and locks
-- every row to the logged-in owner so only your account can read/write.
-- ============================================================================

-- One table per collection. Each row stores its full record as JSONB ("data")
-- so the app's many optional fields just work, plus an "owner" for security
-- and timestamps for ordering. id is the app-generated string id.

create table if not exists public.records (
  id          text not null,
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  collection  text not null,                       -- 'tasks','clients','leads', etc.
  data        jsonb not null default '{}'::jsonb,   -- the full record
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (owner, collection, id)
);

create index if not exists records_owner_collection_idx
  on public.records (owner, collection, updated_at desc);

-- Single settings blob per user.
create table if not exists public.app_settings (
  owner       uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security: a user can only ever see or change their own rows.
-- ---------------------------------------------------------------------------
alter table public.records       enable row level security;
alter table public.app_settings  enable row level security;

drop policy if exists "own records" on public.records;
create policy "own records" on public.records
  for all
  using  (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists "own settings" on public.app_settings;
create policy "own settings" on public.app_settings
  for all
  using  (owner = auth.uid())
  with check (owner = auth.uid());
