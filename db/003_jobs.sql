-- Ingest job ledger — enables resume + graceful abort across multi-day runs.
create table if not exists ingest_jobs (
  id          uuid primary key default gen_random_uuid(),
  source_path text unique not null,          -- absolute path on the source drive
  kind        text,                          -- movie | episode
  action      text,                          -- copy | remux | transcode-audio | ...
  status      text not null default 'pending', -- pending|processing|done|failed
  target_key  text,
  media_id    uuid references media(id) on delete set null,
  error       text,
  attempts    int not null default 0,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists idx_ingest_jobs_status on ingest_jobs (status);

-- Make media idempotent by S3 key, so re-running a job never duplicates a row.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'media_s3_key_unique') then
    alter table media add constraint media_s3_key_unique unique (s3_key);
  end if;
end $$;
