-- Migration 002: Production Hardening, Performance Indexes, Secrets, Webhooks, and Lease Recovery

-- 1. Alterations to existing tables for execution control & resilience
alter table public.jobs
  add column if not exists timeout_seconds integer not null default 1800 check (timeout_seconds between 10 and 86400),
  add column if not exists max_retries integer not null default 2 check (max_retries between 0 and 10),
  add column if not exists canceled_at timestamptz;

alter table public.pipeline_runs
  add column if not exists canceled_at timestamptz,
  add column if not exists canceled_by uuid references auth.users(id);

alter table public.artifacts
  add column if not exists content_type text not null default 'application/octet-stream',
  add column if not exists download_count integer not null default 0;

-- 2. Performance indexes
create index if not exists idx_jobs_running_lease on public.jobs(status, lease_expires_at) where status = 'running';
create index if not exists idx_jobs_run_status on public.jobs(run_id, status);
create index if not exists idx_jobs_worker on public.jobs(worker_id) where status = 'running';
create index if not exists idx_pipeline_runs_status on public.pipeline_runs(status);
create index if not exists idx_pipeline_runs_project_number on public.pipeline_runs(project_id, run_number desc);
create index if not exists idx_audit_org_time on public.audit_events(organization_id, created_at desc);
create index if not exists idx_job_logs_created on public.job_logs(job_id, created_at asc);
create index if not exists idx_workers_org_state on public.workers(organization_id, state);

-- 3. Project Secrets table (AES-256-GCM encrypted values)
create table if not exists public.project_secrets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (length(name) between 1 and 128 and name ~ '^[A-Za-z0-9_]+$'),
  encrypted_value text not null,
  iv text not null,
  auth_tag text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);

create index if not exists idx_project_secrets_proj on public.project_secrets(project_id);

-- 4. GitHub Webhooks table
create table if not exists public.github_webhooks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  webhook_secret text not null,
  events text[] not null default '{"push","pull_request"}',
  active boolean not null default true,
  last_triggered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id)
);

create index if not exists idx_github_webhooks_proj on public.github_webhooks(project_id);

-- 5. Stored function for atomic lease recovery
create or replace function public.recover_stale_leases()
returns table(recovered_jobs_count integer, offline_workers_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recovered_jobs integer := 0;
  v_offline_workers integer := 0;
begin
  -- Re-queue or fail jobs with expired leases
  with expired as (
    update public.jobs
    set
      status = case when attempt >= max_retries + 1 then 'failed' else 'queued' end,
      worker_id = null,
      lease_token = null,
      lease_expires_at = null,
      finished_at = case when attempt >= max_retries + 1 then now() else null end,
      exit_code = case when attempt >= max_retries + 1 then 137 else null end
    where status = 'running' and lease_expires_at < now()
    returning id, run_id, status
  )
  select count(*) into v_recovered_jobs from expired;

  -- Mark offline workers that missed heartbeats
  with offline_wrks as (
    update public.workers
    set state = 'offline'
    where last_seen_at < now() - interval '45 seconds'
      and state not in ('offline', 'draining')
    returning id
  )
  select count(*) into v_offline_workers from offline_wrks;

  -- Update affected pipeline runs
  update public.pipeline_runs r
  set
    status = case
      when exists(select 1 from public.jobs j where j.run_id = r.id and j.status = 'failed') then 'failed'
      when exists(select 1 from public.jobs j where j.run_id = r.id and j.status = 'canceled') and not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then 'canceled'
      when exists(select 1 from public.jobs j where j.run_id = r.id and j.status = 'running') then 'running'
      when not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then 'succeeded'
      else 'queued'
    end,
    finished_at = case
      when not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then now()
      else null
    end
  where r.status in ('queued', 'running');

  return query select v_recovered_jobs, v_offline_workers;
end;
$$;

-- 6. RLS Policies
alter table public.project_secrets enable row level security;
alter table public.github_webhooks enable row level security;

-- Members can see secret names (not the decrypted values)
create policy "members read secret names" on public.project_secrets
  for select using (
    exists(
      select 1 from public.projects p
      where p.id = project_id and public.is_org_member(p.organization_id)
    )
  );

-- Developers and admins can manage project secrets
create policy "developers manage secrets" on public.project_secrets
  for all using (
    exists(
      select 1 from public.projects p
      join public.organization_members m on m.organization_id = p.organization_id
      where p.id = project_id and m.user_id = auth.uid() and m.role in ('owner','admin','developer')
    )
  )
  with check (
    exists(
      select 1 from public.projects p
      join public.organization_members m on m.organization_id = p.organization_id
      where p.id = project_id and m.user_id = auth.uid() and m.role in ('owner','admin','developer')
    )
  );

-- Developers and admins can manage webhooks
create policy "developers manage webhooks" on public.github_webhooks
  for all using (
    exists(
      select 1 from public.projects p
      join public.organization_members m on m.organization_id = p.organization_id
      where p.id = project_id and m.user_id = auth.uid() and m.role in ('owner','admin','developer')
    )
  )
  with check (
    exists(
      select 1 from public.projects p
      join public.organization_members m on m.organization_id = p.organization_id
      where p.id = project_id and m.user_id = auth.uid() and m.role in ('owner','admin','developer')
    )
  );
