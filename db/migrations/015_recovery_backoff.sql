-- Keep retry, dependency and pipeline terminal states consistent after worker loss.
create or replace function public.recover_stale_leases()
returns table(recovered_jobs_count integer, offline_workers_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recovered_jobs integer := 0;
  v_offline_workers integer := 0;
  v_skipped_jobs integer := 0;
begin
  with expired as (
    update public.jobs
    set
      status = case when attempt >= max_retries + 1 then 'failed' else 'queued' end,
      available_at = case when attempt >= max_retries + 1 then available_at else now() + make_interval(secs => (least(300, 10 * power(2, least(attempt - 1, 5))))::int) end,
      worker_id = null,
      lease_token = null,
      lease_expires_at = null,
      finished_at = case when attempt >= max_retries + 1 then now() else null end,
      exit_code = case when attempt >= max_retries + 1 then 124 else null end
    where status = 'running' and lease_expires_at <= now()
    returning id
  )
  select count(*) into v_recovered_jobs from expired;

  with offline_wrks as (
    update public.workers
    set state = 'offline'
    where last_seen_at < now() - interval '45 seconds'
      and state not in ('offline', 'draining')
    returning id
  )
  select count(*) into v_offline_workers from offline_wrks;

  -- Resolve transitive dependencies after a job exhausts its retries or is canceled.
  loop
    update public.jobs j
    set status = 'skipped', finished_at = now(), exit_code = 125
    where j.status = 'queued'
      and exists (
        select 1 from public.jobs d
        where d.run_id = j.run_id
          and d.external_id = any(j.needs)
          and d.status in ('failed', 'canceled', 'skipped')
      );
    get diagnostics v_skipped_jobs = row_count;
    exit when v_skipped_jobs = 0;
  end loop;

  update public.deployment_releases dr
  set status = 'failed', health_checked_at = now(),
      error_message = 'Deployment worker lease expired after retries'
  where dr.status = 'deploying'
    and exists (
      select 1 from public.jobs j
      where j.deployment_release_id = dr.id and j.status = 'failed'
    );

  update public.pipeline_runs r
  set
    status = case
      when exists(select 1 from public.jobs j where j.run_id = r.id and j.status = 'failed')
           and not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then 'failed'
      when exists(select 1 from public.jobs j where j.run_id = r.id and j.status = 'canceled')
           and not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then 'canceled'
      when not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then 'succeeded'
      when exists(select 1 from public.jobs j where j.run_id = r.id and j.status = 'running') then 'running'
      else 'queued'
    end,
    finished_at = case
      when not exists(select 1 from public.jobs j where j.run_id = r.id and j.status in ('queued','running')) then now()
      else null
    end
  where r.status in ('queued', 'running')
    and exists (select 1 from public.jobs j where j.run_id = r.id);

  return query select v_recovered_jobs, v_offline_workers;
end;
$;

revoke all on function public.recover_stale_leases() from public, anon, authenticated;
grant execute on function public.recover_stale_leases() to service_role;
