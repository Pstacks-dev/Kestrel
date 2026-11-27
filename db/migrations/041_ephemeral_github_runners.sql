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

-- Readiness is based on a real recent poll from the scheduled GitHub Actions
-- workflow, not merely on a configured secret or a fictional online worker.
create table if not exists public.execution_backend_heartbeats (
  backend text primary key check (backend in ('github-actions')),
  last_seen_at timestamptz not null default now(),
  last_result text not null check (last_result in ('polling','queue_empty','worker_provisioned')),
  workflow_run_id text,
  updated_at timestamptz not null default now()
);
alter table public.execution_backend_heartbeats enable row level security;
