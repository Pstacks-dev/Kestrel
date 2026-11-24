-- Reconcile the older deployed schema with the current managed-hosting control plane.
-- Keep existing encrypted credential bytes intact while aligning column names.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='hosting_provider_connections' and column_name='encrypted_credentials')
     and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='hosting_provider_connections' and column_name='credentials_ciphertext') then
    alter table public.hosting_provider_connections rename column encrypted_credentials to credentials_ciphertext;
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='hosting_provider_connections' and column_name='display_name')
     and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='hosting_provider_connections' and column_name='account_label') then
    alter table public.hosting_provider_connections rename column display_name to account_label;
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='hosting_provider_connections' and column_name='created_by')
     and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='hosting_provider_connections' and column_name='connected_by') then
    alter table public.hosting_provider_connections rename column created_by to connected_by;
  end if;
end $$;

alter table public.hosting_provider_connections alter column account_label drop not null;
alter table public.hosting_provider_connections drop constraint if exists hosting_provider_connections_provider_id_check;
alter table public.hosting_provider_connections drop constraint if exists hosting_provider_connections_status_check;
alter table public.hosting_provider_connections drop constraint if exists hosting_provider_connections_display_name_check;

update public.hosting_provider_connections
set provider_id = case provider_id
  when 'cloud-run' then 'google-cloud-run'
  when 'digitalocean' then 'digitalocean-app-platform'
  else provider_id
end;
update public.hosting_provider_connections
set status = case status
  when 'unverified' then 'configured'
  when 'connected' then 'verified'
  when 'revoked' then 'error'
  else status
end;

alter table public.hosting_provider_connections
  add constraint hosting_provider_connections_provider_id_check
  check (provider_id in (
    'render','railway','flyio','google-cloud-run','aws-ecs-express',
    'digitalocean-app-platform','heroku','vercel','netlify','cloudflare-pages'
  ));
alter table public.hosting_provider_connections
  add constraint hosting_provider_connections_status_check
  check (status in ('configured','verified','error'));
create index if not exists idx_hosting_provider_connections_org
  on public.hosting_provider_connections(organization_id, provider_id);
alter table public.hosting_provider_connections enable row level security;
revoke all on public.hosting_provider_connections from anon, authenticated;
grant all on public.hosting_provider_connections to service_role;

-- The deployed webhook deduplication table predates branch/commit metadata and
-- used a composite primary key. The control plane requires globally unique
-- GitHub delivery IDs for ON CONFLICT(delivery_id) idempotency.
alter table public.github_webhook_deliveries
  add column if not exists branch text;
alter table public.github_webhook_deliveries
  add column if not exists commit_sha text;
update public.github_webhook_deliveries set branch = 'main' where branch is null;
alter table public.github_webhook_deliveries alter column branch set default 'main';
alter table public.github_webhook_deliveries alter column branch set not null;
create unique index if not exists github_webhook_deliveries_delivery_id_uidx
  on public.github_webhook_deliveries(delivery_id);
create index if not exists idx_github_webhook_deliveries_project_time
  on public.github_webhook_deliveries(project_id, received_at desc);
alter table public.github_webhook_deliveries enable row level security;
revoke all on public.github_webhook_deliveries from anon, authenticated;
grant all on public.github_webhook_deliveries to service_role;
