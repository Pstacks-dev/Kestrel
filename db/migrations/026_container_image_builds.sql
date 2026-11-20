-- Build and publish immutable OCI images from validated Kestrel pipeline commits.
alter table public.jobs
  add column if not exists container_build_config jsonb,
  add column if not exists container_image_digest text;

alter table public.jobs drop constraint if exists jobs_job_type_check;
alter table public.jobs add constraint jobs_job_type_check
  check (job_type in ('build','deployment','container_build'));

create table if not exists public.container_builds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  source_pipeline_run_id uuid not null references public.pipeline_runs(id) on delete cascade,
  build_pipeline_run_id uuid not null references public.pipeline_runs(id) on delete cascade,
  job_id uuid not null unique references public.jobs(id) on delete cascade,
  registry_host text not null check (registry_host in ('ghcr.io','docker.io')),
  image_repository text not null,
  image_tag text not null,
  image_ref text,
  image_digest text,
  dockerfile_path text not null default 'Dockerfile',
  context_path text not null default '.',
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  error_message text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists container_builds_project_idx on public.container_builds(project_id,created_at desc);
create index if not exists container_builds_org_idx on public.container_builds(organization_id,created_at desc);
alter table public.container_builds enable row level security;
revoke all on public.container_builds from anon, authenticated;
grant all on public.container_builds to service_role;
drop policy if exists "members read container builds" on public.container_builds;
create policy "members read container builds" on public.container_builds
  for select using (exists (
    select 1 from public.projects p where p.id = project_id and public.is_org_member(p.organization_id)
  ));
