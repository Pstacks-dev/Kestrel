-- Lease readiness reconciliation work so concurrent cron invocations cannot probe the same deployment.
alter table public.managed_hosting_deployments
  add column if not exists health_claimed_at timestamptz;

create index if not exists idx_managed_hosting_deployments_readiness_claim
  on public.managed_hosting_deployments(health_claimed_at)
  where health_status in ('pending','checking');
