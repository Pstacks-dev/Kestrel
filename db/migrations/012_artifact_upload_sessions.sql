-- Short-lived, one-use upload sessions for direct private Supabase Storage uploads.
create table if not exists public.artifact_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  worker_id text not null references public.workers(id) on delete cascade,
  object_key text not null unique,
  name text not null,
  size_bytes bigint not null check (size_bytes between 1 and 104857600),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  content_type text not null default 'application/octet-stream',
  expires_at timestamptz not null default now() + interval '10 minutes',
  created_at timestamptz not null default now()
);

create index if not exists idx_artifact_upload_sessions_expiry
  on public.artifact_upload_sessions(expires_at);

alter table public.artifact_upload_sessions enable row level security;

create unique index if not exists idx_artifacts_object_key_unique on public.artifacts(object_key);
