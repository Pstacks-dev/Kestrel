-- Record the exact Heroku recurring-cost decision alongside each deployment.
-- The approval is immutable deployment evidence; Kestrel does not infer approval
-- from the presence of a connected Heroku API key.
alter table public.managed_hosting_deployments
  add column if not exists heroku_dyno_size text,
  add column if not exists heroku_dyno_quantity integer,
  add column if not exists estimated_monthly_cost_usd numeric(12,2),
  add column if not exists cost_approved_by uuid references auth.users(id),
  add column if not exists cost_approved_at timestamptz,
  add column if not exists pricing_catalog_version text;

alter table public.managed_hosting_deployments
  drop constraint if exists managed_hosting_deployments_heroku_cost_approval_check;

alter table public.managed_hosting_deployments
  add constraint managed_hosting_deployments_heroku_cost_approval_check
  check (
    (
      provider_id = 'heroku'
      and heroku_dyno_size in (
        'basic','standard-1x','standard-2x','performance-m',
        'performance-l','performance-l-ram','performance-xl','performance-2xl'
      )
      and heroku_dyno_quantity between 1 and 10
      and estimated_monthly_cost_usd > 0
      and cost_approved_by is not null
      and cost_approved_at is not null
      and pricing_catalog_version is not null
    )
    or
    (
      provider_id <> 'heroku'
      and heroku_dyno_size is null and heroku_dyno_quantity is null
      and estimated_monthly_cost_usd is null and cost_approved_by is null
      and cost_approved_at is null and pricing_catalog_version is null
    )
  ) not valid;

create index if not exists idx_managed_hosting_deployments_cost_approval
  on public.managed_hosting_deployments(organization_id, cost_approved_at desc)
  where provider_id = 'heroku' and cost_approved_by is not null;
