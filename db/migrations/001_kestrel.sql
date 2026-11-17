create extension if not exists pgcrypto;
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 120),
  slug text not null unique,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','developer','viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id,user_id)
);
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  repository_url text not null,
  default_branch text not null default 'main',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (organization_id,name)
);
create table if not exists public.pipelines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  definition jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  run_number bigint not null,
  branch text not null,
  commit_sha text,
  commit_message text,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','canceled')),
  triggered_by uuid references auth.users(id),
  triggered_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(project_id,run_number)
);
create index if not exists pipeline_runs_project_time on public.pipeline_runs(project_id,triggered_at desc);
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.pipeline_runs(id) on delete cascade,
  external_id text not null,
  name text not null,
  stage text not null,
  command text not null,
  needs text[] not null default '{}',
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','canceled','skipped')),
  worker_id text,
  lease_token text,
  lease_expires_at timestamptz,
  attempt integer not null default 0,
  exit_code integer,
  duration_ms bigint,
  memory_limit_mb integer not null default 2048,
  cpu_millicores integer not null default 1000,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique(run_id,external_id)
);
create index if not exists jobs_queue on public.jobs(status,created_at) where status='queued';
create index if not exists jobs_run on public.jobs(run_id);
create table if not exists public.job_logs (
  id bigserial primary key,
  job_id uuid not null references public.jobs(id) on delete cascade,
  stream text not null check(stream in ('stdout','stderr','system')),
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists job_logs_job_id on public.job_logs(job_id,id);
create table if not exists public.workers (
  id text primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  hostname text not null,
  region text not null default 'unknown',
  architecture text not null,
  state text not null default 'offline' check(state in ('online','busy','draining','offline')),
  max_concurrency integer not null default 1 check(max_concurrency between 1 and 128),
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.worker_credentials (
  id uuid primary key default gen_random_uuid(),
  worker_id text not null references public.workers(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.pipeline_runs(id) on delete cascade,
  name text not null,
  object_key text not null,
  size_bytes bigint not null default 0,
  sha256 text,
  created_at timestamptz not null default now()
);
create table if not exists public.audit_events (
  id bigserial primary key,
  organization_id uuid references public.organizations(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.system_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function public.is_org_member(org uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.organization_members m where m.organization_id=org and m.user_id=auth.uid());
$$;
create or replace function public.is_org_admin(org uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.organization_members m where m.organization_id=org and m.user_id=auth.uid() and m.role in ('owner','admin'));
$$;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.projects enable row level security;
alter table public.pipelines enable row level security;
alter table public.pipeline_runs enable row level security;
alter table public.jobs enable row level security;
alter table public.job_logs enable row level security;
alter table public.workers enable row level security;
alter table public.worker_credentials enable row level security;
alter table public.artifacts enable row level security;
alter table public.audit_events enable row level security;
alter table public.system_settings enable row level security;

create policy "profile self read/update" on public.profiles for all using(id=auth.uid()) with check(id=auth.uid());
create policy "members read organizations" on public.organizations for select using(public.is_org_member(id));
create policy "organization owner create" on public.organizations for insert with check(created_by=auth.uid());
create policy "members read membership" on public.organization_members for select using(public.is_org_member(organization_id));
create policy "admins manage members" on public.organization_members for all using(public.is_org_admin(organization_id)) with check(public.is_org_admin(organization_id));
create policy "members read projects" on public.projects for select using(public.is_org_member(organization_id));
create policy "developers manage projects" on public.projects for all using(exists(select 1 from public.organization_members m where m.organization_id=projects.organization_id and m.user_id=auth.uid() and m.role in ('owner','admin','developer'))) with check(exists(select 1 from public.organization_members m where m.organization_id=projects.organization_id and m.user_id=auth.uid() and m.role in ('owner','admin','developer')));
create policy "members read pipelines" on public.pipelines for select using(exists(select 1 from public.projects p where p.id=project_id and public.is_org_member(p.organization_id)));
create policy "members read runs" on public.pipeline_runs for select using(exists(select 1 from public.projects p where p.id=project_id and public.is_org_member(p.organization_id)));
create policy "members read jobs" on public.jobs for select using(exists(select 1 from public.pipeline_runs r join public.projects p on p.id=r.project_id where r.id=run_id and public.is_org_member(p.organization_id)));
create policy "members read logs" on public.job_logs for select using(exists(select 1 from public.jobs j join public.pipeline_runs r on r.id=j.run_id join public.projects p on p.id=r.project_id where j.id=job_id and public.is_org_member(p.organization_id)));
create policy "members read workers" on public.workers for select using(public.is_org_member(organization_id));
create policy "members read artifacts" on public.artifacts for select using(exists(select 1 from public.pipeline_runs r join public.projects p on p.id=r.project_id where r.id=run_id and public.is_org_member(p.organization_id)));
create policy "admins read audit" on public.audit_events for select using(organization_id is not null and public.is_org_admin(organization_id));

-- Provision the first platform administrator manually after creating their Supabase Auth user:
-- update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || '{"platform_role":"platform_admin"}'::jsonb where id = '<AUTH_USER_UUID>';
