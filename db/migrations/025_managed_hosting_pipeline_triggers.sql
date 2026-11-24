-- Idempotent deployment triggers from successful Kestrel pipeline runs.
create table if not exists public.managed_hosting_pipeline_triggers (
  pipeline_run_id uuid primary key references public.pipeline_runs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_id text check (provider_id in (
    'render','railway','flyio','google-cloud-run','aws-ecs-express',
    'digitalocean-app-platform','heroku','vercel','netlify','cloudflare-pages'
  )),
  managed_deployment_id uuid references public.managed_hosting_deployments(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','deploying','succeeded','failed','skipped')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_managed_hosting_triggers_project_time
  on public.managed_hosting_pipeline_triggers(project_id, created_at desc);

alter table public.managed_hosting_pipeline_triggers enable row level security;
revoke all on public.managed_hosting_pipeline_triggers from anon, authenticated;
grant all on public.managed_hosting_pipeline_triggers to service_role;
