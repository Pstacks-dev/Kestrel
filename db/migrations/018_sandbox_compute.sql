-- Kestrel sandbox compute backed by managed isolated microVM sandboxes.
create table if not exists public.sandbox_quotas (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  max_sandboxes integer not null default 2 check (max_sandboxes between 0 and 100),
  max_vcpu integer not null default 4 check (max_vcpu between 0 and 128),
  max_runtime_seconds integer not null default 2700 check (max_runtime_seconds between 60 and 2700),
  updated_at timestamptz not null default now()
);

create table if not exists public.sandbox_instances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  provider text not null default 'vercel' check (provider in ('vercel')),
  provider_name text not null unique,
  provider_session_id text,
  name text not null check (length(name) between 1 and 63),
  region text not null default 'iad1',
  vcpus integer not null default 1 check (vcpus between 1 and 4),
  memory_mib integer not null default 2048 check (memory_mib between 2048 and 8192),
  timeout_seconds integer not null default 900 check (timeout_seconds between 60 and 2700),
  persistent boolean not null default true,
  status text not null default 'provisioning'
    check (status in ('provisioning','running','stopping','stopped','deleting','deleted','failed','unknown')),
  error_message text,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_sandbox_instances_org_active
  on public.sandbox_instances(organization_id, created_at desc)
  where deleted_at is null;
create index if not exists idx_sandbox_instances_provider_name
  on public.sandbox_instances(provider_name);
create unique index if not exists idx_sandbox_instances_org_active_name
  on public.sandbox_instances(organization_id, name) where deleted_at is null;

alter table public.sandbox_quotas enable row level security;
alter table public.sandbox_instances enable row level security;

drop policy if exists "members read sandbox quotas" on public.sandbox_quotas;
create policy "members read sandbox quotas" on public.sandbox_quotas
  for select using (exists (
    select 1 from public.organization_members m
    where m.organization_id = sandbox_quotas.organization_id and m.user_id = auth.uid()
  ));

drop policy if exists "members read sandbox instances" on public.sandbox_instances;
create policy "members read sandbox instances" on public.sandbox_instances
  for select using (exists (
    select 1 from public.organization_members m
    where m.organization_id = sandbox_instances.organization_id and m.user_id = auth.uid()
  ));

revoke all on public.sandbox_instances from anon, authenticated;
revoke all on public.sandbox_quotas from anon, authenticated;
grant select on public.sandbox_instances to authenticated;
grant select on public.sandbox_quotas to authenticated;
grant all on public.sandbox_instances, public.sandbox_quotas to service_role;
