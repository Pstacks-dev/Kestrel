-- Mark deployments failed when their worker lease exhausts its retry budget.
update public.deployment_releases r
set status = 'failed',
    health_checked_at = now(),
    error_message = 'Deployment worker lease expired after the configured retries'
where r.status = 'deploying'
  and exists (
    select 1 from public.jobs j
    where j.deployment_release_id = r.id and j.status = 'failed'
  );
