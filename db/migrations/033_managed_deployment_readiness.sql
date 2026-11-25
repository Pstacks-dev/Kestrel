-- Track provider deployment readiness independently from provider lifecycle status.
alter table public.managed_hosting_deployments
  add column if not exists health_status text not null default 'pending',
  add column if not exists health_checked_at timestamptz,
  add column if not exists health_attempt_count integer not null default 0;

alter table public.managed_hosting_deployments
  drop constraint if exists managed_hosting_deployments_health_status_check;
alter table public.managed_hosting_deployments
  add constraint managed_hosting_deployments_health_status_check
  check (health_status in ('pending','checking','healthy','unhealthy','not_applicable'));

alter table public.managed_hosting_deployments
  drop constraint if exists managed_hosting_deployments_health_attempt_count_check;
alter table public.managed_hosting_deployments
  add constraint managed_hosting_deployments_health_attempt_count_check
  check (health_attempt_count >= 0 and health_attempt_count <= 100);

create index if not exists idx_managed_hosting_deployments_readiness
  on public.managed_hosting_deployments(status, health_status, health_checked_at)
  where status in ('queued','deploying','unknown','live');
