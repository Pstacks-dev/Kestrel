-- Per-project automatic container image build settings.
create table if not exists public.container_build_settings (
  project_id uuid primary key references public.projects(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  auto_build_enabled boolean not null default false,
  registry_host text not null check (registry_host in ('ghcr.io','docker.io')),
  image_repository text not null,
  dockerfile_path text not null default 'Dockerfile',
  context_path text not null default '.',
  username_secret text not null default 'REGISTRY_USERNAME',
  password_secret text not null default 'REGISTRY_PASSWORD',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.container_builds add column if not exists auto_triggered boolean not null default false;
create unique index if not exists container_builds_auto_run_unique on public.container_builds(source_pipeline_run_id) where auto_triggered;
create index if not exists container_build_settings_org_idx on public.container_build_settings(organization_id);
alter table public.container_build_settings enable row level security;
revoke all on public.container_build_settings from anon, authenticated;
grant all on public.container_build_settings to service_role;
drop policy if exists "members read container build settings" on public.container_build_settings;
create policy "members read container build settings" on public.container_build_settings
  for select using (public.is_org_member(organization_id));
