-- Persist an optional per-project Docker build context for multi-service repositories.
alter table public.projects
  add column if not exists oci_build_context text;

alter table public.managed_hosting_image_builds
  add column if not exists build_context text;
