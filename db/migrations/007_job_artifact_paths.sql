-- Pipeline jobs can declare files to publish as build artifacts.
alter table public.jobs add column if not exists artifact_paths text[] not null default '{}';
