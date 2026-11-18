-- Deduplicate GitHub webhook deliveries and make webhook processing auditable.
create table if not exists public.github_webhook_deliveries (
  project_id uuid not null references public.projects(id) on delete cascade,
  delivery_id varchar(128) not null,
  event_name varchar(64) not null,
  run_id uuid null references public.pipeline_runs(id) on delete set null,
  received_at timestamptz not null default now(),
  processed_at timestamptz null,
  primary key (project_id, delivery_id)
);

create index if not exists github_webhook_deliveries_received_at_idx
  on public.github_webhook_deliveries (received_at desc);

alter table public.github_webhook_deliveries enable row level security;
revoke all on table public.github_webhook_deliveries from anon, authenticated;
