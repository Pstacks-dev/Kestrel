-- Durable queue for automatic provider deployments after successful default-branch CI.
create table if not exists public.managed_hosting_deployment_queue (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null unique references public.pipeline_runs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued','processing','succeeded','failed','skipped')),
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 10),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  deployment_id uuid references public.managed_hosting_deployments(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_managed_hosting_queue_ready
  on public.managed_hosting_deployment_queue(status, next_attempt_at, created_at)
  where status in ('queued','failed');

alter table public.managed_hosting_deployment_queue enable row level security;
revoke all on public.managed_hosting_deployment_queue from anon, authenticated;
grant all on public.managed_hosting_deployment_queue to service_role;
