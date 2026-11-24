-- Managed OCI build queue, encrypted registry credentials and immutable image results.
create table if not exists public.managed_hosting_image_builds (
  id uuid primary key default gen_random_uuid(),
  automation_queue_id uuid not null unique references public.managed_hosting_automation_queue(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  provider_id text not null check (provider_id in ('flyio','google-cloud-run','aws-ecs-express')),
  repository_url text not null,
  branch text not null,
  commit_sha text not null check (commit_sha ~ '^[a-fA-F0-9]{40}$'),
  image text not null,
  registry text not null,
  registry_username_ciphertext text not null,
  registry_username_iv text not null,
  registry_username_auth_tag text not null,
  registry_password_ciphertext text not null,
  registry_password_iv text not null,
  registry_password_auth_tag text not null,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  worker_id text,
  lease_token text,
  lease_expires_at timestamptz,
  available_at timestamptz not null default now(),
  image_digest text,
  image_digest_ref text,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_managed_hosting_image_builds_ready
  on public.managed_hosting_image_builds(status, available_at, created_at)
  where status in ('queued','failed');

alter table public.managed_hosting_automation_queue
  add column if not exists image_build_id uuid references public.managed_hosting_image_builds(id) on delete set null;

alter table public.managed_hosting_image_builds enable row level security;
revoke all on public.managed_hosting_image_builds from anon, authenticated;
grant all on public.managed_hosting_image_builds to service_role;

-- Keep an automation event parked while its dedicated worker builds the OCI image.
alter table public.managed_hosting_automation_queue
  drop constraint if exists managed_hosting_automation_queue_status_check;
alter table public.managed_hosting_automation_queue
  add constraint managed_hosting_automation_queue_status_check
  check (status in ('queued','running','waiting_for_image','succeeded','failed','skipped'));
