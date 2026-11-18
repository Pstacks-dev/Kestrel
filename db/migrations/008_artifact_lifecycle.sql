-- Artifact lifecycle: optional expiration, auditable deletion and efficient cleanup.
alter table public.artifacts
  add column if not exists expires_at timestamptz,
  add column if not exists deleted_at timestamptz;

create index if not exists idx_artifacts_expiration
  on public.artifacts(expires_at)
  where expires_at is not null and deleted_at is null;

create index if not exists idx_artifacts_run_created
  on public.artifacts(run_id, created_at desc);
