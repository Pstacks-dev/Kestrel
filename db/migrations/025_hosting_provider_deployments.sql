-- Hosting-provider deployment tracking. Provider payloads are intentionally not persisted in full.
create table if not exists public.hosting_provider_deployments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  connection_id uuid not null references public.hosting_provider_connections(id) on delete cascade,
  pipeline_run_id uuid not null references public.pipeline_runs(id) on delete cascade,
  provider_id text not null,
  provider_resource_id text,
  project_slug text not null,
  requested_hostname text,
  live_url text,
  status text not null default 'provisioning' check (status in ('provisioning','building','deploying','live','failed','cancelled','unknown')),
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(connection_id, pipeline_run_id)
);
create index if not exists hosting_provider_deployments_project_idx on public.hosting_provider_deployments(project_id, created_at desc);
create index if not exists hosting_provider_deployments_org_idx on public.hosting_provider_deployments(organization_id, created_at desc);
alter table public.hosting_provider_deployments enable row level security;
revoke all on public.hosting_provider_deployments from anon, authenticated;
grant all on public.hosting_provider_deployments to service_role;
