-- GitHub-hosted runners are created on demand and retired after one build.
-- Their credentials are single-run and cannot outlive the runner lease.
alter table public.workers
  add column if not exists ephemeral boolean not null default false,
  add column if not exists expires_at timestamptz;

create index if not exists idx_workers_ephemeral_expiry
  on public.workers(expires_at)
  where ephemeral = true and expires_at is not null;

create index if not exists idx_workers_org_liveness
  on public.workers(organization_id, desired_state, state, last_seen_at);
