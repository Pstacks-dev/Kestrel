-- Retry scheduling with bounded exponential backoff.
alter table public.jobs
  add column if not exists available_at timestamptz not null default now();

create index if not exists idx_jobs_ready_queue
  on public.jobs(status, available_at, created_at)
  where status = 'queued';
