-- Kestrel Compute: multi-tenant VM inventory, provider nodes, quotas and durable operations.
-- Provider credentials remain on the trusted host agent; only one-way token hashes live here.

create table if not exists public.compute_nodes (
  id text primary key,
  provider text not null check (provider in ('incus', 'firecracker', 'kubevirt')),
  hostname text not null,
  region text not null default 'unknown',
  architecture text not null default 'linux/amd64',
  state text not null default 'offline' check (state in ('online', 'offline', 'draining')),
  desired_state text not null default 'online' check (desired_state in ('online', 'offline', 'draining')),
  total_vcpu integer not null check (total_vcpu between 1 and 4096),
  total_memory_mib bigint not null check (total_memory_mib between 512 and 4194304),
  total_disk_gib bigint not null check (total_disk_gib between 5 and 1048576),
  allocated_vcpu integer not null default 0 check (allocated_vcpu >= 0),
  allocated_memory_mib bigint not null default 0 check (allocated_memory_mib >= 0),
  allocated_disk_gib bigint not null default 0 check (allocated_disk_gib >= 0),
  max_instances integer not null default 100 check (max_instances between 1 and 10000),
  last_seen_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (allocated_vcpu <= total_vcpu),
  check (allocated_memory_mib <= total_memory_mib),
  check (allocated_disk_gib <= total_disk_gib)
);

create table if not exists public.compute_node_credentials (
  node_id text primary key references public.compute_nodes(id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz
);

create table if not exists public.compute_quotas (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  max_instances integer not null default 3 check (max_instances between 0 and 10000),
  max_vcpu integer not null default 8 check (max_vcpu between 0 and 4096),
  max_memory_mib bigint not null default 16384 check (max_memory_mib between 0 and 4194304),
  max_disk_gib bigint not null default 200 check (max_disk_gib between 0 and 1048576),
  updated_at timestamptz not null default now()
);

create table if not exists public.compute_instances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  node_id text not null references public.compute_nodes(id) on delete restrict,
  provider_id text,
  provider text not null check (provider in ('incus', 'firecracker', 'kubevirt')),
  name text not null check (length(name) between 1 and 63),
  image text not null,
  region text,
  vcpus integer not null check (vcpus between 1 and 64),
  memory_mib integer not null check (memory_mib between 512 and 262144),
  disk_gib integer not null check (disk_gib between 5 and 4096),
  status text not null default 'provisioning'
    check (status in ('provisioning', 'starting', 'running', 'stopping', 'stopped', 'deleting', 'deleted', 'failed')),
  ipv4 text[] not null default '{}',
  ssh_public_key text,
  error_message text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(node_id, name)
);

create table if not exists public.compute_operations (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.compute_instances(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  node_id text not null references public.compute_nodes(id) on delete restrict,
  action text not null check (action in ('create', 'start', 'stop', 'delete', 'snapshot_create', 'snapshot_restore', 'snapshot_delete')),
  status text not null default 'queued' check (status in ('queued', 'claimed', 'succeeded', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  lease_token text,
  lease_expires_at timestamptz,
  available_at timestamptz not null default now(),
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists public.compute_snapshots (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.compute_instances(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_snapshot_id text,
  name text not null check (length(name) between 1 and 63),
  status text not null default 'creating'
    check (status in ('creating', 'ready', 'restoring', 'deleting', 'failed', 'deleted')),
  error_message text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(instance_id, name)
);

alter table public.compute_operations
  add column if not exists snapshot_id uuid references public.compute_snapshots(id) on delete cascade;

create index if not exists idx_compute_nodes_schedule
  on public.compute_nodes(provider, state, region, allocated_vcpu, allocated_memory_mib);
create index if not exists idx_compute_instances_org
  on public.compute_instances(organization_id, created_at desc) where deleted_at is null;
create index if not exists idx_compute_operations_queue
  on public.compute_operations(node_id, available_at, created_at) where status = 'queued';
create index if not exists idx_compute_operations_lease
  on public.compute_operations(lease_expires_at) where status = 'claimed';
create index if not exists idx_compute_snapshots_instance
  on public.compute_snapshots(instance_id, created_at desc) where deleted_at is null;

alter table public.compute_instances enable row level security;
alter table public.compute_operations enable row level security;
alter table public.compute_quotas enable row level security;
alter table public.compute_snapshots enable row level security;
alter table public.compute_nodes enable row level security;
alter table public.compute_node_credentials enable row level security;

drop policy if exists "members read compute instances" on public.compute_instances;
create policy "members read compute instances" on public.compute_instances
  for select using (public.is_org_member(organization_id));

drop policy if exists "members read compute operations" on public.compute_operations;
create policy "members read compute operations" on public.compute_operations
  for select using (public.is_org_member(organization_id));

drop policy if exists "members read compute quotas" on public.compute_quotas;
create policy "members read compute quotas" on public.compute_quotas
  for select using (public.is_org_member(organization_id));

drop policy if exists "members read compute snapshots" on public.compute_snapshots;
create policy "members read compute snapshots" on public.compute_snapshots
  for select using (public.is_org_member(organization_id));

-- Compute node inventory and credentials are server/agent-only; no browser policies.
revoke all on public.compute_nodes, public.compute_node_credentials from anon, authenticated;
revoke all on public.compute_instances, public.compute_operations, public.compute_quotas, public.compute_snapshots from anon, authenticated;
grant select on public.compute_instances, public.compute_operations, public.compute_quotas, public.compute_snapshots to authenticated;
grant all on public.compute_nodes, public.compute_node_credentials, public.compute_instances,
  public.compute_operations, public.compute_quotas, public.compute_snapshots to service_role;
