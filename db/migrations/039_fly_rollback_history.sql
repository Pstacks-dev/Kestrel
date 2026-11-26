-- Fly deployments are represented by Machine IDs, not immutable deployment IDs.
-- Rolling back restarts the previous Machine and therefore legitimately reuses its ID.
-- Preserve provider/deployment uniqueness for all other providers.
alter table public.managed_hosting_deployments
  drop constraint if exists managed_hosting_deployments_provider_id_provider_deployment_key;
alter table public.managed_hosting_deployments
  drop constraint if exists managed_hosting_deployments_provider_id_provider_deployment_id_key;

create unique index if not exists idx_managed_hosting_deployments_provider_deployment_unique
  on public.managed_hosting_deployments(provider_id, provider_deployment_id)
  where provider_id <> 'flyio';
