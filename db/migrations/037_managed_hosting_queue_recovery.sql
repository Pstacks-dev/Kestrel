-- Keep managed-hosting queue claim indexes aligned with the complete worker state machine.
-- waiting_for_image jobs must be polled, and expired running leases must be reclaimable.
alter table public.managed_hosting_automation_queue
  drop constraint if exists managed_hosting_automation_queue_status_check;

alter table public.managed_hosting_automation_queue
  add constraint managed_hosting_automation_queue_status_check
  check (status in ('queued','running','waiting_for_image','succeeded','failed','skipped'));

create index if not exists idx_managed_hosting_automation_claimable
  on public.managed_hosting_automation_queue(status, available_at, locked_at, created_at)
  where status in ('queued','failed','waiting_for_image','running');
