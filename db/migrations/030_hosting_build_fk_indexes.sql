-- Cover foreign-key lookups and cleanup paths introduced by hosting and image-build tables.
create index if not exists container_build_settings_created_by_idx
  on public.container_build_settings(created_by);
create index if not exists container_builds_build_pipeline_run_idx
  on public.container_builds(build_pipeline_run_id);
create index if not exists container_builds_created_by_idx
  on public.container_builds(created_by);
create index if not exists hosting_deployment_events_created_by_idx
  on public.hosting_deployment_events(created_by);
create index if not exists hosting_provider_connections_created_by_idx
  on public.hosting_provider_connections(created_by);
create index if not exists hosting_provider_deployments_created_by_idx
  on public.hosting_provider_deployments(created_by);
create index if not exists hosting_provider_deployments_pipeline_run_idx
  on public.hosting_provider_deployments(pipeline_run_id);
