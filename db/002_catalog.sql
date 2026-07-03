-- wachin.tv schema — catalog, media, notifications. Idempotent.

-- Movies and series share this table; series additionally have episodes.
create table if not exists titles (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('movie', 'series')),
  slug       text unique not null,          -- e.g. the-matrix-1999
  name       text not null,
  year       int,
  tmdb_id    int,                           -- The Movie DB id (metadata source)
  overview   text,
  poster_key text,                          -- S3 key for the poster image
  created_at timestamptz not null default now()
);

create table if not exists episodes (
  id         uuid primary key default gen_random_uuid(),
  series_id  uuid not null references titles(id) on delete cascade,
  season     int not null,
  episode    int not null,
  name       text,
  overview   text,
  created_at timestamptz not null default now(),
  unique (series_id, season, episode)
);

-- One playable, standardized MP4. Belongs to EITHER a movie title or an
-- episode (never both, never neither).
create table if not exists media (
  id            uuid primary key default gen_random_uuid(),
  title_id      uuid references titles(id) on delete cascade,
  episode_id    uuid references episodes(id) on delete cascade,
  s3_key        text not null,              -- movies/<slug>/video.mp4
  duration_sec  int,
  width         int,
  height        int,
  audio_lang    text,                       -- chosen default audio track language
  source_format text,                       -- mp4 | mkv-remux | mkv-transcode | ...
  size_bytes    bigint,
  created_at    timestamptz not null default now(),
  constraint media_belongs_to_one
    check ((title_id is not null) <> (episode_id is not null))
);
create index if not exists idx_media_title on media (title_id);
create index if not exists idx_media_episode on media (episode_id);

-- Subtitle tracks (always WebVTT in S3), one row per language per media.
create table if not exists subtitles (
  id         uuid primary key default gen_random_uuid(),
  media_id   uuid not null references media(id) on delete cascade,
  lang       text not null,                 -- en, es, ...
  label      text,                          -- English, Español
  s3_key     text not null,                 -- .../subs/en.vtt
  created_at timestamptz not null default now(),
  unique (media_id, lang)
);

-- Notification events (downloads, requests, ...). notified_at is set once the
-- Telegram alert has been delivered, so we never double-send.
create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references users(id) on delete set null,
  type        text not null,                -- download | request | ...
  media_id    uuid references media(id) on delete set null,
  title_id    uuid references titles(id) on delete set null,
  detail      jsonb,
  notified_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_events_unnotified on events (created_at) where notified_at is null;

-- Movie/series requests, filled by users and later by the torrent agent.
create table if not exists requests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references users(id) on delete set null,
  query      text not null,                 -- what they asked for
  status     text not null default 'pending', -- pending|approved|rejected|fulfilled
  note       text,
  created_at timestamptz not null default now()
);