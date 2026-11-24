-- GitHub App installations are linked to a Kestrel workspace, never to an individual user.
create table if not exists public.github_app_installations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  installation_id bigint not null unique,
  account_login text not null,
  account_type text not null check (account_type in ('User','Organization')),
  installed_by uuid references auth.users(id) on delete set null,
  suspended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, installation_id)
);
create index if not exists github_app_installations_org on public.github_app_installations(organization_id);
alter table public.projects add column if not exists github_installation_id bigint;
create index if not exists projects_github_installation on public.projects(github_installation_id) where github_installation_id is not null;
alter table public.github_app_installations enable row level security;
drop policy if exists "workspace members read GitHub App installations" on public.github_app_installations;
create policy "workspace members read GitHub App installations" on public.github_app_installations
  for select using (exists (
    select 1 from public.organization_members m
    where m.organization_id = github_app_installations.organization_id and m.user_id = auth.uid()
  ));
