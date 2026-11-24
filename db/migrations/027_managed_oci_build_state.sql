-- Persist detached OCI build sessions so cron/worker invocations can poll without blocking.
alter table public.managed_hosting_automation_queue
  drop constraint if exists managed_hosting_automation_queue_status_check;

alter table public.managed_hosting_automation_queue
  add constraint managed_hosting_automation_queue_status_check
  check (status in ('queued','building','running','succeeded','failed','skipped'));

alter table public.managed_hosting_automation_queue
  add column if not exists selected_provider_id text,
  add column if not exists build_sandbox_name text,
  add column if not exists build_session_id text,
  add column if not exists build_command_id text,
  add column if not exists container_image text;

drop index if exists idx_managed_hosting_automation_ready;
create index idx_managed_hosting_automation_ready
  on public.managed_hosting_automation_queue(status, available_at, created_at)
  where status in ('queued','building','failed');
