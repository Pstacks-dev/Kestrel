-- Provider-backed application resources and deployment history.
-- External providers own the runtime and public URL; Kestrel stores only resource identifiers and status metadata.

create table if not exists public.managed_hosting_resources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  provider_id text not null check (provider_id in (
    'render','railway','flyio','google-cloud-run','aws-ecs-express',
    'digitalocean-app-platform','heroku','vercel','netlify','cloudflare-pages'
  )),
  provider_project_id text not null,
  provider_service_id text not null,
  provider_environment_id text,
  provider_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, provider_id),
  unique (provider_id, provider_service_id)
);

create table if not exists public.managed_hosting_deployments (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.managed_hosting_resources(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  provider_id text not null check (provider_id in (
    'render','railway','flyio','google-cloud-run','aws-ecs-express',
    'digitalocean-app-platform','heroku','vercel','netlify','cloudflare-pages'
  )),
  provider_deployment_id text not null,
  branch text not null,
  commit_sha text not null,
  status text not null default 'queued'
    check (status in ('queued','deploying','live','failed','rolling_back','unknown')),
  provider_url text,
  rollback_of uuid references public.managed_hosting_deployments(id) on delete set null,
  error_message text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, provider_deployment_id)
);

create index if not exists idx_managed_hosting_resources_project
  on public.managed_hosting_resources(organization_id, project_id, provider_id);
create index if not exists idx_managed_hosting_deployments_project
  on public.managed_hosting_deployments(organization_id, project_id, created_at desc);
create index if not exists idx_managed_hosting_deployments_resource
  on public.managed_hosting_deployments(resource_id, created_at desc);

alter table public.managed_hosting_resources enable row level security;
alter table public.managed_hosting_deployments enable row level security;
revoke all on public.managed_hosting_resources, public.managed_hosting_deployments from anon, authenticated;
grant all on public.managed_hosting_resources, public.managed_hosting_deployments to service_role;
