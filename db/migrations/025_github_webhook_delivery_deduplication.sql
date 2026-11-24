-- Idempotent GitHub webhook deliveries. A provider retry must never enqueue a second pipeline run.
create table if not exists public.github_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  delivery_id text not null unique check (length(delivery_id) between 1 and 128),
  event_name text not null check (event_name in ('push','pull_request')),
  branch text not null,
  commit_sha text,
  run_id uuid references public.pipeline_runs(id) on delete set null,
  received_at timestamptz not null default now()
);

create index if not exists idx_github_webhook_deliveries_project_time
  on public.github_webhook_deliveries(project_id, received_at desc);

alter table public.github_webhook_deliveries enable row level security;
revoke all on public.github_webhook_deliveries from anon, authenticated;
grant all on public.github_webhook_deliveries to service_role;
