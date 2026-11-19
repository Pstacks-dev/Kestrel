-- Reconcile the production queue/worker schema with the current control-plane API.
-- Safe to apply repeatedly to databases that already have some of these fields.

alter table public.workers
  add column if not exists desired_state text not null default 'online',
  add column if not exists runtime text not null default 'node',
  add column if not exists public_address text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='workers_desired_state_check' and conrelid='public.workers'::regclass) then
    alter table public.workers add constraint workers_desired_state_check check (desired_state in ('online','offline','draining'));
  end if;
  if not exists (select 1 from pg_constraint where conname='workers_runtime_check' and conrelid='public.workers'::regclass) then
    alter table public.workers add constraint workers_runtime_check check (runtime in ('node','rust'));
  end if;
end $$;

alter table public.jobs
  add column if not exists available_at timestamptz not null default now(),
  add column if not exists job_type text not null default 'build',
  add column if not exists deployment_environment_id uuid,
  add column if not exists deployment_release_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='jobs_job_type_check' and conrelid='public.jobs'::regclass) then
    alter table public.jobs add constraint jobs_job_type_check check (job_type in ('build','deployment'));
  end if;
end $$;

create table if not exists public.deployment_environments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  environment_key text not null check (environment_key in ('development','staging','production','preview')),
  worker_id text not null references public.workers(id) on delete restrict,
  host_port integer not null check (host_port between 1024 and 65535),
  container_port integer not null default 3000 check (container_port between 1 and 65535),
  health_path text not null default '/',
  health_timeout_seconds integer not null default 60 check (health_timeout_seconds between 5 and 300),
  public_url text,
  secret_names text[] not null default '{}',
  current_release_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id,environment_key),
  unique(worker_id,host_port)
);

create table if not exists public.deployment_releases (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references public.deployment_environments(id) on delete cascade,
  release_number bigint not null,
  image text not null,
  container_name text not null unique,
  status text not null default 'queued' check (status in ('queued','deploying','healthy','failed')),
  previous_release_id uuid references public.deployment_releases(id) on delete set null,
  rollback_of uuid references public.deployment_releases(id) on delete set null,
  pipeline_run_id uuid references public.pipeline_runs(id) on delete set null,
  worker_id text references public.workers(id) on delete set null,
  health_checked_at timestamptz,
  error_message text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  deployed_at timestamptz,
  unique(environment_id,release_number)
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname='deployment_environments_current_release_fk' and conrelid='public.deployment_environments'::regclass) then
    alter table public.deployment_environments add constraint deployment_environments_current_release_fk foreign key (current_release_id) references public.deployment_releases(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname='jobs_deployment_environment_fk' and conrelid='public.jobs'::regclass) then
    alter table public.jobs add constraint jobs_deployment_environment_fk foreign key (deployment_environment_id) references public.deployment_environments(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname='jobs_deployment_release_fk' and conrelid='public.jobs'::regclass) then
    alter table public.jobs add constraint jobs_deployment_release_fk foreign key (deployment_release_id) references public.deployment_releases(id) on delete cascade;
  end if;
end $$;

create index if not exists idx_jobs_available_queue on public.jobs(status,available_at,created_at) where status='queued';
create index if not exists idx_deployment_env_project on public.deployment_environments(project_id);
create index if not exists idx_deployment_release_history on public.deployment_releases(environment_id,release_number desc);
create index if not exists idx_jobs_deployment_queue on public.jobs(job_type,status,created_at) where job_type='deployment';

alter table public.deployment_environments enable row level security;
alter table public.deployment_releases enable row level security;
drop policy if exists "members read deployment environments" on public.deployment_environments;
create policy "members read deployment environments" on public.deployment_environments
  for select using (exists (select 1 from public.projects p where p.id=project_id and public.is_org_member(p.organization_id)));
drop policy if exists "members read deployment releases" on public.deployment_releases;
create policy "members read deployment releases" on public.deployment_releases
  for select using (exists (select 1 from public.deployment_environments e join public.projects p on p.id=e.project_id where e.id=environment_id and public.is_org_member(p.organization_id)));
