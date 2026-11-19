-- Ensure the workspace snapshot's worker and artifact queries match production schema.
-- Safe for databases where these columns already exist.

alter table public.workers
  add column if not exists runtime text not null default 'node';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workers_runtime_check'
      and conrelid = 'public.workers'::regclass
  ) then
    alter table public.workers
      add constraint workers_runtime_check
      check (runtime in ('node', 'rust'));
  end if;
end $$;

alter table public.artifacts
  add column if not exists expires_at timestamptz,
  add column if not exists deleted_at timestamptz;

create index if not exists idx_artifacts_expiration
  on public.artifacts(expires_at)
  where expires_at is not null and deleted_at is null;

create index if not exists idx_artifacts_run_created
  on public.artifacts(run_id, created_at desc);
