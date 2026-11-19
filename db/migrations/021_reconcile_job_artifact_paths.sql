-- Pipeline queue API inserts artifact paths for every job. Reconcile this
-- column on environments where the earlier artifact-path migration was missed.
alter table public.jobs
  add column if not exists artifact_paths text[] not null default '{}';
