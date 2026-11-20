-- Auditable lifecycle events for workspace hosting deployments.
create table if not exists public.hosting_deployment_events (
  id uuid primary key default gen_random_uuid(),
  deployment_id uuid not null references public.hosting_provider_deployments(id) on delete cascade,
  event_type text not null check (length(event_type) between 1 and 80),
  message text not null check (length(message) between 1 and 500),
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists hosting_deployment_events_timeline_idx
  on public.hosting_deployment_events(deployment_id, created_at asc);
alter table public.hosting_deployment_events enable row level security;
revoke all on public.hosting_deployment_events from anon, authenticated;
grant all on public.hosting_deployment_events to service_role;
