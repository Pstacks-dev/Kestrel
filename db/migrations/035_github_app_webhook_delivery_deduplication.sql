-- Durable idempotency ledger for GitHub App installation lifecycle webhooks.
create table if not exists public.github_app_webhook_deliveries (
  delivery_id text primary key,
  event_name text not null check (event_name = 'installation'),
  action text not null check (action in ('created','deleted','suspend','unsuspend','new_permissions_accepted')),
  installation_id bigint not null check (installation_id > 0),
  received_at timestamptz not null default now()
);
create index if not exists github_app_webhook_deliveries_installation_received
  on public.github_app_webhook_deliveries(installation_id, received_at desc);
alter table public.github_app_webhook_deliveries enable row level security;
revoke all on public.github_app_webhook_deliveries from anon, authenticated;
grant all on public.github_app_webhook_deliveries to service_role;
