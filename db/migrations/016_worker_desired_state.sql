-- Separate administrator intent from worker liveness.
-- A stale worker may be marked offline and later recover automatically, while
-- an administrator-disabled worker remains disabled across registration/heartbeat.
alter table public.workers
  add column if not exists desired_state text not null default 'online'
  check (desired_state in ('online', 'draining', 'offline'));

update public.workers
set desired_state = case
  when state = 'draining' then 'draining'
  when state = 'offline' then 'offline'
  else 'online'
end
where desired_state = 'online';
