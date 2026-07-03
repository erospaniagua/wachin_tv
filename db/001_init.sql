-- wachin.tv schema — auth. Safe to run repeatedly (idempotent).

create extension if not exists pgcrypto; -- for gen_random_uuid()

-- Admin-provisioned users. There is no self-signup: a row only exists here
-- because an admin created it. Magic-link login checks against this table, so
-- only these emails can ever get in.
create table if not exists users (
  id         uuid        primary key default gen_random_uuid(),
  email      text        unique not null,
  name       text        not null,
  role       text        not null default 'user', -- 'user' | 'admin'
  created_at timestamptz not null default now()
);

-- One-time magic-link tokens. We store only a SHA-256 hash of the token; the
-- raw token lives only in the emailed URL. Short-lived and single-use.
create table if not exists magic_tokens (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references users(id) on delete cascade,
  token_hash text        not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_magic_tokens_hash on magic_tokens (token_hash);

-- Login sessions. The cookie holds the raw session token; the DB stores only
-- its SHA-256 hash, so a DB leak alone can't hijack a session.
create table if not exists sessions (
  token_hash text        primary key,
  user_id    uuid        not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_sessions_user on sessions (user_id);