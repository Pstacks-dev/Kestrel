-- Durable post-CI managed deployment queue. One event per successful pipeline run.
create table if not exists public.managed_hosting_automation_queue (
  id uuid primary key default gen_random_uuid(),
  pipeline_run_id uuid not null unique references public.pipeline_runs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  branch text not null,
  commit_sha text not null,
  status text not null default 'queued'
    check (status in ('queued','running','succeeded','failed','skipped')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_managed_hosting_automation_ready
  on public.managed_hosting_automation_queue(status, available_at, created_at)
  where status in ('queued','failed');

create index if not exists idx_managed_hosting_automation_project
  on public.managed_hosting_automation_queue(project_id, status, created_at desc);

alter table public.managed_hosting_automation_queue enable row level security;
revoke all on public.managed_hosting_automation_queue from anon, authenticated;
grant all on public.managed_hosting_automation_queue to service_role;
