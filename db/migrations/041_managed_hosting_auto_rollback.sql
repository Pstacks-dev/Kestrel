-- Durable, at-most-once automatic rollback requests for deployments that fail
-- confirmed provider health probes. Ambiguous provider outcomes require manual review.
create table if not exists public.managed_hosting_rollback_queue (
  id uuid primary key default gen_random_uuid(),
  deployment_id uuid not null references public.managed_hosting_deployments(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued','running','succeeded','failed','skipped')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 1),
  locked_at timestamptz,
  rollback_deployment_id uuid references public.managed_hosting_deployments(id) on delete set null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (deployment_id)
);

create index if not exists idx_managed_hosting_rollback_claimable
  on public.managed_hosting_rollback_queue(status, created_at)
  where status in ('queued','running');

comment on table public.managed_hosting_rollback_queue is
  'At-most-once automatic rollback work for deployments confirmed unhealthy by readiness probes.';

alter table public.managed_hosting_rollback_queue enable row level security;
revoke all on public.managed_hosting_rollback_queue from anon, authenticated;
grant all on public.managed_hosting_rollback_queue to service_role;
